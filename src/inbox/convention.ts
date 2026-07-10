import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

interface DirectoryLock { path: string; token: string; }
function pause(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// The holder's identity lives in the NAME of its single marker file. The marker's
// mtime is the heartbeat and its presence is ownership, so the observed token, the
// staleness clock, and the reclaim gate are one atomic fact.
const MARKER_PREFIX = 'owner.';
function markerPath(path: string, token: string): string { return `${path}/${MARKER_PREFIX}${token}`; }
function observedMarkerToken(path: string): string | null {
  try { return readdirSync(path).find((entry) => entry.startsWith(MARKER_PREFIX))?.slice(MARKER_PREFIX.length) ?? null; } catch { return null; }
}
function ownsLock(lock: DirectoryLock): boolean { return existsSync(markerPath(lock.path, lock.token)); }
function releaseDirectoryLock(lock: DirectoryLock): void { if (ownsLock(lock)) rmSync(lock.path, { recursive: true, force: true }); }
function lockAge(path: string, token: string | null): number {
  const target = token !== null ? markerPath(path, token) : path;
  try { return Date.now() - statSync(existsSync(target) ? target : path).mtimeMs; } catch { return 0; }
}
// Reclamation is bound to the exact instance it observed: it unlinks ONLY that
// token's marker, then removes the now-empty directory with an empty-guarded
// rmdir. A successor lock holds a different random token (a different marker
// name), so a lagging reclaimer that saw the old stale lock can never strip a
// live successor — its unlink targets a name that no longer exists.
function reclaimIfStale(path: string, staleMs: number): void {
  const token = observedMarkerToken(path);
  if (lockAge(path, token) <= staleMs) return;
  if (token !== null) {
    try { unlinkSync(markerPath(path, token)); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  try { rmdirSync(path); } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}
function tryAcquireDirectoryLock(path: string, staleMs: number): DirectoryLock | null {
  const token = randomUUID();
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(markerPath(path, token), '', { flag: 'wx', mode: 0o600 });
    return { path, token };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    reclaimIfStale(path, staleMs);
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
      try { utimesSync(markerPath(lock.path, lock.token), new Date(), new Date()); } catch { /* a reclaimed lock is no longer ours */ }
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
