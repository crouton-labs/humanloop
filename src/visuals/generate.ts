import { query } from '@r-cli/sdk';
import type { Interaction } from '../types.js';
import { renderMarkdown } from '../render/termrender.js';

const VISUAL_SYSTEM_PROMPT = `You are re-grounding a decision-maker in the moment before they answer the question below. They were deep in this problem but got pulled away; in the next 20 seconds they need to remember *what is actually in play* — the current state, the files, the constraint this decision lives inside — so the question stops feeling cold and they can answer with confidence.

Write from the conversation history you're given. Lead with what *is*: the real files, functions, data, and constraints that ground this decision, named concretely (as \`path/to/file.ts:123\` so they can jump straight there). Reconstruct just enough of how they arrived here to make the question legible — no more.

Keep it tight: usually a short paragraph or a few bullets, 30 lines hard cap. Say less when less is true. Choose whatever shape carries the meaning fastest — prose by default, a list when enumerating, a table only to compare several things across the same dimensions, a small diagram when the structure itself is the point. You're trusted to pick; don't force a format.

The one rule that matters: **only reference files, identifiers, and facts that actually appear in the conversation.** Never invent a plausible-looking path or name. If the conversation is thin, write a short honest briefing about what little is grounded — that beats confident fabrication every time.

And stay in your lane: don't restate the question, don't recommend an option or tell them how to decide, don't lay out tradeoffs or sketch alternatives. They own the decision; you only reconstruct the ground it stands on.

Formatting: plain markdown renders (**bold**, *italic*, \`code\`, bullets, and GFM tables). These termrender directives are available if one genuinely helps — anything you draw with box-drawing/ASCII must sit inside a :::panel or it will be reflowed and destroyed:
  :::panel{title="T" color="cyan"}                bordered box (red|green|yellow|blue|magenta|cyan|white|gray)
  :::tree{color="c"}                              indented hierarchy (2-space indent = nesting)
  :::callout{type="info|warning|error|success"}   status callout
  ::::columns / :::col{width="50%"}               side-by-side (outer fence needs strictly more colons)
Never wrap the whole output in a code fence.`;

async function callHaiku(prompt: string, systemPrompt: string): Promise<string | null> {
  try {
    const session = await query({
      prompt,
      options: {
        model: 'haiku',
        maxTurns: 1,
        systemPrompt,
      },
    });

    let text = '';
    for await (const msg of session) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
        }
      }
    }

    return text.trim() || null;
  } catch (err) {
    process.stderr.write(`[hl] Haiku call failed: ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

// The mounting surface supplies its actual render width; generated ANSI must
// fit an embedded panel just as it fits a standalone terminal.
// Cap on how much conversation we hand the generator. Recency is what grounds
// the decision in front of the human, so when history is long we keep the tail
// (most recent messages) rather than the head.
const MAX_CONTEXT_CHARS = 24000;

export async function defaultGenerateVisual(interaction: Interaction, conversationContext: string, cols = (process.stdout.columns || 80)): Promise<{ ok: true; ansi: string; markdown: string } | { ok: false; error: string }> {
  const width = Math.max(1, Math.min(cols - 4, 76));

  const optionsSummary = interaction.options.length > 0
    ? `\nOptions: ${interaction.options.map((o) => o.label).join(' | ')}`
    : '';
  const subtitleLine = interaction.subtitle ? `\nContext: ${interaction.subtitle}` : '';
  // The body is the richest statement of what's being asked — hand it to the
  // generator so the briefing grounds in the actual question, not just its title.
  const bodyLine = interaction.body ? `\nDetail:\n${interaction.body}` : '';
  const questionText = `Title: "${interaction.title}"${subtitleLine}${bodyLine}${optionsSummary}`;

  const trimmedContext = conversationContext.length > MAX_CONTEXT_CHARS
    ? `…(earlier conversation trimmed)…\n\n${conversationContext.slice(-MAX_CONTEXT_CHARS)}`
    : conversationContext;

  const prompt = trimmedContext
    ? `Here is the conversation so far:\n\n${trimmedContext}\n\n---\n\nThe human is about to answer this decision. Re-ground them in what's in play:\n\n${questionText}`
    : `The human is about to answer this decision. Re-ground them in what's in play:\n\n${questionText}`;

  const result = await callHaiku(prompt, VISUAL_SYSTEM_PROMPT);

  if (result) {
    const markdown = result
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```\s*$/gm, '')
      .trim();
    const ansi = renderMarkdown(markdown, width).join('\n');
    return { ok: true, ansi, markdown };
  }
  return { ok: false, error: 'haiku returned no output' };
}
