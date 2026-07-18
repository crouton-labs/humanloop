import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompletionEvent } from '../types.js';
import { atomicWriteJson, readJson, withExclusiveDirectoryLock } from './convention.js';

export interface CompletionHandler { command: string; args: string[]; }
export interface InboxRootRegistration { schema: 'humanloop.inbox-root/v1'; root: string; owner: string; handler?: CompletionHandler; followUpHandler?: CompletionHandler; visualHandler?: CompletionHandler; }
export interface InboxRootStatus extends InboxRootRegistration { available: boolean; }
export interface RegisterInboxRootOptions { root: string; owner: string; handler?: CompletionHandler; followUpHandler?: CompletionHandler; visualHandler?: CompletionHandler; }

function stateHome(): string { return process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'); }
export function inboxRootsDirectory(): string { return join(stateHome(), 'humanloop', 'inbox-roots'); }
function recordPath(root: string): string { return join(inboxRootsDirectory(), createHash('sha256').update(root).digest('hex')); }
function canonicalRoot(root: string): string { try { return realpathSync(root); } catch { return resolve(root); } }

function validateHandler(handler: CompletionHandler | undefined): CompletionHandler | undefined {
  if (handler === undefined) return undefined;
  if (typeof handler.command !== 'string' || handler.command.trim() === '' || !Array.isArray(handler.args) || !handler.args.every((arg) => typeof arg === 'string')) throw new Error('handler requires a non-empty command and string args');
  return { command: handler.command, args: [...handler.args] };
}

function validateRegistration(raw: unknown): InboxRootRegistration | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'humanloop.inbox-root/v1' || typeof value.root !== 'string' || !value.root || typeof value.owner !== 'string' || !value.owner.trim()) return null;
  try {
    return {
      schema: 'humanloop.inbox-root/v1', root: value.root, owner: value.owner,
      handler: value.handler === undefined ? undefined : validateHandler(value.handler as CompletionHandler),
      followUpHandler: value.followUpHandler === undefined ? undefined : validateHandler(value.followUpHandler as CompletionHandler),
      visualHandler: value.visualHandler === undefined ? undefined : validateHandler(value.visualHandler as CompletionHandler),
    };
  } catch { return null; }
}

/** Create/canonicalize a root and claim its user-scoped registration. */
export function registerInboxRoot(opts: RegisterInboxRootOptions): InboxRootRegistration {
  if (!opts.owner.trim()) throw new Error('inbox root owner must be non-empty');
  mkdirSync(resolve(opts.root), { recursive: true, mode: 0o700 });
  const root = realpathSync(opts.root);
  const path = recordPath(root);
  mkdirSync(inboxRootsDirectory(), { recursive: true, mode: 0o700 });
  return withExclusiveDirectoryLock(`${path}.lock`, () => {
    const existing = validateRegistration(readJson<unknown>(path));
    if (existing !== null && existing.root === root && existing.owner !== opts.owner) throw new Error(`inbox root is already owned by ${existing.owner}`);
    if (existing !== null && existing.root !== root) throw new Error('inbox root registry hash collision');
    const registration: InboxRootRegistration = { schema: 'humanloop.inbox-root/v1', root, owner: opts.owner, handler: validateHandler(opts.handler), followUpHandler: validateHandler(opts.followUpHandler), visualHandler: validateHandler(opts.visualHandler) };
    atomicWriteJson(path, registration);
    chmodSync(path, 0o600);
    return registration;
  });
}

/** Removes a matching available root through its real path, or an unavailable record by its stored canonical path. */
export function unregisterInboxRoot(root: string, owner: string): boolean {
  const canonical = canonicalRoot(root);
  const path = recordPath(canonical);
  return withExclusiveDirectoryLock(`${path}.lock`, () => {
    const existing = validateRegistration(readJson<unknown>(path));
    if (existing === null || existing.root !== canonical || existing.owner !== owner) return false;
    unlinkSync(path);
    return true;
  });
}

export function listInboxRoots(): InboxRootStatus[] {
  let files: string[];
  try { files = readdirSync(inboxRootsDirectory()); } catch { return []; }
  const roots: InboxRootStatus[] = [];
  for (const file of files) {
    const record = validateRegistration(readJson<unknown>(join(inboxRootsDirectory(), file)));
    if (record !== null) roots.push({ ...record, available: existsSync(record.root) });
  }
  return roots.sort((a, b) => a.root.localeCompare(b.root));
}

export function registeredInboxRoot(root: string): InboxRootRegistration | null {
  let canonical: string;
  try { canonical = realpathSync(root); } catch { return null; }
  const record = validateRegistration(readJson<unknown>(recordPath(canonical)));
  return record?.root === canonical ? record : null;
}

/** The managed SDK root is durable, user-scoped, and owned by humanloop. */
export function managedInboxRoot(): InboxRootRegistration {
  return registerInboxRoot({ root: join(stateHome(), 'humanloop', 'inbox'), owner: 'humanloop' });
}

export type CompletionHandlerEvent = CompletionEvent;
