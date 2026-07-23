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
const SOURCE_START_LINE_ATTR = 'data-source-start-line';
const SOURCE_END_LINE_ATTR = 'data-source-end-line';
const BLOCK_ACTIVE_CLASS = 'review-block-active';

/** 1-indexed source-line range of the active anchor unit — used to ring a
 *  whole code/diagram block the active unit fully covers (a Mermaid SVG has
 *  no source-mapped text leaves, so it can't be background-highlighted like
 *  prose; the whole-block ring is what makes it highlight as one unit). */
export interface BlockActiveRange {
  line: number;
  endLine: number;
}

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

const CODE_FENCE_RE = /^\s*(```|~~~)/;

// Split a rendered string into per-line segments, dropping the invisible CR of
// a CRLF source (buildSourceMap already keeps source-line text CR-free, so
// segments align with it and the dropped CR is visually redundant with the LF
// inside a `<pre>`).
function splitRenderedLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Wrap one `<code>` text leaf line by line: split it at newline boundaries and
// anchor each within-line segment to its OWN physical source line (via the
// precomputed `lineByteStart`), re-syncing the cursor at each break instead of
// carrying a single contiguous byte offset. That re-sync is what keeps CRLF
// (source newline = 2 bytes, rendered 1) and indented code (each source line
// carries a stripped indent prefix) exact — a running cursor would drift a
// byte per line. A bare "\n" separator between hljs token spans just advances
// the line. Newline separators are emitted as plain (unanchored) text.
function wrapCodeLeafText(
  text: string,
  renderedLines: string[],
  lineByteStart: number[],
  highlights: MarkdownSourceHighlight[],
  cursor: { lineIdx: number; col: number },
): any[] {
  const out: any[] = [];
  const parts = splitRenderedLines(text);
  for (let p = 0; p < parts.length; p++) {
    if (p > 0) {
      out.push({ type: 'text', value: '\n' });
      cursor.lineIdx += 1;
      cursor.col = 0;
    }
    const seg = parts[p]!;
    if (seg.length === 0) continue;
    const line = renderedLines[cursor.lineIdx];
    const byteStart = lineByteStart[cursor.lineIdx];
    if (line === undefined || byteStart === undefined) {
      // Past the mapped content lines (e.g. rehype's appended trailing "\n") —
      // leave as plain text rather than mis-anchor.
      out.push({ type: 'text', value: seg });
      continue;
    }
    const startByte = byteStart + byteLength(line.slice(0, cursor.col));
    out.push(...wrapTextLeaf(startByte, seg, highlights));
    cursor.col += seg.length;
  }
  return out;
}

function wrapCodeLineTextNodes(
  node: any,
  renderedLines: string[],
  lineByteStart: number[],
  highlights: MarkdownSourceHighlight[],
  cursor: { lineIdx: number; col: number },
): void {
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === null || typeof child !== 'object') continue;
    if (child.type === 'text') {
      const text = typeof child.value === 'string' ? child.value : '';
      if (text.length === 0) continue;
      const wrapped = wrapCodeLeafText(text, renderedLines, lineByteStart, highlights, cursor);
      if (wrapped.length === 0) continue;
      node.children.splice(i, 1, ...wrapped);
      i += wrapped.length - 1;
      continue;
    }
    wrapCodeLineTextNodes(child, renderedLines, lineByteStart, highlights, cursor);
  }
}

// A fenced/indented `<pre><code>` block: the `<code>` element retains an AST
// position spanning the whole block (fences included) but its text carries no
// per-leaf position, and `rehype-highlight` shreds the original text child into
// `hljs-*` token spans. Anchor each rendered CONTENT line to its OWN physical
// source line, so a single code line is independently highlightable and
// mouse-anchorable — including under CRLF and 4-space indentation, which the
// old whole-content `indexOf` could not map (rendered content is no longer a
// verbatim substring of the raw source). The content-line range is derived
// from the source bounds identically to `deriveAnchorUnits` (so the anchor
// unit and its DOM spans agree). Malformed cases — rendered line count or a
// per-line suffix alignment disagreeing with the source — bail without
// instrumenting rather than mis-anchor.
function instrumentCodeBlock(codeElement: any, sourceMap: SourceMap, highlights: MarkdownSourceHighlight[]): void {
  const startLine = codeElement.position?.start?.line;
  const endLine = codeElement.position?.end?.line;
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return;
  const opener = CODE_FENCE_RE.test(sourceMap.lines[startLine - 1]?.text ?? '');
  const hasCloser = opener && endLine > startLine && CODE_FENCE_RE.test(sourceMap.lines[endLine - 1]?.text ?? '');
  const contentStart = opener ? startLine + 1 : startLine;
  const contentEnd = hasCloser ? endLine - 1 : endLine;
  if (contentEnd < contentStart) return; // a contentless fence — nothing to anchor
  const contentLineCount = contentEnd - contentStart + 1;

  let renderedLines = splitRenderedLines(collectText(codeElement));
  // remark-rehype appends a trailing "\n" to code content → one extra empty
  // rendered line; drop it so rendered lines align 1:1 with source lines.
  if (renderedLines.length === contentLineCount + 1 && renderedLines[renderedLines.length - 1] === '') {
    renderedLines = renderedLines.slice(0, -1);
  }
  if (renderedLines.length !== contentLineCount) return; // disagreement — bail

  const lineByteStart: number[] = [];
  for (let i = 0; i < contentLineCount; i++) {
    const sourceLine = sourceMap.lines[contentStart - 1 + i];
    const rendered = renderedLines[i]!;
    if (sourceLine === undefined) return;
    // The rendered line is the source line minus a stripped indent PREFIX, so
    // it must be a suffix of the source text; if not, the mapping is unsafe.
    const indentChars = sourceLine.text.length - rendered.length;
    if (indentChars < 0 || sourceLine.text.slice(indentChars) !== rendered) return;
    lineByteStart.push(sourceLine.startByte + byteLength(sourceLine.text.slice(0, indentChars)));
  }

  wrapCodeLineTextNodes(codeElement, renderedLines, lineByteStart, highlights, { lineIdx: 0, col: 0 });
}

function isBlockCode(parent: any, child: any): boolean {
  return parent?.tagName === 'pre' && child?.type === 'element' && child?.tagName === 'code';
}

function addClass(element: any, className: string): void {
  const props = (element.properties ??= {});
  const existing = props.className;
  if (Array.isArray(existing)) existing.push(className);
  else if (typeof existing === 'string' && existing.length > 0) props.className = `${existing} ${className}`;
  else props.className = [className];
}

// Tag a fenced/indented code `<pre>` with its 1-indexed source-line range (from
// the `<code>` element's AST position, fences included) and, when the active
// anchor unit FULLY covers that block, mark it active. Full-containment (not
// mere overlap) is deliberate: a single active code LINE self-highlights via
// its own text span, so only a whole-block unit — a Mermaid diagram, or a
// Shift-selection spanning the entire fence — rings the container.
function tagBlockContainer(pre: any, code: any, activeRange: BlockActiveRange | null): void {
  const startLine = code.position?.start?.line;
  const endLine = code.position?.end?.line;
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return;
  const props = (pre.properties ??= {});
  props[SOURCE_START_LINE_ATTR] = String(startLine);
  props[SOURCE_END_LINE_ATTR] = String(endLine);
  if (activeRange !== null && activeRange.line <= startLine && activeRange.endLine >= endLine) {
    addClass(pre, BLOCK_ACTIVE_CLASS);
  }
}

function visitTree(node: any, sourceMap: SourceMap, highlights: MarkdownSourceHighlight[], activeRange: BlockActiveRange | null): void {
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
      tagBlockContainer(node, child, activeRange);
      instrumentCodeBlock(child, sourceMap, highlights);
      continue;
    }
    visitTree(child, sourceMap, highlights, activeRange);
  }
}

export function rehypeSourceSpans(sourceMap: SourceMap, highlights: MarkdownSourceHighlight[] = [], activeBlockRange: BlockActiveRange | null = null): () => (tree: any) => void {
  return () => (tree: any) => {
    visitTree(tree, sourceMap, highlights, activeBlockRange);
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
