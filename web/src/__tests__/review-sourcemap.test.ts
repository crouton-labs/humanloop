import assert from 'node:assert/strict';
import {
  buildSourceMap,
  sourceSelectionFromByteRange,
  sourceSelectionFromLineRange,
  sourceByteRangeFromComment,
  sourceSelectionFromComment,
  reviewRangeLabel,
} from '../lib/sourceMap.ts';
import type { FeedbackComment } from '../types.ts';

// ── UTF-8 byte columns vs UTF-16 char offsets ───────────────────────────────
{
  // "héllo" — the "é" is 2 UTF-8 bytes but 1 UTF-16 char. A byte column MUST
  // differ from a char offset here (the contract's explicit proof case).
  const content = 'héllo world\nsecond line\n';
  const map = buildSourceMap(content);
  assert.equal(map.lines.length, 2, 'a trailing newline terminates the last line (nvim parity), not a new empty line');
  assert.equal(map.lines[0]!.startByte, 0);
  // "héllo world" = h(1) é(2) l l o (3) space (1) w o r l d (5) = 12 bytes.
  assert.equal(map.lines[0]!.endByte, 12, 'line byte length counts é as 2 bytes');
  // second line starts after "héllo world\n" = 12 + 1 = 13 bytes.
  assert.equal(map.lines[1]!.startByte, 13);

  // Select "llo" (chars 2..5 → after "hé"). In bytes: h(1)+é(2)=3 .. +llo(3)=6.
  const sel = sourceSelectionFromByteRange(map, 3, 6);
  assert.ok(sel !== null);
  assert.equal(sel!.line, 1);
  assert.equal(sel!.endLine, 1);
  assert.equal(sel!.colStart, 3, '0-based byte colStart');
  assert.equal(sel!.colEnd, 6, 'exclusive 0-based byte colEnd');
  assert.equal(sel!.quote, 'llo', 'quote is the raw source slice');
  assert.equal(sel!.lineText, 'héllo world', 'lineText is the full raw source line');
}

// ── Emoji (4 UTF-8 bytes) column math ───────────────────────────────────────
{
  const content = '😀 ok\n';
  const map = buildSourceMap(content);
  // "😀 ok" = emoji(4) space(1) o(1) k(1) = 7 bytes.
  assert.equal(map.lines[0]!.endByte, 7);
  // Select "ok": bytes 5..7.
  const sel = sourceSelectionFromByteRange(map, 5, 7);
  assert.equal(sel!.quote, 'ok');
  assert.equal(sel!.colStart, 5);
  assert.equal(sel!.colEnd, 7);
}

// ── Multi-line selection ────────────────────────────────────────────────────
{
  const content = 'alpha\nbravo\ncharlie\n';
  const map = buildSourceMap(content);
  // From "pha" (line1, byte 2) through "cha" (line3). line3 startByte = 12.
  const startByte = 2; // 'a l [p]'
  const endByte = 12 + 3; // through "cha" on line 3
  const sel = sourceSelectionFromByteRange(map, startByte, endByte);
  assert.equal(sel!.line, 1);
  assert.equal(sel!.endLine, 3);
  assert.equal(sel!.lineText, 'alpha\nbravo\ncharlie', 'multi-line lineText joins full raw lines');
  assert.equal(sel!.colStart, 2);
  assert.equal(sel!.colEnd, 3, 'colEnd is byte offset within the END line');
}

// ── Line-only comment: whole-line byte range, no columns ────────────────────
{
  const content = '# Title\n\nbody text here\n';
  const map = buildSourceMap(content);
  const lineOnly: FeedbackComment = { id: 'x', line: 3, endLine: 3, lineText: 'body text here', comment: 'fix', createdAt: '' };
  const range = sourceByteRangeFromComment(lineOnly, map);
  assert.ok(range !== null);
  assert.equal(range!.startByte, map.lines[2]!.startByte);
  assert.equal(range!.endByte, map.lines[2]!.endByte, 'line-only comment spans the whole raw line');

  const lineSel = sourceSelectionFromLineRange(map, 3, 3);
  assert.equal(lineSel!.colStart, undefined, 'line-only selection carries no columns');
  assert.equal(lineSel!.colEnd, undefined);
  assert.equal(lineSel!.lineText, 'body text here');
}

