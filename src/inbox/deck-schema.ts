import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { INTERACTION_KINDS } from '../types.js';
import type { Deck } from '../types.js';
import { checkMarkdown } from '../render/termrender.js';

// ── zod v4 building blocks ────────────────────────────────────────────────────
// v4 notes: .nonempty() → .min(1); error messages use {error: 'string'} per check.

export const interactionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  // No author-settable `shortcut`: option shortcuts are auto-assigned by the
  // TUI (assignShortcuts). zod strips unknown keys, so any author-supplied
  // `shortcut` is silently dropped here — this is the enforcement boundary that
  // stops a deck from shadowing a reserved key (e.g. `c` = comment).
});

export const preAnswerSchema = z.object({
  selectedOptionId: z.string().optional(),
  selectedOptionIds: z.array(z.string()).optional(),
  freetext: z.string().optional(),
  label: z.string().optional(),
});

const interactionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, { error: 'interaction id must match /^[A-Za-z0-9_-]+$/' }).min(1).max(64),
  title: z.string().min(1, { error: 'title must be non-empty' }),
  subtitle: z.string().min(1, { error: 'subtitle must be non-empty when present' }).optional(),
  body: z.string().optional(),
  bodyPath: z.string().optional(),
  options: z.array(interactionOptionSchema),
  multiSelect: z.boolean().optional(),
  allowFreetext: z.boolean().optional(),
  freetextLabel: z.string().optional(),
  kind: z.enum(INTERACTION_KINDS).optional(),
  preAnswered: preAnswerSchema.optional(),
});

const deckSourceSchema = z.object({
  sessionName: z.string().optional(),
  askedBy: z.string().optional(),
  blockedSince: z.string().optional(),
  nodeId: z.string().optional(),
});

export const deckSchema = z.object({
  title: z.string().optional(),
  source: deckSourceSchema.optional(),
  interactions: z.array(interactionSchema).min(1, { error: 'interactions[] must be non-empty' }),
}).superRefine((input, ctx) => {
  const seen = new Map<string, number>();
  for (let i = 0; i < input.interactions.length; i++) {
    const interaction = input.interactions[i];
    if (interaction.body !== undefined && interaction.bodyPath !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'body and bodyPath are mutually exclusive',
        path: ['interactions', i],
      });
    }
    const prev = seen.get(interaction.id);
    if (prev !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate interaction id "${interaction.id}" at indices ${prev} and ${i}`,
        path: ['interactions', i, 'id'],
      });
    }
    seen.set(interaction.id, i);
  }
});

// ── C2 bodyPath defense + inlining ────────────────────────────────────────────

/**
 * Read `bodyPath` (relative to `dir`, the interaction directory a deck.json
 * lives/will live in) with the traversal/symlink defenses a file read off an
 * agent-supplied relative path needs.
 */
function readBodyPathFile(dir: string, bodyPath: string): string {
  const joined = resolve(dir, bodyPath);

  // STEP 1: existence + lstat BEFORE realpath to catch symlinks and directories.
  if (!existsSync(joined)) {
    throw new Error(
      `bodyPath does not exist: '${bodyPath}' (resolved against deck dir '${dir}'). bodyPath is interpreted relative to the deck JSON's directory; place the body file there and use a relative path (e.g. "completion-summary.md").`,
    );
  }
  const stat = lstatSync(joined);
  if (!stat.isFile()) {
    // Catches symlinks, directories, FIFOs — lstat does not follow symlinks.
    throw new Error(`bodyPath must be a regular file (not a symlink, directory, or special file): ${bodyPath}`);
  }

  // STEP 2: realpath both sides, prefix-check (defense-in-depth for .. traversal).
  // realpathSync is safe here: lstat already confirmed the path exists.
  const realResolved = realpathSync(joined);
  const realDeckDir = realpathSync(dir);
  const prefix = realDeckDir + sep;
  if (realResolved !== realDeckDir && !realResolved.startsWith(prefix)) {
    throw new Error(
      `bodyPath '${bodyPath}' escapes the deck's directory ('${realDeckDir}'). bodyPath is resolved relative to the deck JSON file and must stay inside its directory (no '..', absolute paths pointing elsewhere, or symlinks out). Fix: write the deck JSON next to the body file (e.g. both inside $SISYPHUS_SESSION_DIR/context/) and use a relative path like "completion-summary.md".`,
    );
  }

  // STEP 3: read. lstat confirmed regular file; realpath confirmed in-tree.
  return readFileSync(joined, 'utf-8');
}

/**
 * The ONE canonical `bodyPath` → `body` normalization boundary. Resolves every
 * interaction's `bodyPath` (relative to `dir`, the interaction directory) into
 * `body` and strips `bodyPath` from the result.
 *
 * Call this once, right before a deck is (re)written to `<dir>/deck.json` —
 * `hl deck ask`, `hl deck update`, and the public `ask()` API all do — so
 * every reader downstream (the terminal TUI's render + its live-reload
 * poller, the browser server's `/api/interaction`) only ever sees a plain
 * `body` and never has to special-case `bodyPath` itself. `parseDeck` (below)
 * reuses this same function when reading a deck straight off disk.
 */
export function resolveDeckBodyPaths(deck: Deck, dir: string): Deck {
  const interactions = deck.interactions.map((interaction) => {
    if (interaction.bodyPath === undefined) return interaction;
    const body = readBodyPathFile(dir, interaction.bodyPath);
    // Drop bodyPath from persisted deck.json/decisions.json (recipe §1.8).
    const { bodyPath: _drop, ...rest } = interaction;
    return { ...rest, body };
  });
  return { ...deck, interactions };
}

// ── public entry points ───────────────────────────────────────────────────────
export function parseDeck(deckPath: string): Deck {
  const raw = readFileSync(deckPath, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('deck is not valid JSON');
  }

  const parsed = deckSchema.parse(json);
  const resolved = resolveDeckBodyPaths(parsed, dirname(deckPath));

  for (const interaction of resolved.interactions) {
    if (interaction.body !== undefined) {
      const check = checkMarkdown(interaction.body);
      if (!check.ok) {
        throw new Error(check.error);
      }
    }
  }

  return resolved;
}

export function validateDeck(parsed: unknown): Deck {
  return deckSchema.parse(parsed) as Deck;
}
