import type { Deck, InteractionResponse } from './types.js';

/**
 * Deterministic, no-LLM resolution summary — one line per answered
 * interaction: `"<title>: <option label>[ — <freetext>]"`. Shared by `ask()`
 * (envelope summary) and `writeResponse` (persisted into response.json at write
 * time).
 */
export function buildSummary(deck: Deck, responses: InteractionResponse[]): string {
  const byId = new Map(responses.map((r) => [r.id, r] as const));
  const lines: string[] = [];
  for (const it of deck.interactions) {
    const r = byId.get(it.id);
    if (r === undefined) continue;
    const ft = r.freetext !== undefined && r.freetext !== '' ? r.freetext : undefined;
    let picked: string | undefined;
    if (r.selectedOptionIds !== undefined) {
      const oc = r.optionComments;
      const parts = r.selectedOptionIds
        .map((id) => it.options.find((o) => o.id === id))
        .filter((o): o is NonNullable<typeof o> => o !== undefined)
        .map((o) => {
          const note = oc !== undefined ? oc[o.id] : undefined;
          return typeof note === 'string' && note.length > 0
            ? `${o.label} ("${note}")`
            : o.label;
        });
      picked = parts.length > 0 ? parts.join(', ') : undefined;
    } else if (r.selectedOptionId !== undefined) {
      picked = it.options.find((o) => o.id === r.selectedOptionId)?.label;
    }
    let val: string;
    if (picked !== undefined && ft !== undefined) val = `${picked} — ${ft}`;
    else if (picked !== undefined) val = picked;
    else if (ft !== undefined) val = ft;
    else val = '(skipped)';
    lines.push(`${it.title}: ${val}`);
  }
  return lines.join('\n');
}
