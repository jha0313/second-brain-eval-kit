// sanitize: normalize -> mask secrets -> flag injection-looking text. Lane B owns this file.
//
// Contract (design §6.4, §6.5 L2/L8):
// - every function is pure and synchronous
// - LINE COUNT IS PRESERVED: out.split('\n').length === in.split('\n').length for normalize, mask, sanitize
// - replacements look like [REDACTED:<kind>]; identifiers (sanitizeIdent) get a short stable hash suffix
//   [REDACTED:<kind>:<4 hex>] so two different redacted paths never collide as graph keys
// - no function ever returns, logs or throws the secret it found
import { createHash } from 'node:crypto';

/** Bump when any rule changes: older stores are refused by the read guard (answer.mjs guard()). */
export const SANITIZE_VERSION = 1;

/** Kinds mask() can report (design §6.4 table). */
export const SECRET_KINDS = ['github-token', 'aws-key', 'slack', 'private-key', 'api-key', 'jwt', 'url-credential', 'bearer', 'assignment'];

// ---------- L2: normalize ----------

// CSI (ESC [ … final), OSC (ESC ] … BEL | ESC \, or to the end of the line), charset designations, 2-byte escapes, C1 CSI
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[ -/]+[0-~]|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;
// C0 except \t and \n, DEL, C1, zero-width (U+200B–200D, U+2060, U+FEFF), bidi (U+200E–200F, U+202A–202E, U+2066–2069)
const INVISIBLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** L2: strip ANSI / C0 (but \n, \t) / C1 / bidi / zero-width; CRLF -> LF; lone CR, U+0085, U+2028, U+2029 -> space. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\r\u0085\u2028\u2029]/g, ' ')     // before INVISIBLE: U+0085 is C1, and CR is C0
    .replace(ANSI, '')
    .replace(INVISIBLE, '');
}

// ---------- masking ----------

