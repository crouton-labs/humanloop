import type { FeedbackComment } from '@/types';

const encoder = new TextEncoder();

export interface SourceLine {
  line: number;
  text: string;
  startChar: number;
  endChar: number;
  startByte: number;
  endByte: number;
}

export interface SourceMap {
  content: string;
  lines: SourceLine[];
  totalBytes: number;
}

export interface SourceByteRange {
  startByte: number;
  endByte: number;
}

export interface SourceSelection extends SourceByteRange {
  line: number;
  endLine: number;
  quote?: string;
  colStart?: number;
  colEnd?: number;
  lineText: string;
}

export interface MarkdownSourceHighlight {
  range: SourceByteRange;
  className: string;
}

const SOURCE_START_ATTR = 'data-source-start-byte';
const SOURCE_END_ATTR = 'data-source-end-byte';

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function charOffsetForByteOffset(content: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const total = byteLength(content);
  if (byteOffset >= total) return content.length;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const bytes = byteLength(content.slice(0, mid));
    if (bytes < byteOffset) low = mid + 1;
    else high = mid;
  }
  return low;
}

function byteOffsetForCharOffset(content: string, charOffset: number): number {
  if (charOffset <= 0) return 0;
  if (charOffset >= content.length) return byteLength(content);
  return byteLength(content.slice(0, charOffset));
}

function findLineIndexForByteOffset(map: SourceMap, byteOffset: number): number {
  const lines = map.lines;
  if (lines.length === 0) return 0;
  let low = 0;
  let high = lines.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid]!.startByte <= byteOffset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function lineByteRange(map: SourceMap, line: number, endLine = line): SourceByteRange | null {
  if (map.lines.length === 0) return null;
  const start = Math.max(1, Math.min(line, endLine));
  const end = Math.max(1, Math.max(line, endLine));
  const first = map.lines[start - 1];
  const last = map.lines[Math.min(end - 1, map.lines.length - 1)];
  if (first === undefined || last === undefined) return null;
  return { startByte: first.startByte, endByte: last.endByte };
}

export function buildSourceMap(content: string): SourceMap {
  const lines: SourceLine[] = [];
  let startChar = 0;
  let startByte = 0;
  let lineNumber = 1;

  while (true) {
    let endChar = startChar;
    while (endChar < content.length) {
      const code = content.charCodeAt(endChar);
      if (code === 10 || code === 13) break;
      endChar++;
    }

    const text = content.slice(startChar, endChar);
    const endByte = startByte + byteLength(text);
    lines.push({ line: lineNumber++, text, startChar, endChar, startByte, endByte });

    if (endChar >= content.length) break;

    const newlineChars = content.charCodeAt(endChar) === 13 && content.charCodeAt(endChar + 1) === 10 ? 2 : 1;
    const newlineText = content.slice(endChar, endChar + newlineChars);
    startChar = endChar + newlineChars;
    startByte = endByte + byteLength(newlineText);
    if (startChar >= content.length) break;
  }

  return { content, lines, totalBytes: byteLength(content) };
}

export function sourceSelectionFromLineRange(map: SourceMap, line: number, endLine = line): SourceSelection | null {
  const range = lineByteRange(map, line, endLine);
  if (range === null) return null;
  const start = Math.max(1, Math.min(line, endLine));
  const end = Math.min(map.lines.length, Math.max(1, Math.max(line, endLine)));
  const lineText = map.lines.slice(start - 1, end).map((entry) => entry.text).join('\n');
  return {
    line: start,
    endLine: end,
    startByte: range.startByte,
    endByte: range.endByte,
    lineText,
  };
}

export function sourceSelectionFromByteRange(map: SourceMap, startByte: number, endByte: number): SourceSelection | null {
  if (startByte === endByte) return null;
  const start = Math.max(0, Math.min(startByte, endByte));
  const end = Math.min(map.totalBytes, Math.max(startByte, endByte));
  const startLineIndex = findLineIndexForByteOffset(map, start);
  const endLineIndex = findLineIndexForByteOffset(map, Math.max(end - 1, start));
  const startLine = map.lines[startLineIndex];
  const endLine = map.lines[endLineIndex];
  if (startLine === undefined || endLine === undefined) return null;
  const startChar = charOffsetForByteOffset(map.content, start);
  const endChar = charOffsetForByteOffset(map.content, end);
  return {
    line: startLine.line,
    endLine: endLine.line,
    startByte: start,
    endByte: end,
    colStart: start - startLine.startByte,
    colEnd: end - endLine.startByte,
    quote: map.content.slice(startChar, endChar),
    lineText: map.lines.slice(startLine.line - 1, endLine.line).map((entry) => entry.text).join('\n'),
  };
}

