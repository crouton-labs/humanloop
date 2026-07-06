import { existsSync, statSync, writeFileSync, renameSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Deck, InteractionResponse } from '../types.js';
import { buildSummary } from '../summary.js';

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

// ── Canvas-node attribution ─────────────────────────────────────────

/**
 * Stamp the originating canvas node id onto a deck's `source` so per-node
 * attention scoping (crouter's nav chrome) can attribute the ask to the node
 * that raised it rather than every sibling node sharing the same cwd.
 *
 * No-op when not inside a canvas node (CRTR_NODE_ID unset) or when the deck
 * already carries a nodeId. Mutates `deck` in place.
 */
export function stampCanvasNode(deck: Deck): void {
  const id = process.env['CRTR_NODE_ID'];
  if (id === undefined || id.trim() === '') return;
  if (deck.source?.nodeId != null && deck.source.nodeId !== '') return;
  deck.source = { ...(deck.source ?? {}), nodeId: id };
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
  deck?: Deck,
): string {
  const p = responsePath(dir);
  // Persist the deterministic summary alongside the raw responses so
  // `hl job result` can return a populated summary without re-deriving it (or
  // silently emitting ''). When the deck is known at write time we compute it
  // here; the deck is deterministic input so this never diverges from ask()'s
  // envelope summary.
  const summary = deck !== undefined ? buildSummary(deck, responses) : '';
  atomicWriteJson(p, { responses, completedAt, summary });
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
