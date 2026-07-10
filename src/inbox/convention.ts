import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Deck, InteractionResponse } from '../types.js';
import { buildSummary } from '../summary.js';

export function deckPath(dir: string): string { return `${dir}/deck.json`; }
export function reviewPath(dir: string): string { return `${dir}/review.json`; }
export function responsePath(dir: string): string { return `${dir}/response.json`; }
export function progressPath(dir: string): string { return `${dir}/progress.json`; }
export function claimPath(dir: string): string { return `${dir}/claim.json`; }
export function deliveryPath(dir: string): string { return `${dir}/delivery.json`; }
export function deliveryErrorPath(dir: string): string { return `${dir}/delivery-error.json`; }
export function visualsDir(dir: string): string { return `${dir}/visuals`; }
export function visualMdPath(dir: string, id: string): string { return `${dir}/visuals/${id}.md`; }
export function visualAnsiPath(dir: string, id: string): string { return `${dir}/visuals/${id}.ansi`; }

export type InteractionState = 'pending' | 'claimed' | 'resolved' | 'missing';

export function interactionState(dir: string): InteractionState {
  if (!existsSync(deckPath(dir)) && !existsSync(reviewPath(dir))) return 'missing';
  if (existsSync(responsePath(dir))) return 'resolved';
  return existsSync(claimPath(dir)) ? 'claimed' : 'pending';
}

export function isResolved(dir: string): boolean { return existsSync(responsePath(dir)); }
export function isClaimed(dir: string): boolean { return existsSync(claimPath(dir)); }

export function stampCanvasNode(deck: Deck): void {
  const id = process.env['CRTR_NODE_ID'];
  if (id === undefined || id.trim() === '' || deck.source?.nodeId) return;
  deck.source = { ...(deck.source ?? {}), nodeId: id };
}

export function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

interface LockOwner { token: string; }
interface DirectoryLock { path: string; token: string; }
function pause(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lockOwnerPath(path: string): string { return `${path}/owner.json`; }
function lockHeartbeatPath(path: string): string { return `${path}/heartbeat`; }
function ownsLock(lock: DirectoryLock): boolean { return readJson<LockOwner>(lockOwnerPath(lock.path))?.token === lock.token; }
function releaseDirectoryLock(lock: DirectoryLock): void { if (ownsLock(lock)) rmSync(lock.path, { recursive: true, force: true }); }
function lockAge(path: string): number {
  try { return Date.now() - statSync(existsSync(lockHeartbeatPath(path)) ? lockHeartbeatPath(path) : path).mtimeMs; } catch { return 0; }
}
function tryAcquireDirectoryLock(path: string, staleMs: number): DirectoryLock | null {
  const token = randomUUID();
  try {
    mkdirSync(path, { mode: 0o700 });
    // A lock owner never changes. Heartbeats are a separate non-destructive lease file.
    writeFileSync(lockOwnerPath(path), `${JSON.stringify({ token })}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(lockHeartbeatPath(path), '', { flag: 'wx', mode: 0o600 });
    return { path, token };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A just-created directory without owner.json is initializing, not stale.
    if (lockAge(path) > staleMs) rmSync(path, { recursive: true, force: true });
    return null;
  }
}
function acquireDirectoryLock(path: string, staleMs: number, timeoutMs: number): DirectoryLock {
  const startedAt = Date.now();
  while (true) {
    const lock = tryAcquireDirectoryLock(path, staleMs);
    if (lock !== null) return lock;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('exclusive operation lock acquisition timed out');
    pause(5);
  }
}
async function acquireDirectoryLockAsync(path: string, staleMs: number, timeoutMs: number): Promise<DirectoryLock> {
  const startedAt = Date.now();
  while (true) {
    const lock = tryAcquireDirectoryLock(path, staleMs);
    if (lock !== null) return lock;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('exclusive operation lock acquisition timed out');
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

/** Runs a short filesystem transition under a token-checked, crash-reclaimable directory lock. */
export function withExclusiveDirectoryLock<T>(path: string, operation: () => T, options: { staleMs?: number; timeoutMs?: number } = {}): T {
  const lock = acquireDirectoryLock(path, options.staleMs ?? 30_000, options.timeoutMs ?? 5_000);
  try { return operation(); } finally { releaseDirectoryLock(lock); }
}

/** Async counterpart heartbeats while its operation runs, so a valid long handler is never stolen. */
export async function withExclusiveDirectoryLockAsync<T>(path: string, operation: () => Promise<T>, options: { staleMs?: number; timeoutMs?: number } = {}): Promise<T> {
  const staleMs = options.staleMs ?? 35_000;
  const lock = await acquireDirectoryLockAsync(path, staleMs, options.timeoutMs ?? staleMs + 5_000);
  const heartbeat = setInterval(() => {
    if (ownsLock(lock)) {
      try { utimesSync(lockHeartbeatPath(lock.path), new Date(), new Date()); } catch { /* a reclaimed lock is no longer ours */ }
    }
  }, 1_000);
  try { return await operation(); } finally { clearInterval(heartbeat); releaseDirectoryLock(lock); }
}

// Kept for the existing panel until H2 routes all finalization through tickets.ts.
export function writeResponse(dir: string, responses: InteractionResponse[], completedAt: string, deck?: Deck): string {
  const summary = deck === undefined ? '' : buildSummary(deck, responses);
  atomicWriteJson(responsePath(dir), { schema: 'humanloop.response/v2', kind: 'deck', responses, summary, completedAt });
  return responsePath(dir);
}

export function writeProgress(dir: string, responses: InteractionResponse[]): void {
  atomicWriteJson(progressPath(dir), { kind: 'deck', responses, savedAt: new Date().toISOString() });
}

export function clearProgress(dir: string): void {
  try { unlinkSync(progressPath(dir)); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
