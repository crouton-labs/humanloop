import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// Browser-side leaf-anchor units — the SAME granularity the terminal review
// surface anchors by (`src/editor/terminal-review.ts` AnchorUnit /
// deriveAnchorUnits), but derived from the SOURCE MARKDOWN AST instead of
// termrender's per-rendered-row spans (the browser has no termrender). j/k
// steps unit-to-unit; a single bullet / table row / code line is its own unit;
// a paragraph, heading, blockquote, or a whole Mermaid/diagram fence is ONE
// unit. Comments still record precise source `line`/`endLine`, so the
// FeedbackComment schema is unchanged.

/** One leaf anchor unit: 1-indexed inclusive source-line bounds — the finest
 *  step j/k moves by in the browser review. */
export interface AnchorUnit {
  start: number;
  end: number;
}

interface MdNode {
  type: string;
  lang?: string | null;
  value?: string;
  position?: { start?: { line?: number }; end?: { line?: number } };
  children?: MdNode[];
}

const processor = unified().use(remarkParse).use(remarkGfm);

function lineBounds(node: MdNode): { start: number; end: number } | null {
  const start = node.position?.start?.line;
  const end = node.position?.end?.line;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start, end: Math.max(start, end) };
}

function isFenceLine(text: string | undefined): boolean {
  return /^\s*(```|~~~)/.test(text ?? '');
}

// A fenced/indented code block: each CONTENT source line is its own unit
// (matching termrender's "content lines 1:1"), so a single code line
// highlights alone. Mermaid/diagram fences are handled as whole blocks by the
// caller before reaching here.
//
// The content range is derived from the SOURCE bounds — the lines between the
// opener fence and its closer (if present), or every line for an indented
// block — NOT from `node.value`. A fence whose only content line is blank has
// `node.value === ''`, so a value-length check would collapse it to the whole
// fence and record a comment against the fence lines; the source-bounds range
// still anchors its real (blank) content line. Only a genuinely contentless
// fence (```lang immediately followed by ```) falls back to the whole block.
function pushCodeLines(node: MdNode, sourceLines: string[], out: AnchorUnit[]): void {
  const bounds = lineBounds(node);
  if (bounds === null) return;
  const opener = isFenceLine(sourceLines[bounds.start - 1]);
  const hasCloser = opener && bounds.end > bounds.start && isFenceLine(sourceLines[bounds.end - 1]);
  const contentStart = opener ? bounds.start + 1 : bounds.start;
  const contentEnd = hasCloser ? bounds.end - 1 : bounds.end;
  if (contentEnd < contentStart) {
    out.push({ start: bounds.start, end: bounds.end });
    return;
  }
  for (let ln = contentStart; ln <= contentEnd; ln++) out.push({ start: ln, end: ln });
}

// A GFM table: one unit per source ROW (each `tableRow` maps to its own source
// line). The delimiter line (`|---|---|`) is not a `tableRow` and gets no unit
// — it never renders as a DOM element and keyboard motion steps over it.
function pushTableRows(node: MdNode, out: AnchorUnit[]): void {
  for (const row of node.children ?? []) {
    if (row.type !== 'tableRow') continue;
    const bounds = lineBounds(row);
    if (bounds !== null) out.push({ start: bounds.start, end: bounds.end });
  }
}

// A list item: its OWN (non-list) content becomes leaf units, and each nested
// list recurses into its own per-item units. Children are walked in document
// order and own-content runs are FLUSHED at every nested-list boundary, so a
// parent unit never spans its nested children — a parent that also has text
// AFTER its nested list yields two separate own-content units, in order,
// rather than one range swallowing the nested lines.
function pushListItem(item: MdNode, sourceLines: string[], out: AnchorUnit[]): void {
  const children = item.children ?? [];
  let runStart = Number.POSITIVE_INFINITY;
  let runEnd = 0;
  let emittedOwn = false;
  const flush = (): void => {
    if (!Number.isFinite(runStart)) return;
    out.push({ start: runStart, end: runEnd });
    emittedOwn = true;
    runStart = Number.POSITIVE_INFINITY;
    runEnd = 0;
  };
  for (const child of children) {
    if (child.type === 'list') {
      flush();
      pushList(child, sourceLines, out);
      continue;
    }
    const bounds = lineBounds(child);
    if (bounds === null) continue;
    runStart = Math.min(runStart, bounds.start);
    runEnd = Math.max(runEnd, bounds.end);
  }
  flush();
  if (!emittedOwn) {
    // A bare parent item (only nested lists, no own text) — anchor its marker
    // line alone so the item stays selectable. clampAndClean sorts by start
    // line, so this lands ahead of its nested units regardless of emit order.
    const bounds = lineBounds(item);
    if (bounds !== null) out.push({ start: bounds.start, end: bounds.start });
  }
}

function pushList(list: MdNode, sourceLines: string[], out: AnchorUnit[]): void {
  for (const item of list.children ?? []) {
    if (item.type === 'listItem') pushListItem(item, sourceLines, out);
  }
}

function pushBlock(node: MdNode, sourceLines: string[], out: AnchorUnit[]): void {
  switch (node.type) {
    case 'list':
      pushList(node, sourceLines, out);
      return;
    case 'table':
      pushTableRows(node, out);
      return;
    case 'code':
      if (node.lang === 'mermaid') break; // whole-block, falls through below
      else { pushCodeLines(node, sourceLines, out); return; }
      break;
    default:
      break;
  }
  // paragraph / heading / blockquote / thematicBreak / mermaid / html / … —
  // one whole-block unit.
  const bounds = lineBounds(node);
  if (bounds !== null) out.push({ start: bounds.start, end: bounds.end });
}

function clampAndClean(units: AnchorUnit[], lineCount: number): AnchorUnit[] {
  const max = Math.max(1, lineCount);
  const out: AnchorUnit[] = [];
  for (const u of units) {
    const start = Math.max(1, Math.min(u.start, max));
    const end = Math.max(start, Math.min(u.end, max));
    const prev = out[out.length - 1];
    // Collapse an exact-duplicate run (defensive; a well-formed AST won't emit them).
    if (prev !== undefined && prev.start === start && prev.end === end) continue;
    out.push({ start, end });
  }
  out.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  return out;
}

/** Derive ordered leaf anchor units from the source markdown. A degenerate
 *  document (nothing anchorable) yields one whole-doc unit. */
export function deriveAnchorUnits(content: string): AnchorUnit[] {
  const sourceLines = content.split('\n');
  const lineCount = sourceLines.length;
  let tree: MdNode;
  try {
    tree = processor.parse(content) as unknown as MdNode;
  } catch {
    return [{ start: 1, end: Math.max(1, lineCount) }];
  }
  const units: AnchorUnit[] = [];
  for (const node of tree.children ?? []) pushBlock(node, sourceLines, units);
  const cleaned = clampAndClean(units, lineCount);
  if (cleaned.length === 0) return [{ start: 1, end: Math.max(1, lineCount) }];
  return cleaned;
}

/** Best unit for a source line: the NARROWEST unit containing it. A line no
 *  unit contains (a blank/separator line) snaps forward to the next unit; past
 *  the end clamps to the last. Mirrors the terminal's `unitIndexForLine`. */
export function unitIndexForLine(units: AnchorUnit[], line: number): number {
  let best = -1;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u.start <= line && u.end >= line) {
      if (best === -1 || u.end - u.start < units[best]!.end - units[best]!.start) best = i;
    }
  }
  if (best !== -1) return best;
  for (let i = 0; i < units.length; i++) {
    if (units[i]!.start > line) return i;
  }
  return Math.max(0, units.length - 1);
}

/** Remap a unit from an old list into a re-derived one: an exact source-range
 *  match wins, else the best unit for its first line. */
export function remapUnitIndex(units: AnchorUnit[], prev: AnchorUnit): number {
  for (let i = 0; i < units.length; i++) {
    if (units[i]!.start === prev.start && units[i]!.end === prev.end) return i;
  }
  return unitIndexForLine(units, prev.start);
}

/** First/last unit indices overlapping the source range `line..endLine`; a
 *  range touching no unit snaps like `unitIndexForLine`. */
export function unitRangeForSpan(units: AnchorUnit[], line: number, endLine: number): { lo: number; hi: number } {
  let lo = -1;
  let hi = -1;
  units.forEach((u, i) => {
    if (u.start <= endLine && u.end >= line) {
      if (lo === -1) lo = i;
      hi = i;
    }
  });
  if (lo === -1) {
    const snap = unitIndexForLine(units, line);
    return { lo: snap, hi: snap };
  }
  return { lo, hi };
}

/** Source-line bounds spanned by a unit index range `lo..hi` (min start / max
 *  end), clamped to a valid ordered pair. */
export function unitBoundsForRange(units: AnchorUnit[], lo: number, hi: number): { line: number; endLine: number } {
  let line = Number.POSITIVE_INFINITY;
  let endLine = 0;
  const from = Math.max(0, Math.min(lo, hi));
  const to = Math.min(units.length - 1, Math.max(lo, hi));
  for (let i = from; i <= to; i++) {
    const u = units[i];
    if (u === undefined) continue;
    line = Math.min(line, u.start);
    endLine = Math.max(endLine, u.end);
  }
  if (!Number.isFinite(line)) return { line: 1, endLine: 1 };
  return { line, endLine: Math.max(line, endLine) };
}
