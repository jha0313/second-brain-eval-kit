// Phase 1 error classes (P0 contract). Every error has a stable `code` that callers branch on.
// Messages never contain a token, an Authorization header, or a raw external string.

export class BrainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.assign(this, extra);
  }
}

// GitHub API failure after the client's own retries. kind: auth | forbidden | not-found | rate-limit | network | server | protocol
export class GhError extends BrainError {
  constructor(kind, message, { status = null, retryAfter = null } = {}) { super(`gh-${kind}`, message, { kind, status, retryAfter }); }
}

// another write (build / sync / relink / --full swap) holds the repo's lock
export class LockBusyError extends BrainError {
  constructor(pid) { super('lock-busy', `another brain write is running (pid ${pid})`, { pid }); }
}

// a pointer string that does not parse
export class PtrError extends BrainError {
  constructor(ptr) { super('bad-pointer', `not a brain pointer: ${JSON.stringify(String(ptr).slice(0, 80))}`); }
}

// a Phase 0 pointer from another build: the index was rebuilt, search again
export class StalePtrError extends BrainError {
  constructor(ptr, build, current) { super('stale-pointer', `the index was rebuilt (pointer build ${build}, now ${current}) — run brain search again`, { ptr, build, current }); }
}

// a pointer that parses but names nothing in the stores
export class NotFoundError extends BrainError {
  constructor(ptr) { super('not-found', `no such item: ${ptr}`); }
}

// stores written before the current sanitizer: content must not be shown. server: the team brain's run (server mode),
// which only a new full publish fixes (Phase 2 R15: the bootstrap workflow), never a local build or sync
export class GuardError extends BrainError {
  constructor(store, have, need, server = false) {
    super('rebuild-needed', server
      ? `the team brain's ${store === 'code' ? 'index' : 'github data'} was published before secret masking v${need} (has v${have}) — ask an admin to run the bootstrap (brain-bootstrap.yml)`
      : store === 'code'
        ? `the index was built before secret masking v${need} (has v${have}) — run: brain build <repo>`
        : `github data was stored before secret masking v${need} (has v${have}) — run: brain sync --full`, { store, have, need, server });
  }
}

export class NotImplementedError extends BrainError {
  constructor(name) { super('not-implemented', `not implemented: ${name}`); }
}
