// Test-only publisher for the mirror suite: writes diff(base, next) to the server as one run, through the guards, as
// the writer. Not lane B's publish (Q3): no attempt bookkeeping beyond running -> ok, no outbound check, no retries.
// It only has to give the mirror tests real runs r2, r3, ... whose rows open and close like a publish would.
import * as C from '../../src/pg/contract.mjs';
import { diff, applyDelta, factKeyOf } from '../../src/pg/snapshot.mjs';

const fk = (table, f) => Buffer.from(factKeyOf(table, f), 'hex');
const js = (v) => (v === null || v === undefined ? null : JSON.stringify(v));   // jsonb: pg would send an array as text[]

/**
 * @param {import('pg').Client} c writer connection
 * @param {object} base the server state at its latest run (State with run set) @param {object} next the build to publish
 * @param {{ gha: number, checksum?: object }} o gha: a unique GitHub run id; checksum: store this instead (a bogus run)
 * @returns {Promise<{ run: number, state: object }>} state: what the server shows at run (run set)
 */
export async function writeRun(c, base, next, { gha, checksum }) {
  const delta = diff(base, next);
  const after = applyDelta(base, delta);
  const q = async (sql, params) => (await c.query(sql, params)).rows;
  const one = async (sql, params) => { const r = await q(sql, params); if (r.length !== 1) throw new Error(`expected one row: ${sql}`); return r[0]; };
  await c.query('BEGIN');
  try {
    const { attempt_id: att } = await one(`INSERT INTO brain.attempt (gha_run_id, gha_attempt, source_sha, base_run) VALUES ($1, 1, $2, $3)
      RETURNING attempt_id`, [gha, next.meta.commit, base.run]);
    const run = Number((await one(`INSERT INTO brain.run (attempt_id, commit_sha, mode, tool_version, sanitize_version, meta, checksum)
      VALUES ($1, $2, 'normal', 'mirror-test', $3, $4, $5) RETURNING run_id`,
    [att, next.meta.commit, next.meta.sanitize_version, js(delta.meta), js(checksum ?? C.checksum(after))])).run_id);
    const nodeId = async (key) => (key === null ? null : (await one('SELECT node_id FROM brain.node WHERE key = $1', [key])).node_id);
    const close = async (table, where, params) => {
      const n = (await c.query(`UPDATE brain.${table} SET valid_to = $1 WHERE valid_to IS NULL AND ${where}`, [run, ...params])).rowCount;
      if (n !== 1) throw new Error(`close ${table}: ${n} rows`);
    };
    // the revision of item ptr with this hash that is open now (put in this run or earlier)
    const revOf = async (ptr, revHash) => (await one(`SELECT r.rev_id FROM brain.item_rev r JOIN brain.item i USING (item_id)
      WHERE i.ptr = $1 AND r.hash = $2 AND r.valid_to IS NULL`, [ptr, Buffer.from(revHash, 'hex')])).rev_id;

    for (const t of ['link', 'ref_link', 'edge', 'unresolved']) for (const k of delta[t].close) await close(t, 'fact_key = $2', [Buffer.from(k, 'hex')]);
    for (const key of delta.nodes.close) await close('node_rev', 'node_id = (SELECT node_id FROM brain.node WHERE key = $2)', [key]);
    for (const ptr of delta.items.close) await close('item_rev', 'item_id = (SELECT item_id FROM brain.item WHERE ptr = $2)', [ptr]);

    const puts = [...delta.nodes.put].sort((a, b) => (a.nodeKind === 'symbol') - (b.nodeKind === 'symbol'));
    for (const n of puts) {
      if ((await q('SELECT 1 FROM brain.node WHERE key = $1', [n.key])).length) continue;
      await c.query('INSERT INTO brain.node (key, node_kind, path, file_id) VALUES ($1, $2, $3, $4)', [n.key, n.nodeKind, n.path, await nodeId(n.file)]);
    }
    for (const n of puts) {
      const id = await nodeId(n.key), r = n.rev;
      const { k } = await one('SELECT coalesce(max(rev_no), 0) + 1 AS k FROM brain.node_rev WHERE node_id = $1', [id]);
      if ((await q('SELECT 1 FROM brain.node_rev WHERE node_id = $1 AND valid_to IS NULL', [id])).length) await close('node_rev', 'node_id = $2', [id]);
      await c.query(`INSERT INTO brain.node_rev (node_id, rev_no, valid_from, hash, p0_key, kind, name, line, end_line, parent_id, exported, lang, flags)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, k, run, n.hash, r.p0_key, r.kind, r.name, r.line, r.end_line, await nodeId(r.parent), r.exported === 1, r.lang, r.flags]);
    }
    for (const i of delta.items.put) {
      let item = (await q('SELECT item_id FROM brain.item WHERE ptr = $1', [i.ptr]))[0]?.item_id;
      if (!item) item = (await one('INSERT INTO brain.item (ptr, kind, origin) VALUES ($1, $2, $3) RETURNING item_id', [i.ptr, i.kind, i.origin])).item_id;
      if ((await q('SELECT 1 FROM brain.item_rev WHERE item_id = $1 AND valid_to IS NULL', [item])).length) await close('item_rev', 'item_id = $2', [item]);
      const { k } = await one('SELECT coalesce(max(rev_no), 0) + 1 AS k FROM brain.item_rev WHERE item_id = $1', [item]);
      const r = i.rev;
      const { rev_id: rev } = await one(`INSERT INTO brain.item_rev (item_id, rev_no, valid_from, hash, title, body, state, author, source_updated_at, meta,
        sanitize_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING rev_id`,
      [item, k, run, i.hash, r.title, r.body, r.state, r.author, r.source_updated_at, js(r.meta), r.sanitize_version]);
      for (const ch of i.chunks) {
        await c.query(`INSERT INTO brain.chunk (rev_id, ${C.CHUNK_HASH_COLUMNS.join(', ')}) VALUES ($1, ${C.CHUNK_HASH_COLUMNS.map((_, j) => `$${j + 2}`).join(', ')})`,
          [rev, ...C.CHUNK_HASH_COLUMNS.map((col) => ch[col])]);
      }
      for (const [ord, rf] of i.refs.entries()) {
        await c.query('INSERT INTO brain.ref (rev_id, ord, kind, target, origin) VALUES ($1, $2, $3, $4, $5)', [rev, ord, rf.kind, rf.target, rf.origin]);
      }
    }
    for (const e of delta.edge.put) {
      await c.query(`INSERT INTO brain.edge (fact_key, src_id, dst_id, kind, site_file_id, line, col, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fk('edge', e), await nodeId(e.src), await nodeId(e.dst), e.kind, await nodeId(e.site), e.line, e.col, run]);
    }
    for (const u of delta.unresolved.put) {
      await c.query('INSERT INTO brain.unresolved (fact_key, path, line, spec, local, valid_from) VALUES ($1, $2, $3, $4, $5, $6)',
        [fk('unresolved', u), u.path, u.line, u.spec, u.local, run]);
    }
    for (const l of delta.link.put) {
      const { chunk_id: chunk } = await one('SELECT chunk_id FROM brain.chunk WHERE rev_id = $1 AND ord = $2', [await revOf(l.ptr, l.revHash), l.ord]);
      await c.query('INSERT INTO brain.link (fact_key, chunk_id, node_id, kind, evidence, valid_from) VALUES ($1, $2, $3, $4, $5, $6)',
        [fk('link', l), chunk, await nodeId(l.node), l.kind, l.evidence, run]);
    }
    for (const r of delta.ref_link.put) {
      const { ref_id: ref } = await one('SELECT ref_id FROM brain.ref WHERE rev_id = $1 AND ord = $2', [await revOf(r.ptr, r.revHash), r.ord]);
      await c.query('INSERT INTO brain.ref_link (fact_key, ref_id, status, reason, resolved, resolved_raw, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [fk('ref_link', r), ref, r.status, r.reason, js(r.resolved), r.resolvedRaw, run]);
    }
    if (delta.sync.github) await c.query("INSERT INTO brain.sync_state (run_id, source, state) VALUES ($1, 'github', $2)", [run, js(delta.sync.github)]);
    await c.query("UPDATE brain.attempt SET status = 'ok', finished_at = now() WHERE attempt_id = $1", [att]);
    await c.query('COMMIT');
    return { run, state: { ...after, run } };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
}
