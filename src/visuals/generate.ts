import { query } from '@r-cli/sdk';
import { execSync } from 'child_process';
import type { Interaction } from '../types.js';

const VISUAL_SYSTEM_PROMPT = `You're briefing a CTO-level engineer in the 30 seconds before they decide. They've been off this problem for days; they need a fast re-ground in what *already exists* — the files, data flow, or constraint they're deciding inside of — not a lecture on tradeoffs.

# Length

Target 15–25 lines. Hard cap 30. A tight paragraph with two file refs is often perfect — don't pad.

# What to write

Lead with *what is*, not *what could be*. Name the actual files, functions, tables, or data structures in play. Reference them as \`path/to/file.ts:123\` so they can jump to it. Skip preamble. Skip "here are the tradeoffs." Skip explaining the alternative — they're deciding, they know the alternative exists.

If one sentence captures the current state, write one sentence. If they need to see a flow, draw it. If they need to compare 3+ options across same dimensions, use a table. Don't reach for a directive unless it genuinely clarifies — plain prose + bullet lists is the default.

# Directives (termrender-flavored markdown)

  :::panel{title="T" color="c"}                 Bordered box (colors: red|green|yellow|blue|magenta|cyan|white|gray)
  :::tree{color="c"}                            Indented hierarchy (2-space indent = nesting)
  :::callout{type="info|warning|error|success"} Status callout with icon
  ::::columns / :::col{width="50%"}             Side-by-side layout (use 4 colons on the outer columns)

Each opens with ::: and closes with :::. GFM tables (\`| col | col |\` with a \`| --- |\` separator) render directly — no directive needed. Standard markdown also works: **bold**, *italic*, \`code\`, bullets.

# Critical: ASCII art must live inside a :::panel

Plain text outside directives gets reflowed — box-drawing will be destroyed. If you draw a flow diagram or ASCII box, wrap it in \`:::panel\` to preserve it verbatim.

# Grounding — the single most important rule

**Only name files, functions, variables, or patterns that actually appear in the conversation history provided.** Do not invent plausible-sounding file paths, class names, or dependencies. If the conversation doesn't ground a fact, don't assert it. When in doubt, speak at a higher level of abstraction ("the state file," "the render loop") rather than making up a specific identifier.

If the conversation doesn't contain enough context to write a grounded briefing, write a very short briefing that honestly reflects what little is known — a one-paragraph summary is better than a confident fabrication.

# Hard rules

- When nesting directives, the outer fence needs strictly more colons than the inner — e.g. \`::::columns\` wrapping \`:::col\`. Don't nest a panel inside a panel.
- Never wrap output in backtick fences
- Never repeat the question/statement text
- Never write "tradeoffs to consider" or "here are some options"
- Never describe an alternative architecture — just describe the current one
- Never recommend an option or tell the user how to decide. They are the decider. You describe.
- Never ask the user a question back. You are producing a briefing, not a conversation.
- Do NOT use these section headings: **Recommendation:**, **Decide by:**, **Trade-off:**, **Why it matters:**, **What you're locking in:**. These invite editorializing. Use neutral labels like **Current state:**, **Constraint:**, or none at all.
- 30 lines maximum`;

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

function renderWithTermrender(markdown: string, width: number): string {
  // First attempt
  const result = tryTermrender(markdown, width);
  if (result !== null) return result;

  // Fallback: strip all directives and render as plain markdown
  const stripped = markdown.replace(/^:{3,}\w*.*$/gm, '').trim();
  const fallback = tryTermrender(stripped, width);
  return fallback ?? markdown;
}

function tryTermrender(markdown: string, width: number): string | null {
  try {
    return execSync(`termrender -w ${width}`, {
      input: markdown,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERMRENDER_COLOR: '1' },
    }).trimEnd();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || '';
    process.stderr.write(`[hl] termrender: ${stderr.split('\n')[0]}\n`);
    return null;
  }
}

// defaultGenerateVisual matches the GenerateVisual contract for use with
// mountPanel. Width is read from process.stdout.columns so callers that
// embed humanloop in a sub-region should supply their own closure that bakes
// in the correct width.
export async function defaultGenerateVisual(interaction: Interaction, conversationContext: string): Promise<{ ok: true; ansi: string; markdown: string } | { ok: false; error: string }> {
  const width = Math.max(40, Math.min((process.stdout.columns || 80) - 4, 76));

  const optionsSummary = interaction.options.length > 0
    ? `\nOptions: ${interaction.options.map((o) => o.label).join(' | ')}`
    : '';
  const subtitleLine = interaction.subtitle ? `\nContext: ${interaction.subtitle}` : '';
  const questionText = `Title: "${interaction.title}"${subtitleLine}${optionsSummary}`;

  const prompt = conversationContext
    ? `Here is the conversation so far:\n\n${conversationContext}\n\n---\n\nGenerate a visual context block for this decision point:\n\n${questionText}`
    : `Generate a visual context block for this decision point:\n\n${questionText}`;

  const result = await callHaiku(prompt, VISUAL_SYSTEM_PROMPT);

  if (result) {
    const markdown = result
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```\s*$/gm, '')
      .trim();
    const ansi = renderWithTermrender(markdown, width);
    return { ok: true, ansi, markdown };
  }
  return { ok: false, error: 'haiku returned no output' };
}
