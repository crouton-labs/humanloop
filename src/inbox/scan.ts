import { readdirSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import type { InboxItem, Deck } from '../types.js';
import { deckPath, isResolved, isClaimed, readJson } from './convention.js';

// ── scanInbox ─────────────────────────────────────────────────────────────────

export function scanInbox(roots: string[]): InboxItem[] {
  const items: InboxItem[] = [];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // root doesn't exist or isn't readable — skip silently
      continue;
    }

    for (const entry of entries) {
      const dir = resolve(root, entry);

      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Skip resolved or actively claimed dirs
      if (isResolved(dir) || isClaimed(dir)) continue;

      const dp = deckPath(dir);
      const deck = readJson<Deck>(dp);
      if (deck === null) continue;

      // Derive blockedSince: prefer deck.source.blockedSince, fall back to mtime
      let blockedSince: string;
      if (deck.source?.blockedSince !== undefined) {
        blockedSince = deck.source.blockedSince;
      } else {
        try {
          blockedSince = new Date(statSync(dp).mtime).toISOString();
        } catch {
          blockedSince = new Date().toISOString();
        }
      }

      const firstInteraction = deck.interactions[0];

      const item: InboxItem = {
        dir,
        id: firstInteraction?.id ?? basename(dir),
        title: deck.title ?? firstInteraction?.title,
        subtitle: firstInteraction?.subtitle,
        kind: firstInteraction?.kind,
        source: deck.source,
        blockedSince,
      };

      items.push(item);
    }
  }

  // Sort ascending by blockedSince (ISO string compare is monotonic)
  items.sort((a, b) => (a.blockedSince < b.blockedSince ? -1 : a.blockedSince > b.blockedSince ? 1 : 0));

  return items;
}