// Column validity is only meaningful WITHIN a single line: `colEnd > colStart`
// compares two byte offsets into the SAME line. For a multi-line range,
// `colStart` is relative to the START line and `colEnd` is relative to the
// (different) END line — two unrelated lines' lengths, so a numeric
// `colEnd > colStart` comparison is meaningless and can reject a perfectly
// valid range (e.g. a short last line legitimately has a smaller colEnd than
// the start line's colStart). Same-line ranges keep the strict comparison;
// multi-line ranges are valid whenever both columns are present, nonnegative
// integers.
export function hasValidRangeColumns(comment: { line: number; endLine: number; colStart?: number; colEnd?: number }): boolean {
  if (!Number.isInteger(comment.colStart) || !Number.isInteger(comment.colEnd)) return false;
  const colStart = comment.colStart!;
  const colEnd = comment.colEnd!;
  if (colStart < 0 || colEnd < 0) return false;
  if (comment.line === comment.endLine) return colEnd > colStart;
  return true;
}

export function sourceByteRangeFromComment(comment: FeedbackComment, map: SourceMap): SourceByteRange | null {
  if (map.lines.length === 0) return null;
  const line = Math.max(1, Math.min(comment.line, map.lines.length));
  const endLine = Math.max(1, Math.min(comment.endLine, map.lines.length));
  if (hasValidRangeColumns(comment)) {
    const startLine = map.lines[Math.min(line, endLine) - 1];
    const targetEndLine = map.lines[Math.max(line, endLine) - 1];
    if (startLine === undefined || targetEndLine === undefined) return null;
    return {
      startByte: startLine.startByte + comment.colStart!,
      endByte: targetEndLine.startByte + comment.colEnd!,
    };
  }
  return lineByteRange(map, line, endLine);
}

export function sourceSelectionFromComment(comment: FeedbackComment, map: SourceMap): SourceSelection | null {
  const byteRange = sourceByteRangeFromComment(comment, map);
  if (byteRange !== null && hasValidRangeColumns(comment)) {
    return sourceSelectionFromByteRange(map, byteRange.startByte, byteRange.endByte);
  }
  return sourceSelectionFromLineRange(map, comment.line, comment.endLine);
}

function overlaps(left: SourceByteRange, right: SourceByteRange): boolean {
  return left.startByte < right.endByte && left.endByte > right.startByte;
}

function wrapTextNode(node: any, classes: string[], startByte: number, endByte: number): any {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: classes.join(' '),
      [SOURCE_START_ATTR]: String(startByte),
      [SOURCE_END_ATTR]: String(endByte),
    },
    children: [node],
  };
}

// The ONE place prose leaves and code tokens both become source-anchored hast
// nodes. Given the byte offset in the RAW SOURCE where `visibleText`
// begins — already established by the caller to be a byte-for-byte match, so
// `visibleText`'s own byte offsets line up 1:1 with source bytes from
// `rawStartByte` — split it at any highlight boundary strictly inside its
// range and wrap each resulting segment in its own source-anchored span with
// only the highlight classes that segment actually overlaps (byte-precise
// highlights, not whole-node overlap). Returns an array (usually length 1) so
// callers splice it into `children` in place of the original text node.
function wrapTextLeaf(rawStartByte: number, visibleText: string, highlights: MarkdownSourceHighlight[]): any[] {
  if (visibleText.length === 0) return [];
  const rawEndByte = rawStartByte + byteLength(visibleText);
  const cuts = new Set<number>();
  for (const highlight of highlights) {
    if (highlight.range.startByte > rawStartByte && highlight.range.startByte < rawEndByte) cuts.add(highlight.range.startByte);
    if (highlight.range.endByte > rawStartByte && highlight.range.endByte < rawEndByte) cuts.add(highlight.range.endByte);
  }
  const boundaries = [rawStartByte, ...[...cuts].sort((a, b) => a - b), rawEndByte];
  const nodes: any[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStartByte = boundaries[i]!;
    const segEndByte = boundaries[i + 1]!;
    if (segEndByte <= segStartByte) continue;
    const segStartChar = charOffsetForByteOffset(visibleText, segStartByte - rawStartByte);
    const segEndChar = charOffsetForByteOffset(visibleText, segEndByte - rawStartByte);
    const segText = visibleText.slice(segStartChar, segEndChar);
    if (segText.length === 0) continue;
    const range: SourceByteRange = { startByte: segStartByte, endByte: segEndByte };
    nodes.push(wrapTextNode({ type: 'text', value: segText }, spanClassesForRange(range, highlights), segStartByte, segEndByte));
  }
  return nodes;
}

