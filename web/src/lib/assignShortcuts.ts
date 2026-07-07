import type { Interaction } from '@/types';

// Ported near-verbatim from `src/tui/input.ts` (`assignShortcuts` + its
// `RESERVED` set). Why the browser needs its OWN copy of this (not just the
// types): `src/browser/server.ts`'s `GET /api/interaction` always re-reads
// deck.json fresh off disk, and the terminal never persists its
// in-memory-assigned shortcuts back to disk — so the browser only ever sees
// interactions with `shortcut` undefined and must compute the exact same
// letters itself for keyboard-shortcut parity with the terminal deck. This is
// display-only: the response shape always uses `option.id`, never the
// shortcut, so a divergence here would be a UX papercut, not a correctness
// bug — but keep it in sync with `src/tui/input.ts` regardless.
const RESERVED = new Set(['c', 'r', 'n', 'p', 'q', 'j', 'k', 'u', 'd', 'w', ' ']);

/** Mutates `interactions` in place, filling in `option.shortcut` for any
 *  option missing one — same algorithm as the terminal: first free letter
 *  from the option's own label, else the first free digit 1-9. */
export function assignShortcuts(interactions: Interaction[]): void {
  for (const it of interactions) {
    const used = new Set<string>(
      it.options.map((o) => o.shortcut).filter((s): s is string => s !== undefined),
    );
    for (const opt of it.options) {
      if (opt.shortcut !== undefined) continue;
      const letters = [...opt.label.toLowerCase()].filter((c) => /[a-z]/.test(c));
      let chosen: string | undefined;
      for (const letter of letters) {
        if (!used.has(letter) && !RESERVED.has(letter)) { chosen = letter; break; }
      }
      if (chosen === undefined) {
        for (let d = 1; d <= 9; d++) {
          const s = String(d);
          if (!used.has(s)) { chosen = s; break; }
        }
      }
      if (chosen !== undefined) { opt.shortcut = chosen; used.add(chosen); }
    }
  }
}
