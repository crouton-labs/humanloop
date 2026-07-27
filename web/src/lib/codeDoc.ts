import type { AnchorUnit } from './anchorUnits';
import type { SourceMap } from './sourceMap';

// ── Source files as review documents (browser side) ──────────────────────────
//
// A review may point at a source file rather than a .md artifact. The browser
// renders it by wrapping the source in a single fenced code block, so
// rehype-highlight syntax-highlights it and every existing markdown path
// (source spans, anchor units, comment highlighting) keeps working unchanged.
//
// The wrapper costs one line: source line N is line N+1 of the rendered
// document. Byte offsets stay WRAPPED-document offsets — that is what the
// rendered DOM spans carry — while line numbers are folded back onto real
// SOURCE lines, so every FeedbackComment records the file's own line numbers.
// The server-side counterpart is `src/render/code-doc.ts`.

/** Wrap source text as a fenced block, growing the fence past the longest
 *  backtick run so a file containing ``` cannot close its own block. */
export function codeFenceDocument(content: string, language: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  return `${fence}${language}\n${body}\n${fence}\n`;
}

/** Renumber a wrapped-source map onto source lines: drop the opening-fence
 *  line and everything past the last source line (the closing fence). */
export function foldFenceSourceMap(map: SourceMap, sourceLineCount: number): SourceMap {
  const lines = map.lines
    .slice(1, 1 + sourceLineCount)
    .map((line, index) => ({ ...line, line: index + 1 }));
  return { content: map.content, lines, totalBytes: map.totalBytes };
}

/** Same fold for anchor units, dropping any unit that covered fence chrome. */
export function foldFenceUnits(units: AnchorUnit[], sourceLineCount: number): AnchorUnit[] {
  const folded: AnchorUnit[] = [];
  for (const unit of units) {
    const start = unit.start - 1;
    const end = unit.end - 1;
    if (end < 1 || start > sourceLineCount) continue;
    folded.push({ start: Math.max(1, start), end: Math.min(end, sourceLineCount) });
  }
  return folded.length > 0 ? folded : [{ start: 1, end: Math.max(1, sourceLineCount) }];
}