// Enforce the invariant every anchored leaf must satisfy: its raw-source byte
// slice equals its rendered text, so byte math over the rendered text produces
// correct source columns. mdast `position` for most leaf kinds already gives
// the leaf's OWN position (strong/emphasis/link text, headings, ... all match
// `content.slice(ps, pe) === value` directly — no correction needed). Inline
// code is the one construct whose position spans the surrounding backtick
// fence rather than just its content, so it needs correction.
//
// The correction is a STRICT, LOCAL backtick-fence strip anchored at `ps` —
// NOT a generic `content.indexOf(value, ps)` search. A blind search is unsafe:
// for an escaped character (`\*` rendering as `*`) or an HTML entity (`&amp;`
// rendering as `&`), the decoded glyph very often reappears verbatim as a
// SUBSTRING of its own raw escape/entity sequence (the `*` in `\*`, the `&` at
// the head of `&amp;`), so a blind search would "find" it and anchor the
// visible glyph to the wrong raw byte — a real byte, but not the one the
// escape/entity actually represents. Requiring a literal, symmetric backtick
// fence around `value` makes that coincidence impossible: an escape/entity
// sequence never starts with a backtick, so it can never satisfy this check
// and correctly falls through to `null` (bail) instead of mis-anchoring.
function resolveRawStart(content: string, ps: number, pe: number, value: string): number | null {
  if (value.length === 0) return null;
  if (content.slice(ps, pe) === value) return ps;
  const fenceMatch = /^`+/.exec(content.slice(ps, pe));
  if (fenceMatch !== null) {
    const fence = fenceMatch[0];
    const start = ps + fence.length;
    const end = start + value.length;
    if (content.slice(start, end) === value && content.slice(end, end + fence.length) === fence) {
      return start;
    }
  }
  return null;
}

function collectText(node: any): string {
  if (node === null || typeof node !== 'object') return '';
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : '';
  if (!Array.isArray(node.children)) return '';
  let out = '';
  for (const child of node.children) out += collectText(child);
  return out;
}

function spanClassesForRange(range: SourceByteRange, highlights: MarkdownSourceHighlight[]): string[] {
  const classes = ['review-source-span'];
  for (const highlight of highlights) {
    if (overlaps(range, highlight.range)) classes.push(highlight.className);
  }
  return classes;
}

// Wrap each descendant text node of a highlighted `<code>` block in a
// source-anchored span (or several, split at highlight boundaries — same
// `wrapTextLeaf` prose uses), walking in document order and advancing a byte
// cursor. Fenced-code text nodes carry no AST `position` (and
// `rehype-highlight` shreds the original single text child into `hljs-*`
// token spans), so we can't rely on per-leaf offsets like prose — instead the
// whole code content maps 1:1 onto a contiguous source byte range, and hljs
// preserves the exact characters, so accumulating byte lengths in order
// reproduces the source columns exactly.
function wrapCodeTextNodes(node: any, highlights: MarkdownSourceHighlight[], cursor: { byte: number }): void {
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === null || typeof child !== 'object') continue;
    if (child.type === 'text') {
      const text = typeof child.value === 'string' ? child.value : '';
      if (text.length === 0) continue;
      const startByte = cursor.byte;
      const wrapped = wrapTextLeaf(startByte, text, highlights);
      cursor.byte = startByte + byteLength(text);
      if (wrapped.length === 0) continue;
      node.children.splice(i, 1, ...wrapped);
      i += wrapped.length - 1;
      continue;
    }
    wrapCodeTextNodes(child, highlights, cursor);
  }
}

// The raw source position right after a fenced code block's info-string line
// (the ```lang line), so we can search for the block's content PAST it. A
// plain `indexOf` starting at the fence itself can false-match the info string
// when the code content's first line happens to equal the language token
// (e.g. a ```js block whose entire content is literally "js\n") — the fence
// line would match before the real content does.
function infoStringEndOffset(content: string, startOffset: number): number {
  const newlineIdx = content.indexOf('\n', startOffset);
  return newlineIdx < 0 ? startOffset : newlineIdx + 1;
}

