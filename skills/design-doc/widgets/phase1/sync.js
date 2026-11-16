  const root = $('#w-sync'); if (!root) return;
  const SPAN = 36, PER_PAGE = 3;
  const PRS = [ { n: 1203, ago: 0.4, st: 'open' }, { n: 1201, ago: 2.6, st: 'merged' }, { n: 1198, ago: 5.2, st: 'closed_unmerged' },
    { n: 1190, ago: 7.4, st: 'merged' }, { n: 1188, ago: 8.6, st: 'open' }, { n: 1176, ago: 12.5, st: 'merged' },
    { n: 1170, ago: 17, st: 'closed_unmerged' }, { n: 1162, ago: 22, st: 'merged' }, { n: 1150, ago: 29, st: 'merged' }, { n: 1141, ago: 34, st: 'merged' } ];
  const ISSUES = [ { n: 1199, ago: 3.3 }, { n: 1180, ago: 9.8 }, { n: 1100, ago: 26 } ];
  const COMMENTS = [ { id: 'ic:9101', on: 1203, ago: 0.3, kind: 'issues/comments' }, { id: 'rc:7702', on: 1201, ago: 2.5, kind: 'pulls/comments' },
    { id: 'ic:9077', on: 1150, ago: 4.1, kind: 'issues/comments', note: '오래된 PR 1150의 댓글 편집, PR updated_at은 그대로' },
    { id: 'rc:7650', on: 1176, ago: 12.4, kind: 'pulls/comments' } ];
  const db = new Map();                                     // ptr -> updated (simulated github.db)
  let cursor = null;                                        // hours ago (null = never synced)
  const x = (ago) => (100 - (ago / SPAN) * 100);
  const el = { tl: $('.timeline', root), log: $('.reqlog', root), res: $('.result', root), cur: $('#simCursor'), curOut: $('#simCursorOut'),
    first: $('#simFirst'), fail: $('#simFail'), run: $('#simRun'), reset: $('#simReset') };

  function draw(state = {}) {
    const c = el.first.checked ? null : +el.cur.value;
    const W = c == null ? null : c + 1;
    let h = '';
    if (W != null) { h += `<div class="tl-window" style="left:${x(Math.min(W, SPAN))}%;right:0"></div>`; h += `<div class="tl-overlap" style="left:${x(Math.min(W, SPAN))}%;width:${(1 / SPAN) * 100}%"></div>`; }
    else h += `<div class="tl-window" style="left:0;right:0;border-left:0"></div>`;
    h += `<div class="tl-row-label" style="top:6px">PR</div><div class="tl-row-label" style="top:62px">이슈</div><div class="tl-row-label" style="top:104px">댓글</div>`;
    const cls = (ptr, ago) => state.stop === ptr ? 'stop' : state.dedup?.has(ptr) ? 'dedup' : state.in?.has(ptr) ? 'in' : '';
    PRS.forEach((p, k) => h += `<div class="dot ${cls('pr:' + p.n)}" style="left:${x(p.ago)}%;top:${k % 2 ? 40 : 22}px" title="pr:${p.n} · ${p.st} · ${p.ago}시간 전">pr:${p.n}</div>`);
    ISSUES.forEach((p) => h += `<div class="dot ${cls('issue:' + p.n)}" style="left:${x(p.ago)}%;top:72px" title="issue:${p.n}">issue:${p.n}</div>`);
    COMMENTS.forEach((p, k) => h += `<div class="dot ${cls(p.id)}" style="left:${x(p.ago)}%;top:${k % 2 ? 128 : 112}px" title="${p.id} → pr:${p.on}${p.note ? ' · ' + p.note : ''}">${p.id}</div>`);
    if (c != null) h += `<div class="tl-mark cursor" style="left:${x(c)}%"><span>cursor C</span></div>`;
    if (W != null && W <= SPAN) h += `<div class="tl-mark" style="left:${x(W)}%;border-style:dashed"><span>W = C − 1h</span></div>`;
    h += `<div class="tl-mark" style="left:100%"><span style="left:auto;right:4px">T 지금</span></div>`;
    for (const t of [36, 24, 12, 0]) h += `<div class="tl-axis" style="left:${x(t)}%">${t ? '-' + t + 'h' : 'now'}</div>`;
    el.tl.innerHTML = h;
    el.curOut.textContent = c == null ? '없음 (첫 실행)' : `${c}시간 전`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; el.log.append(d); el.log.scrollTop = el.log.scrollHeight; };

  async function run() {
    el.run.disabled = true; el.log.innerHTML = '';
    const c = el.first.checked ? null : +el.cur.value, W = c == null ? Infinity : c + 1, fail = el.fail.value;
    const state = { in: new Set(), dedup: new Set(), stop: null };
    const upsert = (ptr, ago) => { const old = db.get(ptr); if (old === ago) { state.dedup.add(ptr); return '중복: 행 그대로'; } db.set(ptr, ago); state.in.add(ptr); return old == null ? '새 행' : '갱신'; };
    const err = (msg) => { line('err', msg); finish(false, msg); };
    line('dim', `# lockfile 획득 · cursor = ${c == null ? '없음' : c + 'h 전'} · W = ${c == null ? '없음 (전체)' : (c + 1) + 'h 전'}`);
    line('', 'GET /repos/o/r'); await sleep(200);
    line('db', '  repo id 4815162 = 저장된 값 · Date 헤더 → T (지금)');
    // 1. PR list, desc, stop rule
    const sorted = [...PRS].sort((a, b) => a.ago - b.ago);
    let page = 1, stopped = false;
    for (let k = 0; k < sorted.length && !stopped; k += PER_PAGE, page++) {
      line('', `GET /pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`);
      await sleep(260);
      if (fail === 'pr2' && page === 2) return err('  ← 500 (3회 재시도 실패) → run failed');
      for (const p of sorted.slice(k, k + PER_PAGE)) {
        if (p.ago > W) { state.stop = 'pr:' + p.n; line('err', `  pr:${p.n} updated ${p.ago}h 전 < W → 멈춤 (뒤는 모두 더 오래됨)`); stopped = true; break; }
        line('db', `  upsert pr:${p.n} (${p.st}) · ${upsert('pr:' + p.n, p.ago)}`);
      }
      draw(state);
    }
    // 2–3. since streams, ascending, keyset (next since = last item's updated_at)
    const since = c == null ? '(없음)' : 'W';
    const stream = async (path, items, label) => {
      const asc = [...items].sort((a, b) => b.ago - a.ago);
      line('', `GET ${path}?${path === '/issues' ? 'state=all&' : ''}sort=updated&direction=asc&since=${since}`); await sleep(200);
      for (const s of asc) line('db', `  upsert ${label(s)} · ${upsert(s.ptr, s.ago)}${s.note ? '  ← ' + s.note : ''}`);
      if (asc.length) line('dim', `  100개 미만 → 끝 (100개였다면 다음 since = 마지막 항목 시각 − 1초, ${asc[asc.length - 1].ago}h 전 − 1s)`);
      draw(state);
    };
    await stream('/issues', ISSUES.filter((s) => s.ago <= W).map((s) => ({ ...s, ptr: 'issue:' + s.n })), (s) => s.ptr);
    if (fail === 'ic') { line('', `GET /issues/comments?sort=updated&direction=asc&since=${since}`); await sleep(200); return err('  ← 403 secondary rate limit, 1분·2분·4분 대기 뒤에도 실패 → run failed'); }
    const cm = COMMENTS.filter((s) => s.ago <= W).map((s) => ({ ...s, ptr: s.id }));
    await stream('/issues/comments', cm.filter((s) => s.kind === 'issues/comments'), (s) => `${s.id} → parent #${s.on}`);
    await stream('/pulls/comments', cm.filter((s) => s.kind === 'pulls/comments'), (s) => `${s.id} → parent #${s.on}`);
    // 4. changed PRs = window PRs ∪ comment parents · open PRs re-fetch reviews
    const changed = [...new Set([...sorted.filter((p) => p.ago <= W).map((p) => p.n), ...cm.map((s) => s.on)])];
    const open = PRS.filter((p) => p.st === 'open' && db.has('pr:' + p.n) && !changed.includes(p.n)).map((p) => p.n);
    line('dim', `# 바뀐 PR = 창 안 PR ∪ 댓글이 달린 PR = {${changed.join(', ')}}${open.length ? ` · 창 밖 열린 PR {${open.join(', ')}}은 리뷰만` : ''}`);
    let k = 0;
    for (const n of [...changed, ...open]) {
      line('', `GET /pulls/${n}/reviews`); await sleep(150);
      if (fail === 'rev' && k++ === 0) return err('  ← 502 (3회 재시도 실패) → run failed');
      if (!changed.includes(n)) continue;
      const p = PRS.find((q) => q.n === n), done = detailFor.get(n);
      if (p && done === p.ago) { line('dim', `  pr:${n} files: detail_for = 지금 updated_at → 건너뜀`); continue; }
      line('', `GET /pulls/${n}/files`); await sleep(110);
      if (p) detailFor.set(n, p.ago);
    }
    finish(true, null, changed.length);
  }
  const detailFor = new Map();
  function finish(ok, msg, nChanged) {
    const before = el.first.checked ? null : +el.cur.value;
    if (ok) { cursor = 0; line('ok', '# 한 트랜잭션: cursor = T (첫 응답의 Date 헤더) · run ok'); }
    else line('err', '# run failed · last_error 기록 · cursor 그대로');
    line('dim', '# linker (로컬): pending refs → linked / ambiguous / unlinked · lockfile 해제');
    const after = ok ? 'T (지금)' : (before == null ? '없음' : before + 'h 전 (그대로)');
    el.res.innerHTML = `<div class="big">${ok ? '<span class="pill ok">run ok</span>' : '<span class="pill bad">run failed</span>'}</div>
      <dl><dt>cursor 전</dt><dd>${before == null ? '없음' : before + 'h 전'}</dd><dt>cursor 후</dt><dd>${after}</dd>
      <dt>DB 행</dt><dd>${db.size}개 (쪽마다 upsert, 멱등)</dd>${ok ? `<dt>바뀐 PR</dt><dd>${nChanged}개 → reviews·files</dd>` : `<dt>오류</dt><dd>${msg}</dd>`}</dl>
      <p style="margin:8px 0 0;color:var(--muted)">${ok ? '다시 실행하면 W = T − 1h. 겹친 항목은 <span class="pill warn">중복</span>으로 행이 그대로입니다.' : '실패해도 이미 쓴 행은 남지만 cursor가 안 움직였으므로, 다음 run이 같은 창부터 다시 받아 같은 상태로 수렴합니다.'}</p>`;
    if (ok) { el.first.checked = false; el.cur.value = 0; }
    el.run.disabled = false; draw();
  }
  el.cur.oninput = () => { el.first.checked = false; draw(); };
  el.first.onchange = () => draw();
  el.run.onclick = run;
  el.reset.onclick = () => { db.clear(); detailFor.clear(); cursor = null; el.first.checked = true; el.cur.value = 8; el.log.innerHTML = '<div class="dim"># 초기화: github.db 비움</div>'; el.res.innerHTML = '실행 결과가 여기에 나옵니다.'; draw(); };
  draw();