// Values that are not literals (design §6.4 "남기는 것"). Anywhere: interpolation and placeholders.
const PLACEHOLDER = [
  /^(?:\$\{|\{\{|<)/,                                                                   // ${{ secrets.X }}, ${VAR}, {{ .Values.x }}, <token>
  /^\$[A-Z_][A-Z0-9_]*$/,                                                               // $TOKEN
  /^(?:x{3,}|\*{3,}|\.{3}|…|changeme)$/i,                                               // xxx, ***, changeme
];
// Unquoted only: code that reads a secret or annotates a type. Inside quotes the same text is a literal.
const CODE = [
  /^(?:process\.env\b|os\.environ\b|ENV\[|ENV\.fetch\b|Deno\.env\b|import\.meta\.env\b)/,
  /^(?:[\w$]+\.)*get_?env\s*\(/i,                                                       // getenv("X"), os.getenv(…), System.getenv(…)
  /^(?:string|str|number|int|bool|boolean|bytes|any|unknown|null|none|nil|undefined)$/i,   // `token: string`
  /^(?:await|new|yield|typeof)$|^(?:this|self)\./,                                     // `const token = await …`, `token: this.token`
  /^[{[(|>-]+$/,                                                                        // structure, not a value: "{", "|", ">-"
];
// a value that is nothing but markers (and closing punctuation) was masked already; text around a marker is a literal
const MASKED = /^(?:\[REDACTED:[a-z-]+(?::[0-9a-f]{4})?\])+[,;)\]}"'\x60]*$/;
const notLiteral = (v, quoted) => !v || MASKED.test(v) || PLACEHOLDER.some((re) => re.test(v)) || (!quoted && CODE.some((re) => re.test(v)));

// "keyword <sep> value": value is a quoted string or a bare token up to whitespace (design: any literal, any length)
const SEP = String.raw`(["']?)([ \t]*\??[ \t]*(?::=|=(?![=>])|:(?!:))[ \t]*)`;
const VALUE = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60[^\x60\n]*\x60|\S+)`;
// not inside a marker: "[REDACTED:github-token:1a2b]" must not read as "token: 1a2b]"
const NOT_IN_MARKER = String.raw`(?<!\[REDACTED:[a-z-]*)`;
const AWS_SECRET = new RegExp(`${NOT_IN_MARKER}((?:aws[_-]?)?secret[_-]?access[_-]?key)${SEP}${VALUE}`, 'gi');
const ASSIGNMENT = new RegExp(`${NOT_IN_MARKER}(password|passwd|secret(?:[_-]?key)?|token|api[_-]?key)(?![A-Za-z0-9_])${SEP}${VALUE}`, 'gi');

const PRIVATE_KEY = new RegExp(String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:` +
  String.raw`(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----` +   // up to its END
  String.raw`|.*(?:\n(?![ \t]*(?:\n|$)).*)*)`, 'g');                                         // no END: to the end of the paragraph

// [kind, regex, group index of the secret inside the match (0 = all of it), test of the secret (optional)]
const TOKEN_RULES = [
  ['github-token', /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g, 0],
  ['aws-key', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, 0],
  ['slack', /xox[abprs]-[A-Za-z0-9-]{10,}/g, 0],
  ['slack', /(hooks\.slack\.com\/services\/)([A-Za-z0-9_/-]+)/g, 2],
  ['api-key', /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9])[sr]k_live_[A-Za-z0-9]{10,}|(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, 0],
  ['jwt', /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, 0],
  // scheme://user:pass@host -> user:pass (the last @ before the path, so a raw @ in the password is covered)
  ['url-credential', /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@:]*:([^\s/?#]*))@/gi, 2, (m) => !notLiteral(m[3], true)],
  // Authorization: Bearer|Basic|token <value>; a bare header value only when it looks like a token
  ['bearer', /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?)((?:Bearer|Basic|token|Digest)[ \t]+)?([^\s"',;]+)/gi, 3,
    (m) => !notLiteral(m[3], true) && (m[2] || (m[3].length >= 8 && /\d/.test(m[3])))],
  ['bearer', /(\bBearer[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi, 2, (m) => /\d/.test(m[2])],
];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const plainMark = (kind) => `[REDACTED:${kind}]`;
// Identifier marker: 4 hex of the secret's hash. With `taken` (one sweep = one code.db), a marker that another secret
// already holds moves to the next salted hash, so two secrets never share a graph key. Only hashes are kept.
const identMark = (taken) => (kind, secret) => {
  const id = sha256(secret);
  let marker;
  for (let salt = 0; salt < 1000; salt++) {
    marker = `[REDACTED:${kind}:${(salt ? sha256(`${salt}:${secret}`) : id).slice(0, 4)}]`;
    const owner = taken?.get(marker);
    if (!taken || owner === id) return marker;
    if (owner === undefined) { taken.set(marker, id); return marker; }
  }
  return marker;
};

// The rules, in order. mark(kind, secret) -> marker. Every rule keeps line breaks where they are.
function maskWith(input, mark) {
  let text = String(input ?? '');
  let redactions = 0;
  const found = new Set();
  const hit = (kind, secret) => { redactions++; found.add(kind); return mark(kind, secret); };

  // a key block is masked line by line (line count kept, indentation kept)
  text = text.replace(PRIVATE_KEY, (block) => {
    const marker = hit('private-key', block);
    return block.split('\n').map((seg) => (seg.trim() ? seg.match(/^[ \t]*/)[0] + marker : seg)).join('\n');
  });
  for (const [kind, re, group, ok] of TOKEN_RULES) {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2);                        // [match, ...groups]
      const secret = m[group];
      if (secret === undefined || MASKED.test(secret) || (ok && !ok(m))) return m[0];
      if (!group) return hit(kind, secret);
      const at = m[0].indexOf(secret, m.slice(1, group).join('').length);
      return m[0].slice(0, at) + hit(kind, secret) + m[0].slice(at + secret.length);
    });
  }
  for (const [kind, re] of [['aws-key', AWS_SECRET], ['assignment', ASSIGNMENT]]) {
    text = text.replace(re, (all, key, quote, sep, value) => {
      const q = /^["'\x60]/.test(value) && value.length > 1 && value.at(-1) === value[0];
      let core = q ? value.slice(1, -1) : value;
      if (MASKED.test(core)) return all;                  // before the tail is cut: "]" may close a marker
      let tail = '';
      if (!q) { const t = /[,;)\]}"'\x60]+$/.exec(core); if (t && t.index > 0) { tail = t[0]; core = core.slice(0, t.index); } }
      if (notLiteral(core, q)) return all;
      return key + quote + sep + (q ? value[0] : '') + hit(kind, core) + (q ? value[0] : '') + tail;
    });
  }
  return { text, redactions, kinds: SECRET_KINDS.filter((k) => found.has(k)) };
}

/** @returns {{ text: string, redactions: number, kinds: string[] }} input must already be normalized */
export function mask(text) { return maskWith(text, plainMark); }

// ---------- L8: injection-looking text ----------

const SUSPICIOUS = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)*(?:previous|prior|above|earlier)\s+(?:instructions|prompts|messages|rules)/i,
  /\byou\s+are\s+now\b/i,
  /<\/?\s*system\s*>|<\|im_start\|>/i,
  /\brun\s+the\s+following\b/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  /이전\s*(?:의\s*)?(?:모든\s*)?지시(?:사항)?(?:을|를)?\s*무시/,
];

/** L8: true when the text looks like an instruction aimed at an agent. A warning, never a filter. */
export function flagSuspicious(text) {
  const s = String(text ?? '');
  return SUSPICIOUS.some((re) => re.test(s));
}

/** normalize -> mask -> flag. @returns {{ text: string, redactions: number, kinds: string[], suspicious: boolean }} */
export function sanitize(text) {
  const m = mask(normalize(text));
  return { ...m, suspicious: flagSuspicious(m.text) };
}

/**
 * Detector only (Phase 2 R16, upload check): the secret kinds found in any string, nothing rewritten. The same rules as
 * mask(), so the answer depends only on the text and SANITIZE_VERSION (bump it whenever a rule changes).
 * @param {unknown} s @returns {string[]} kinds from SECRET_KINDS, empty when clean
 */
export function detectSecrets(s) {
  // each stretch between redaction markers on its own: a marker ends any match, so text the masker already wrote
  // (a swept node key "src/token=[REDACTED:assignment:7f34]#Name") is not read as a new assignment value
  const found = new Set();
  for (const part of normalize(String(s ?? '')).split(MARKER)) for (const k of mask(part).kinds) found.add(k);
  return SECRET_KINDS.filter((k) => found.has(k));
}
const MARKER = /\[REDACTED:[a-z-]+(?::[0-9a-f]{4})?\]/;

/** One-line external value (login, branch, title, file path from GitHub): sanitize, then fold newlines to spaces. */
export function sanitizeLine(s) { return sanitize(s).text.replace(/\n/g, ' '); }

/** A graph identifier (repo path, symbol name, import spec): masked with a collision-safe hash suffix. */
export function sanitizeIdent(s) { return maskIdent(s, null); }

// an identifier is a key: it changes only when it holds a secret (the same secret always gives the same marker)
function maskIdent(s, taken) {
  const raw = String(s ?? '');
  const m = maskWith(normalize(raw), identMark(taken));
  return m.redactions ? m.text : raw;
}

/** true when sanitizeIdent / sanitizeLine changed the value: such values are never linked (reason: redacted). */
export const isRedacted = (s) => /\[REDACTED:[a-z-]+(?::[0-9a-f]{4})?\]/.test(String(s ?? ''));

// Cheap prefilter for sweepSecrets: a value with none of these cannot match any rule.
const MAY_HOLD_SECRET = /gh[pousr]_|github_pat_|AKIA|ASIA|xox[abprs]-|hooks\.slack|PRIVATE KEY|sk-|k_live_|AIza|eyJ|:\/\/|bearer|authorization|passw|secret|token|api[_-]?key|[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060\u2066-\u2069\ufeff]/i;
const PROSE = { chunks: new Set(['title', 'body']) };

/**
 * Defense in depth at the write boundary: rewrite every text column of code.db that still matches a secret
 * pattern (nodes.key/name/path, edges.path, unresolved.spec/path, links.evidence, meta values, chunks + FTS).
 * Called by build.mjs inside the build transaction; code.db runs with secure_delete=ON so old bytes are zeroed.
 * @param {import('node:sqlite').DatabaseSync} db @returns {{ rows: number }}
 */
export function sweepSecrets(db) {
  let rows = 0;
  const memo = new Map();                                    // edges.path repeats once per edge: mask each value once
  const taken = new Map();                                   // marker -> hash of its secret, for this database
  const ident = (v) => {
    if (!MAY_HOLD_SECRET.test(v)) return v;
    if (!memo.has(v)) memo.set(v, maskIdent(v, taken));
    return memo.get(v);
  };
  const prose = (v) => (MAY_HOLD_SECRET.test(v) ? sanitize(v).text : v);

  for (const table of ['nodes', 'edges', 'unresolved', 'links', 'chunks']) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?) WHERE upper(type) = 'TEXT'`).all(table).map((r) => r.name);
    const fix = cols.map((c) => (PROSE[table]?.has(c) ? prose : table === 'nodes' && c === 'key' ? null : ident));
    const updates = [];
    for (const r of db.prepare(`SELECT rowid AS rid_, ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`).iterate()) {
      const next = cols.map((c, i) => (typeof r[c] !== 'string' ? r[c] : fix[i] ? fix[i](r[c]) : nodeKey(r, ident)));
      if (next.some((v, i) => v !== r[cols[i]])) updates.push([...next, r.rid_]);
    }
    if (updates.length) {
      const up = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE rowid = ?`);
      for (const u of updates) up.run(...u);
    }
    rows += updates.length;
  }

  // meta values are JSON: mask the strings inside (object keys too: worktree is keyed by path), never the JSON text
  const walk = (v) => (typeof v === 'string' ? ident(v)
    : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [ident(k), walk(x)])) : v);
  const setValue = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
  for (const { key, value } of db.prepare('SELECT key, value FROM meta').all()) {
    if (value === null) continue;
    const next = JSON.stringify(walk(JSON.parse(value)));
    if (next !== value) { setValue.run(next, key); rows++; }
  }

  // external-content FTS keeps its own copy of every token: rebuild both from the swept chunks
  db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild'); INSERT INTO chunks_tri(chunks_tri) VALUES('rebuild');`);
  return { rows };
}