// A fenced `<pre><code>` block: the `<code>` element retains an AST position
// spanning the whole block (fences included), but its text carries none. Locate
// the exact code content within the raw source (it appears verbatim between the
// fences) to find where the content byte range begins, then anchor each token.
//
// Indented (4-space) code blocks and CRLF source both bail here gracefully:
// `remark` strips leading indentation from an indented block's `node.value`,
// and micromark normalizes CRLF to `\n` in `node.value`, so `fullText` is no
// longer a verbatim substring of the raw (indented / `\r\n`) source and
// `indexOf` returns -1. That's an accepted, narrow degradation: those blocks
// lose DOM source-anchoring (no drag-select, no click-line, no visual
// highlight inside the block) but nothing mis-anchors, and line-only
// comments plus j/k line motion are unaffected since they don't depend on
// per-block DOM spans.
function instrumentCodeBlock(codeElement: any, sourceMap: SourceMap, highlights: MarkdownSourceHighlight[]): void {
  const startOffset = codeElement.position?.start?.offset;
  if (typeof startOffset !== 'number') return;
  const fullText = collectText(codeElement);
  if (fullText.length === 0) return;
  const isFenced = sourceMap.content.startsWith('```', startOffset) || sourceMap.content.startsWith('~~~', startOffset);
  const searchFrom = isFenced ? infoStringEndOffset(sourceMap.content, startOffset) : startOffset;
  const codeStartChar = sourceMap.content.indexOf(fullText, searchFrom);
  if (codeStartChar < 0) return; // e.g. indented/CRLF code blocks — see comment above
  const codeStartByte = byteOffsetForCharOffset(sourceMap.content, codeStartChar);
  wrapCodeTextNodes(codeElement, highlights, { byte: codeStartByte });
}

function isBlockCode(parent: any, child: any): boolean {
  return parent?.tagName === 'pre' && child?.type === 'element' && child?.tagName === 'code';
}

function visitTree(node: any, sourceMap: SourceMap, highlights: MarkdownSourceHighlight[]): void {
  if (node === null || typeof node !== 'object' || !Array.isArray(node.children)) return;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === null || typeof child !== 'object') continue;
    if (child.type === 'text' && child.position?.start?.offset !== undefined && child.position?.end?.offset !== undefined) {
      const value = typeof child.value === 'string' ? child.value : '';
      // Enforce raw-slice === visible-text. Inline code's fence-wrapped
      // position needs the backtick-strip correction (see `resolveRawStart`);
      // escape/entity leaves — which can never satisfy that strict check —
      // BAIL (no wrap) rather than mis-anchor.
      const rawStart = resolveRawStart(sourceMap.content, child.position.start.offset, child.position.end.offset, value);
      if (rawStart === null) continue;
      const rawStartByte = byteOffsetForCharOffset(sourceMap.content, rawStart);
      const wrapped = wrapTextLeaf(rawStartByte, value, highlights);
      if (wrapped.length === 0) continue;
      node.children.splice(i, 1, ...wrapped);
      i += wrapped.length - 1;
      continue;
    }
    if (isBlockCode(node, child)) {
      instrumentCodeBlock(child, sourceMap, highlights);
      continue;
    }
    visitTree(child, sourceMap, highlights);
  }
}

export function rehypeSourceSpans(sourceMap: SourceMap, highlights: MarkdownSourceHighlight[] = []): () => (tree: any) => void {
  return () => (tree: any) => {
    visitTree(tree, sourceMap, highlights);
  };
}

function readSourceRange(element: Element): SourceByteRange | null {
  const start = element.getAttribute(SOURCE_START_ATTR);
  const end = element.getAttribute(SOURCE_END_ATTR);
  if (start === null || end === null) return null;
  const startByte = Number(start);
  const endByte = Number(end);
  if (!Number.isFinite(startByte) || !Number.isFinite(endByte) || endByte < startByte) return null;
  return { startByte, endByte };
}

function sourceSpanForNode(node: Node | null): Element | null {
  if (node === null) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return element?.closest?.(`[${SOURCE_START_ATTR}][${SOURCE_END_ATTR}]`) ?? null;
}

