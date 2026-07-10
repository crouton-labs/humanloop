import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
