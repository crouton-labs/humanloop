import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Deck, ReviewDescriptor, TicketSummary } from '../types.js';
import { claimPath, deckPath, isResolved, readJson, reviewPath } from './convention.js';
import { validateDeck, validateReviewDescriptor } from './deck-schema.js';
import { listInboxRoots } from './registry.js';

function claimSummary(dir: string): TicketSummary['claim'] {
  const claim = readJson<{ host?: unknown; claimedAt?: unknown; heartbeatAt?: unknown }>(claimPath(dir));
  if (claim === null || typeof claim.host !== 'string' || typeof claim.claimedAt !== 'string' || typeof claim.heartbeatAt !== 'string') return undefined;
  return { owner: claim.host, claimedAt: claim.claimedAt, heartbeatAt: claim.heartbeatAt };
}

function deckSummary(dir: string, id: string): TicketSummary | null {
  const raw = readJson<unknown>(deckPath(dir));
  if (raw === null) return null;
  let deck: Deck;
  try { deck = validateDeck(raw); } catch { return null; }
  const first = deck.interactions[0];
  if (first === undefined) return null;
  let blockedSince = deck.source?.blockedSince;
  if (blockedSince === undefined) {
    try { blockedSince = statSync(deckPath(dir)).mtime.toISOString(); } catch { return null; }
  }
  return { dir, id, kind: 'deck', title: deck.title, subtitle: first.subtitle, interactionKind: first.kind, source: deck.source ?? {}, blockedSince, claim: claimSummary(dir) };
}

function reviewSummary(dir: string, id: string): TicketSummary | null {
  const raw = readJson<unknown>(reviewPath(dir));
  if (raw === null) return null;
  let review: ReviewDescriptor;
  try { review = validateReviewDescriptor(raw); } catch { return null; }
  return { dir, id, kind: 'review', title: review.title, file: review.file, output: review.output, source: review.source, blockedSince: review.blockedSince, claim: claimSummary(dir) };
}

/** Read all unresolved deck/review tickets, newest first. Progress never affects visibility. */
export function scanInbox(roots?: string[]): TicketSummary[] {
  const selectedRoots = roots ?? listInboxRoots().filter((root) => root.available).map((root) => root.root);
  const seen = new Set<string>();
  const items: TicketSummary[] = [];
  for (const root of selectedRoots) {
    let canonicalRoot: string;
    try { canonicalRoot = realpathSync(root); } catch { continue; }
    let entries: string[];
    try { entries = readdirSync(canonicalRoot); } catch { continue; }
    for (const entry of entries) {
      const dir = resolve(canonicalRoot, entry);
      let canonicalDir: string;
      try { if (!statSync(dir).isDirectory()) continue; canonicalDir = realpathSync(dir); } catch { continue; }
      if (resolve(canonicalDir, '..') !== canonicalRoot || seen.has(canonicalDir) || isResolved(canonicalDir)) continue;
      seen.add(canonicalDir);
      const item = deckSummary(canonicalDir, basename(canonicalDir)) ?? reviewSummary(canonicalDir, basename(canonicalDir));
      if (item !== null) items.push(item);
    }
  }
  return items.sort((a, b) => b.blockedSince.localeCompare(a.blockedSince) || a.id.localeCompare(b.id));
}
