// sanitize: normalize -> mask secrets -> flag injection-looking text. Lane B owns this file.
// P0 STUB: identity functions with SANITIZE_VERSION = 0 ("nothing masked"), so the build and the read guard
// keep working before lane B lands. Lane B replaces the bodies and sets SANITIZE_VERSION = 1.
//
// Contract (design §6.4, §6.5 L2/L8):
// - every function is pure and synchronous
// - LINE COUNT IS PRESERVED: out.split('\n').length === in.split('\n').length for normalize, mask, sanitize
// - replacements look like [REDACTED:<kind>]; identifiers (sanitizeIdent) get a short stable hash suffix
//   [REDACTED:<kind>:<4 hex>] so two different redacted paths never collide as graph keys
// - no function ever returns, logs or throws the secret it found

/** Bump when any rule changes: older stores are refused by the read guard (answer.mjs guard()). */
export const SANITIZE_VERSION = 0;

/** Kinds mask() can report (design §6.4 table). */
export const SECRET_KINDS = ['github-token', 'aws-key', 'slack', 'private-key', 'api-key', 'jwt', 'url-credential', 'bearer', 'assignment'];

/** L2: strip ANSI / C0 (but \n, \t) / C1 / bidi / zero-width; CRLF -> LF; lone CR, U+0085, U+2028, U+2029 -> space. */
export function normalize(text) { return String(text ?? ''); }

/** @returns {{ text: string, redactions: number, kinds: string[] }} input must already be normalized */
export function mask(text) { return { text: String(text ?? ''), redactions: 0, kinds: [] }; }

/** L8: true when the text looks like an instruction aimed at an agent. A warning, never a filter. */
export function flagSuspicious(_text) { return false; }

/** normalize -> mask -> flag. @returns {{ text: string, redactions: number, kinds: string[], suspicious: boolean }} */
export function sanitize(text) {
  const m = mask(normalize(text));
  return { ...m, suspicious: flagSuspicious(m.text) };
}

/** One-line external value (login, branch, title, file path from GitHub): sanitize, then fold newlines to spaces. */
export function sanitizeLine(s) { return sanitize(s).text.replace(/\n/g, ' '); }

/** A graph identifier (repo path, symbol name, import spec): masked with a collision-safe hash suffix. */
export function sanitizeIdent(s) { return String(s ?? ''); }

/** true when sanitizeIdent / sanitizeLine changed the value: such values are never linked (reason: redacted). */
export const isRedacted = (s) => /\[REDACTED:[a-z-]+(?::[0-9a-f]{4})?\]/.test(String(s ?? ''));

/**
 * Defense in depth at the write boundary: rewrite every text column of code.db that still matches a secret
 * pattern (nodes.key/name/path, edges.path, unresolved.spec/path, links.evidence, meta values, chunks + FTS).
 * Called by build.mjs inside the build transaction; code.db runs with secure_delete=ON so old bytes are zeroed.
 * @param {import('node:sqlite').DatabaseSync} db @returns {{ rows: number }}
 */
export function sweepSecrets(_db) { return { rows: 0 }; }

/** Replace exact runtime values (the active token) wherever they appear: error messages, logs. */
export function redactValues(text, values) {
  let out = String(text ?? '');
  for (const v of values || []) if (v && v.length >= 8) out = out.split(v).join('[REDACTED:active-token]');
  return out;
}
