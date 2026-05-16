import { existsSync, statSync, writeFileSync, renameSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { InteractionResponse } from '../types.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

export function deckPath(dir: string): string {
  return `${dir}/deck.json`;
}

export function responsePath(dir: string): string {
  return `${dir}/response.json`;
}

export function progressPath(dir: string): string {
  return `${dir}/progress.json`;
}

export function visualsDir(dir: string): string {
  return `${dir}/visuals`;
}

export function visualMdPath(dir: string, id: string): string {
  return `${dir}/visuals/${id}.md`;
}

export function visualAnsiPath(dir: string, id: string): string {
  return `${dir}/visuals/${id}.ansi`;
}

// ── State predicates ──────────────────────────────────────────────────────────

export type InteractionState = 'pending' | 'in-progress' | 'resolved' | 'missing';

export function interactionState(dir: string): InteractionState {
  const hasDeck = existsSync(deckPath(dir));
  const hasResponse = existsSync(responsePath(dir));
  const hasProgress = existsSync(progressPath(dir));

  if (!hasDeck) return 'missing';
  if (hasResponse) return 'resolved';
  if (hasProgress) return 'in-progress';
  return 'pending';
}

export function isResolved(dir: string): boolean {
  return existsSync(responsePath(dir));
}

/** Returns true if a live resolver owns this dir (progress.json mtime < 300s). */
export function isClaimed(dir: string): boolean {
  const p = progressPath(dir);
  if (!existsSync(p)) return false;
  try {
    const { mtimeMs } = statSync(p);
    return Date.now() - mtimeMs < 300_000;
  } catch {
    return false;
  }
}

// ── Atomic I/O ────────────────────────────────────────────────────────────────

export function atomicWriteJson(path: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2);
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ── High-level write helpers ──────────────────────────────────────────────────

export function writeResponse(
  dir: string,
  responses: InteractionResponse[],
  completedAt: string,
): string {
  const p = responsePath(dir);
  atomicWriteJson(p, { responses, completedAt });
  return p;
}

export function writeProgress(dir: string, responses: InteractionResponse[]): void {
  atomicWriteJson(progressPath(dir), {
    partial: true,
    responses,
    savedAt: new Date().toISOString(),
  });
}

export function clearProgress(dir: string): void {
  try {
    unlinkSync(progressPath(dir));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
