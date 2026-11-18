// Test-only TCP proxy for the Postgres wire protocol (Q11; V9–V12). The client talks plaintext to 127.0.0.1; the proxy
// talks TLS to the server (SNI = the server host: Neon routes a connection to its endpoint by SNI). It splits both
// directions into protocol frames, so a rule can pick a query by its SQL text (simple Query or extended Parse) and:
//   dropReply  forward the query, let the replies to earlier queries through, swallow the query's own reply (every
//              server frame up to and including its ReadyForQuery), then cut both sockets. For COMMIT: the server
//              commits, the client never hears it (V11). Replies are matched by counting sync points: the startup, each
//              Query and each Sync get exactly one ReadyForQuery.
//   delayMs    hold the query (and every client frame after it, in order) for that long before forwarding it (V12).
//   cut        cut both sockets instead of forwarding the query: the server sees the client vanish mid-transaction (V10).
// COMMIT must reach the proxy as a simple Query (node-postgres sends a query without parameters that way).
// The proxy never logs; connection strings and passwords pass through it but are never stored.
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

const SSL_REQUEST = 80877103, GSS_REQUEST = 80877104, CANCEL_REQUEST = 80877102;
const sslRequest = () => { const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(SSL_REQUEST, 4); return b; };

/** SQL text of a client frame ('Q' Query or 'P' Parse), else null */
function sqlOf(frame) {
  const type = String.fromCharCode(frame[0]), body = frame.subarray(5);
  if (type === 'Q') return body.subarray(0, body.indexOf(0)).toString('utf8');
  if (type === 'P') { const s = body.indexOf(0) + 1; return body.subarray(s, body.indexOf(0, s)).toString('utf8'); }
  return null;
}

const MAX_FRAME = 1 << 30;
/** Splits a byte stream into typed frames (1 type byte + int32 length that counts itself). Throws on a bad length. */
export class Framer {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const n = this.buf.readInt32BE(1);
      if (n < 4 || n > MAX_FRAME) throw new Error(`bad protocol frame length ${n}`);
      const len = n + 1;
      if (this.buf.length < len) break;
      out.push(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);
    }
    return out;
  }
}

/**
 * @param {string} targetUrl a postgres:// URL; only its host and port are used
 * @returns {Promise<Proxy>}
 */
export async function startProxy(targetUrl) {
  const target = new URL(targetUrl), host = target.hostname, port = Number(target.port || 5432);
  const proxy = new Proxy(host, port);
  await new Promise((res, rej) => proxy.server.once('error', rej).listen(0, '127.0.0.1', res));
  proxy.port = proxy.server.address().port;
  return proxy;
}

class Proxy extends EventEmitter {
  constructor(host, port) {
    super();
    this.host = host; this.targetPort = port;
    /** @type {{ pattern: RegExp, delayMs: number, dropReply: boolean, cut: boolean, times: number, hits: number }[]} */
    this.rules = [];
    this.sockets = new Set();
    this.connections = 0;
    this.server = net.createServer((client) => this.#accept(client));
  }

  /**
   * Add a rule. The first matching rule with times left applies; times counts matches (default 1).
   * @param {RegExp} pattern tested against the SQL text
   * @param {{ delayMs?: number, dropReply?: boolean, cut?: boolean, times?: number }} action
   */
  when(pattern, { delayMs = 0, dropReply = false, cut = false, times = 1 } = {}) {
    const rule = { pattern, delayMs, dropReply, cut, times, hits: 0 };
    this.rules.push(rule);
    return rule;
  }

  /** The same URL pointed at the proxy: host 127.0.0.1, the proxy port, sslmode=disable. */
  url(originalUrl) {
    const u = new URL(originalUrl);
    u.hostname = '127.0.0.1'; u.port = String(this.port);
    u.searchParams.delete('channel_binding');
    u.searchParams.set('sslmode', 'disable');
    return u.toString();
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((res) => this.server.close(() => res()));
  }

  #track(s) { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); s.on('error', () => {}); return s; }

  #rule(sql) {
    const r = this.rules.find((x) => x.hits < x.times && x.pattern.test(sql));
    if (r) r.hits += 1;
    return r;
  }

  #accept(client) {
    this.connections += 1;
    this.#track(client);
    let upstream = null, startup = Buffer.alloc(0), ready = false, chain = Promise.resolve();
    // sync points sent (the startup counts) and ReadyForQuery frames seen; dropAfter: swallow once that many Z went by
    let sent = 1, seen = 0, dropAfter = null;
    const cutBoth = () => { client.destroy(); upstream?.destroy(); };
    const clientFrames = new Framer(), serverFrames = new Framer();

    const fromServer = (chunk) => {
      let frames;
      try { frames = serverFrames.push(chunk); } catch { cutBoth(); return; }
      for (const f of frames) {
        const swallow = dropAfter !== null && seen >= dropAfter;
        if (f[0] === 0x5a) seen += 1;                              // 'Z' ReadyForQuery
        if (!swallow) { client.write(f); continue; }
        if (f[0] === 0x5a) { cutBoth(); return; }                 // the matched query's reply is over, nobody saw it
      }
    };
    // client frames go through one promise chain, so a delayed frame holds back every frame after it
    const toServer = async (frame) => {
      const sql = sqlOf(frame), rule = sql === null ? null : this.#rule(sql);
      if (rule) {
        this.emit('match', { sql, rule });
        if (rule.delayMs) await new Promise((res) => setTimeout(res, rule.delayMs));
        if (rule.cut) { cutBoth(); return; }
        if (rule.dropReply && dropAfter === null) dropAfter = sent;   // its reply ends with the next ReadyForQuery
      }
      if (frame[0] === 0x51 || frame[0] === 0x53) sent += 1;      // 'Q' Query, 'S' Sync
      if (!upstream.destroyed) upstream.write(frame);
    };
    const fromClient = (chunk) => {
      if (ready) {
        let frames;
        try { frames = clientFrames.push(chunk); } catch { cutBoth(); return; }
        for (const f of frames) chain = chain.then(() => toServer(f));
        return;
      }
      startup = Buffer.concat([startup, chunk]);
      while (!upstream && startup.length >= 8) {
        const len = startup.readInt32BE(0), code = startup.readInt32BE(4);
        if (len < 8 || len > 10000) { cutBoth(); return; }
        if (startup.length < len) return;
        const msg = startup.subarray(0, len);
        startup = startup.subarray(len);
        if (code === SSL_REQUEST || code === GSS_REQUEST) { client.write('N'); continue; }   // the client side stays plaintext
        connectUpstream(msg, code === CANCEL_REQUEST);
      }
    };
    const connectUpstream = (first, cancel) => {
      const raw = this.#track(net.connect(this.targetPort, this.host));
      upstream = raw;
      raw.once('connect', () => raw.write(sslRequest()));
      raw.once('data', (b) => {
        if (b[0] !== 0x53) { cutBoth(); return; }                  // 'S': the server agreed to TLS
        const sec = this.#track(tls.connect({ socket: raw, servername: this.host }));
        upstream = sec;
        sec.once('secureConnect', () => {
          sec.write(first);
          if (cancel) { sec.end(); return; }
          ready = true;
          if (startup.length) { const rest = startup; startup = Buffer.alloc(0); fromClient(rest); }
        });
        sec.on('data', fromServer);
        sec.on('close', () => client.destroy());
      });
      raw.on('close', () => client.destroy());
    };
    client.on('data', fromClient);
    client.on('close', () => upstream?.destroy());
  }
}

/** @typedef {Proxy} ProxyHandle */
