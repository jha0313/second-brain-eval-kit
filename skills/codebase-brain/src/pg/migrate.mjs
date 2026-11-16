// migration runner (Q1). Lane A owns this file. Q0 STUB: the signature below is the contract.
// Applies sql/NNN_*.sql in order, each once, as the owner (neondb_owner). Passwords never live in sql/: after
// 002_roles.sql the runner sets them with ALTER ROLE ... PASSWORD from opts.passwordFile. Never prints a URL or password.
import { NotImplementedError } from '../errors.mjs';

/**
 * @param {string} ownerUrl owner connection string (command-line argument only, design §6.2)
 * @param {{ passwordFile?: string, log?: (s: string) => void }} [opts]
 *   passwordFile: JSON { "brain_writer": "...", "brain_reader": "..." }, mode 0600
 * @returns {Promise<{ applied: string[] }>} file names applied by this call
 */
export async function migrate(_ownerUrl, _opts = {}) { throw new NotImplementedError('pg.migrate'); }