// ── Comment WITH valid columns → range highlight ────────────────────────────
// A4: this proves `sourceByteRangeFromComment`/`sourceSelectionFromComment`
// compute the right bytes/quote from a comment's stored columns — it never
// calls `makeCommentHighlights`/`rehypeSourceSpans`, so it does NOT prove a
// rendered span actually carries the highlight class. That proof
// (byte-precise highlight splitting against the real rehype pipeline, M1)
// lives in `review-markdown-instrumentation.test.ts`.
{
  const content = 'const answer = 42;\n';
  const map = buildSourceMap(content);
  const colComment: FeedbackComment = { id: 'c', line: 1, endLine: 1, colStart: 6, colEnd: 12, lineText: content.trimEnd(), comment: 'name', createdAt: '' };
  const range = sourceByteRangeFromComment(colComment, map);
  assert.equal(range!.startByte, 6);
  assert.equal(range!.endByte, 12);
  const sel = sourceSelectionFromComment(colComment, map);
  assert.equal(sel!.quote, 'answer');
}

// ── Raw markdown constructs: rendered DOM differs from raw source ────────────
{
  // A link's raw source `[text](url)` renders to just "text" in the DOM. The
  // source map must anchor to the RAW byte range including the delimiters,
  // proving parity with nvim's source selection rather than the rendered text.
  const content = 'See [the docs](https://example.com) now\n';
  const map = buildSourceMap(content);
  // Raw "[the docs](https://example.com)" starts at byte 4.
  const rawLinkStart = content.indexOf('[');
  const rawLinkEnd = content.indexOf(')') + 1;
  const sel = sourceSelectionFromByteRange(map, rawLinkStart, rawLinkEnd);
  assert.equal(sel!.quote, '[the docs](https://example.com)', 'quote is the raw markdown including delimiters, not the rendered text');
  assert.equal(sel!.lineText, 'See [the docs](https://example.com) now');
}

// ── M3: multi-line comment whose END-line column < START-line column ───────
// A same-line range is validly REJECTED when colEnd <= colStart, but for a
// multi-line range colStart/colEnd are byte offsets into two DIFFERENT
// lines, so a smaller endLine column does not mean the range is empty/
// invalid — it's simply that the end line is shorter. This persists a
// FeedbackComment with exactly that shape and re-derives through
// `sourceByteRangeFromComment`/`sourceSelectionFromComment` (not just
// `sourceSelectionFromByteRange`, which never had this bug) to prove the
// comment-column validity gate (`hasValidRangeColumns`) now accepts it.
{
  const content = 'abcdef\nx\n';
  const map = buildSourceMap(content);
  // Bytes 4..8: line1 'abcdef' (startByte 0), line2 'x' (startByte 7).
  const sel = sourceSelectionFromByteRange(map, 4, 8);
  assert.equal(sel!.line, 1);
  assert.equal(sel!.endLine, 2);
  assert.equal(sel!.colStart, 4);
  assert.equal(sel!.colEnd, 1, 'end-line column (1) is smaller than the start-line column (4) — must still be valid');

  const comment: FeedbackComment = {
    id: 'm3', line: sel!.line, endLine: sel!.endLine, colStart: sel!.colStart, colEnd: sel!.colEnd,
    quote: sel!.quote, lineText: sel!.lineText, comment: 'spans two lines', createdAt: '',
  };

  const range = sourceByteRangeFromComment(comment, map);
  assert.ok(range !== null, 'a multi-line range with endLine column < startLine column round-trips through sourceByteRangeFromComment, not falling back to whole-line');
  assert.equal(range!.startByte, 4);
  assert.equal(range!.endByte, 8);

  const derivedSel = sourceSelectionFromComment(comment, map);
  assert.ok(derivedSel !== null);
  assert.equal(derivedSel!.line, 1);
  assert.equal(derivedSel!.endLine, 2);
  assert.equal(derivedSel!.colStart, 4);
  assert.equal(derivedSel!.colEnd, 1);
  assert.equal(derivedSel!.quote, 'ef\nx', 'quote survives the comment round-trip, not just the byte-range round-trip');
  assert.equal(derivedSel!.lineText, 'abcdef\nx');
}

// ── Range labels ────────────────────────────────────────────────────────────
{
  assert.equal(reviewRangeLabel({ id: '1', line: 12, endLine: 12, colStart: 4, colEnd: 18, lineText: '', comment: '', createdAt: '' }), 'L12:4-18');
  assert.equal(reviewRangeLabel({ id: '2', line: 3, endLine: 3, lineText: '', comment: '', createdAt: '' }), 'L3');
  assert.equal(reviewRangeLabel({ id: '3', line: 3, endLine: 7, lineText: '', comment: '', createdAt: '' }), 'L3-7');
  assert.equal(reviewRangeLabel({ id: '4', line: 3, endLine: 7, colStart: 2, colEnd: 5, lineText: '', comment: '', createdAt: '' }), 'L3:2-7:5');
}

console.log('OK: review sourceMap byte/line anchoring');
