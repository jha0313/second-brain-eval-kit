// A local Postgres proxy that can drop the reply to, or hold, the COMMIT of one session (V11, V12), until lane A's test/pg/proxy.mjs
// lands. The client speaks plain TCP to 127.0.0.1; the proxy opens TLS to the real server (SSLRequest, SNI = the server
// host, which is how Neon finds the endpoint) and reads the client's messages to find a simple-query COMMIT.
import net from 'node:net';
import tls from 'node:tls';

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

/**
 * @param {string} url the server URL (TLS); the returned url points at the proxy with the same user and password
 * @returns {Promise<{ url: string, commits: number, close(): Promise<void>,
 *   arm(mode: 'drop-reply'|'hold'): void | { seen: Promise<void>, release(): void } }>}
 *   'hold': the next COMMIT waits in the proxy until release(); seen resolves when it arrives
 */
export async function commitProxy(url) {
  const target = new URL(url);
  const state = { mode: null, commits: 0 };
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    const raw = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(raw);
    const pending = [];
    let upstream = null, dropReplies = false, started = false, buf = Buffer.alloc(0), queue = Promise.resolve();
    const kill = () => { client.destroy(); raw.destroy(); upstream?.destroy(); };
    client.on('error', kill); raw.on('error', kill); client.on('close', kill);
    client.on('data', (d) => (upstream ? onClient(d) : pending.push(d)));
    raw.once('connect', () => raw.write(SSL_REQUEST));
    raw.once('data', (b) => {
      if (b[0] !== 0x53) return kill();                            // 'S': the server accepts TLS
      upstream = tls.connect({ socket: raw, servername: target.hostname });
      upstream.on('error', kill);
      upstream.on('data', (d) => { if (!dropReplies) client.write(d); });
      upstream.once('secureConnect', () => { for (const d of pending.splice(0)) onClient(d); });
    });
    // client -> server: forward message by message; a COMMIT may be held or have its reply dropped
    function onClient(d) {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const head = started ? 1 : 0;
        if (buf.length < head + 4) return;
        const len = buf.readInt32BE(head) + head;
        if (buf.length < len) return;
        const msg = buf.subarray(0, len);
        buf = buf.subarray(len);
        started = true;
        const isCommit = head === 1 && msg[0] === 0x51 && msg.subarray(5, len - 1).toString('utf8').trim().toUpperCase() === 'COMMIT';
        const mode = isCommit ? state.mode : null;
        if (isCommit && mode) { state.mode = null; state.commits++; }
        queue = queue.then(async () => {
          if (mode?.gate) { mode.arrived(); await mode.gate; }
          upstream.write(msg);
          if (mode === 'drop-reply') dropReplies = true;           // the server commits; the client never hears it
        });
      }
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = new URL(url);
  local.hostname = '127.0.0.1';
  local.port = String(server.address().port);
  local.search = '?sslmode=disable';
  return {
    url: local.toString(),
    get commits() { return state.commits; },
    arm(mode) {
      if (mode !== 'hold') { state.mode = mode; return undefined; }
      const h = {};
      h.seen = new Promise((r) => (h.arrived = r));
      h.gate = new Promise((r) => (h.release = r));
      state.mode = h;
      return { seen: h.seen, release: () => h.release() };
    },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