// A node key is built from its path and name (file: path, dir: dir:<path>, symbol: <path>#[Parent.]Name[@kind]). Mask
// the parts and join them again: masked as one string, an assignment-shaped path ("token=…") would take the rest of
// the key into its value and give the key a different marker than its own path (Phase 2 canonicalNodeKey). The
// rebuilt key holds only text that the swept path and name columns hold too.
function nodeKey({ key, kind, name, path }, ident) {
  let k = null;
  if (typeof path === 'string') {
    if (key === path) k = ident(path);
    else if (key === `dir:${path}`) k = `dir:${ident(path)}`;
    else if (key.startsWith(`${path}#`) && typeof name === 'string') {
      const rest = symbolKey(key.slice(path.length + 1), name, kind, ident);
      if (rest !== null) k = `${ident(path)}#${rest}`;
    }
  }
  return k ?? ident(key);                                  // any other shape: mask it as one string
}

// keyName[@kind] after "<path>#": keyName is name, or "<parent name>.name" for a member
function symbolKey(rest, name, kind, ident) {
  for (const [body, at] of [[rest, ''], rest.endsWith(`@${kind}`) ? [rest.slice(0, -kind.length - 1), `@${kind}`] : null].filter(Boolean)) {
    if (body === name) return `${ident(name)}${at}`;
    if (body.endsWith(`.${name}`)) return `${ident(body.slice(0, -name.length - 1))}.${ident(name)}${at}`;
  }
  return null;
}

/** Replace exact runtime values (the active token) wherever they appear: error messages, logs. */
export function redactValues(text, values) {
  let out = String(text ?? '');
  for (const v of values || []) if (v && v.length >= 8) out = out.split(v).join('[REDACTED:active-token]');
  return out;
}