function textOffsetWithinSpan(span: Element, target: Node, offset: number): number | null {
  let total = 0;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  while (true) {
    const node = walker.nextNode();
    if (node === null) break;
    const text = node.textContent ?? '';
    if (node === target) return total + Math.max(0, Math.min(offset, text.length));
    total += text.length;
  }
  if (target === span) return offset <= 0 ? 0 : total;
  return null;
}

// Pure byte math shared by the DOM point-lookup below AND directly testable
// off-DOM: given a span's source byte range and its rendered text, convert a
// char offset WITHIN that rendered text into the corresponding source byte
// (post-invariant, the span's rendered text is byte-identical to its source
// slice, so accumulating byte length up to `textOffset` is exact).
export function byteOffsetWithinRange(range: SourceByteRange, visibleText: string, textOffset: number): number {
  const clamped = Math.max(0, Math.min(textOffset, visibleText.length));
  const byteDelta = byteLength(visibleText.slice(0, clamped));
  return Math.max(range.startByte, Math.min(range.startByte + byteDelta, range.endByte));
}

// Pure counterpart to `sourceLineFromElement`'s line lookup, exported so a
// byte offset (however obtained) resolves to a 1-based source line.
export function sourceLineFromByteOffset(map: SourceMap, byteOffset: number): number | null {
  const line = map.lines[findLineIndexForByteOffset(map, byteOffset)]?.line;
  return line ?? null;
}

function sourceByteAtDomPoint(node: Node, offset: number): number | null {
  const span = sourceSpanForNode(node);
  if (span === null) return null;
  const range = readSourceRange(span);
  if (range === null) return null;
  const textOffset = textOffsetWithinSpan(span, node, offset);
  if (textOffset === null) return null;
  const visibleText = span.textContent ?? '';
  return byteOffsetWithinRange(range, visibleText, textOffset);
}

export function sourceSelectionFromDomSelection(map: SourceMap, selection: Selection): SourceSelection | null {
  if (selection.isCollapsed || selection.anchorNode === null || selection.focusNode === null) return null;
  const anchor = sourceByteAtDomPoint(selection.anchorNode, selection.anchorOffset);
  const focus = sourceByteAtDomPoint(selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null || anchor === focus) return null;
  return sourceSelectionFromByteRange(map, anchor, focus);
}

export function sourceLineFromElement(map: SourceMap, element: Element | null): number | null {
  const sourceElement = element?.closest?.(`[${SOURCE_START_ATTR}][${SOURCE_END_ATTR}]`) ?? null;
  if (sourceElement === null) return null;
  const range = readSourceRange(sourceElement);
  if (range === null) return null;
  return sourceLineFromByteOffset(map, range.startByte);
}

// Point-level click-to-line. `sourceLineFromElement` above only resolves
// the line of a span's START byte, which is wrong for a multiline text node
// (`alpha\nbravo` in one leaf) — clicking `bravo` must resolve line 2, not the
// span's line 1. Given a DOM point (a collapsed selection's anchorNode/anchorOffset,
// or any Range boundary), resolve the exact clicked byte and its line.
export function sourceLineFromDomPoint(map: SourceMap, node: Node, offset: number): number | null {
  const byte = sourceByteAtDomPoint(node, offset);
  if (byte === null) return null;
  return sourceLineFromByteOffset(map, byte);
}

export function reviewCommentsFingerprint(comments: FeedbackComment[]): string {
  return JSON.stringify(comments);
}

export function reviewDraftKey(comments: FeedbackComment[], version: number): string {
  return `${version}:${reviewCommentsFingerprint(comments)}`;
}

export function reviewRangeLabel(comment: FeedbackComment): string {
  const hasCols = hasValidRangeColumns(comment);
  if (comment.line === comment.endLine) {
    return hasCols ? `L${comment.line}:${comment.colStart}-${comment.colEnd}` : `L${comment.line}`;
  }
  return hasCols ? `L${comment.line}:${comment.colStart}-${comment.endLine}:${comment.colEnd}` : `L${comment.line}-${comment.endLine}`;
}

export function makeCommentHighlights(map: SourceMap, comments: FeedbackComment[], className = 'review-source-comment'): MarkdownSourceHighlight[] {
  return comments
    .map((comment) => sourceByteRangeFromComment(comment, map))
    .filter((range): range is SourceByteRange => range !== null)
    .map((range) => ({ range, className }));
}
