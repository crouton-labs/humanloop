import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import {
  buildSourceMap,
  rehypeSourceSpans,
  makeCommentHighlights,
  sourceSelectionFromByteRange,
  byteOffsetWithinRange,
  sourceLineFromByteOffset,
} from '../lib/sourceMap.ts';
import type { FeedbackComment } from '../types.ts';
import { isMermaidClassName } from '../components/MermaidDiagram.tsx';

// This suite proves the M1 fix: source-anchored spans survive INSIDE a fenced
// code block after `rehype-highlight` has rebuilt the `<pre><code>` subtree.
// It runs the exact rehype plugin order Markdown.tsx uses (highlight FIRST,
// then source instrumentation) against the real unified pipeline.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function render(md: string, highlights: ReturnType<typeof makeCommentHighlights> = []): HastNode {
  const map = buildSourceMap(md);
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeHighlight)
    .use(rehypeSourceSpans(map, highlights));
  return proc.runSync(proc.parse(md)) as unknown as HastNode;
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function findFirst(node: HastNode, pred: (n: HastNode) => boolean): HastNode | null {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findFirst(child, pred);
    if (hit !== null) return hit;
  }
  return null;
}

function collectSpans(node: HastNode, out: HastNode[] = []): HastNode[] {
  if (node.type === 'element' && node.tagName === 'span' && node.properties?.['data-source-start-byte'] !== undefined) {
    out.push(node);
  }
  for (const child of node.children ?? []) collectSpans(child, out);
  return out;
}

const startByteOf = (n: HastNode): number => Number(n.properties!['data-source-start-byte']);
const endByteOf = (n: HastNode): number => Number(n.properties!['data-source-end-byte']);

// ── Source spans exist inside <pre><code> after highlight, byte-accurate ─────
{
  const md = 'Intro prose.\n\n```js\nconst answer = 42;\nreturn answer;\n```\n\nAfter.\n';
  const map = buildSourceMap(md);
  const tree = render(md);

  const pre = findFirst(tree, (n) => n.tagName === 'pre');
  assert.ok(pre !== null, 'a <pre> block is rendered');
  const code = findFirst(pre, (n) => n.tagName === 'code');
  assert.ok(code !== null, 'a <code> block is rendered');

  // Syntax highlighting is preserved: hljs token classes survive.
  assert.ok(/\bhljs\b/.test(String((code!.properties?.className as string[] | string) ?? '')), 'code carries hljs class');
  const hljsToken = findFirst(code!, (n) => {
    const cls = n.properties?.className;
    const s = Array.isArray(cls) ? cls.join(' ') : String(cls ?? '');
    return /hljs-/.test(s);
  });
  assert.ok(hljsToken !== null, 'hljs-* token spans are still present (highlighting preserved)');

  const codeSpans = collectSpans(code!);
  assert.ok(codeSpans.length > 0, 'M1: source spans exist INSIDE the fenced code block');

  // Every code span is byte-accurate: its rendered text equals the raw source
  // slice for its declared byte range. This is exactly what mouse selection
  // (data-source-start-byte + visible-text byte prefix) relies on.
  for (const span of codeSpans) {
    const sel = sourceSelectionFromByteRange(map, startByteOf(span), endByteOf(span));
    assert.ok(sel !== null, 'span byte range maps to a source selection');
    assert.equal(sel!.quote, textOf(span), 'span text equals its raw source byte slice');
  }

  // The spans tile the code content contiguously, in order, covering it whole.
  const ordered = [...codeSpans].sort((a, b) => startByteOf(a) - startByteOf(b));
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(startByteOf(ordered[i]!), endByteOf(ordered[i - 1]!), 'code spans are contiguous (no gaps/overlap)');
  }
  const wholeSel = sourceSelectionFromByteRange(map, startByteOf(ordered[0]!), endByteOf(ordered[ordered.length - 1]!));
  assert.equal(wholeSel!.quote, 'const answer = 42;\nreturn answer;\n', 'code spans cover the exact code content');

  // Click-to-line parity: a code span resolves to a source line in the fenced
  // block, not the fence line. (`const answer` is line 4 of the doc.)
  assert.equal(map.lines[3]!.text, 'const answer = 42;');
  assert.equal(wholeSel!.line, 4, 'code content anchors to the first code line (line 4), past the ``` fence');
}

// ── Comment highlight lands on code-block spans (visual highlight works) ─────
{
  const md = 'Text.\n\n```js\nconst x = 1;\n```\n';
  const map = buildSourceMap(md);
  // A column comment over "const" on the code line (line 4).
  const line = map.lines[3]!;
  const constStart = line.startByte; // "const" starts the line
  const constEnd = line.startByte + 5; // exclusive, "const"
  const comment: FeedbackComment = {
    id: 'c1', line: 4, endLine: 4, colStart: constStart - line.startByte, colEnd: constEnd - line.startByte,
    quote: 'const', lineText: 'const x = 1;', comment: 'name it', createdAt: '',
  };
  const highlights = makeCommentHighlights(map, [comment], 'review-source-comment');
  const tree = render(md, highlights);
  const code = findFirst(tree, (n) => n.tagName === 'code')!;
  const spans = collectSpans(code);

  const highlighted = spans.filter((s) => String(s.properties?.className ?? '').includes('review-source-comment'));
  assert.ok(highlighted.length > 0, 'a code-block span carries the comment highlight class');
  // Only spans overlapping the "const" byte range are highlighted.
  for (const s of highlighted) {
    assert.ok(startByteOf(s) < constEnd && endByteOf(s) > constStart, 'highlighted span overlaps the comment range');
  }
  const outside = spans.find((s) => startByteOf(s) >= constEnd);
  if (outside !== undefined) {
    assert.ok(!String(outside.properties?.className ?? '').includes('review-source-comment'), 'a span past the range is NOT highlighted');
  }
}

// ── Prose spans still work after the highlight-first reorder ─────────────────
{
  const md = '# Heading\n\nSome **bold** prose.\n';
  const tree = render(md);
  const spans = collectSpans(tree);
  assert.ok(spans.length > 0, 'prose still gets source spans after reorder');
  const map = buildSourceMap(md);
  for (const span of spans) {
    const sel = sourceSelectionFromByteRange(map, startByteOf(span), endByteOf(span));
    assert.equal(sel!.quote, textOf(span), 'prose span text equals its raw source slice');
  }
}

// ── C1: links — rendered text excludes the raw [brackets](url) delimiters ───
{
  const md = 'See [the docs](https://example.com) now\n';
  const map = buildSourceMap(md);
  const tree = render(md);
  const spans = collectSpans(tree);
  const linkSpan = spans.find((s) => textOf(s) === 'the docs');
  assert.ok(linkSpan !== undefined, 'the link text gets its own source span');
  assert.equal(startByteOf(linkSpan!), md.indexOf('the docs'), 'span starts at the visible text, not the [ delimiter');
  assert.equal(endByteOf(linkSpan!), md.indexOf('the docs') + 'the docs'.length, 'span ends before the ] delimiter');
  const sel = sourceSelectionFromByteRange(map, startByteOf(linkSpan!), endByteOf(linkSpan!));
  assert.equal(sel!.quote, 'the docs', 'byte range maps back to exactly the visible text, excluding [](url)');
}

// ── C1: inline code — bytes EXCLUDE the surrounding backticks ──────────────
{
  const md = 'Use `inlineCode` here\n';
  const map = buildSourceMap(md);
  const tree = render(md);
  const spans = collectSpans(tree);
  const codeSpan = spans.find((s) => textOf(s) === 'inlineCode');
  assert.ok(codeSpan !== undefined, 'inline code gets a source span');
  const raw = md.slice(startByteOf(codeSpan!), endByteOf(codeSpan!));
  assert.equal(raw, 'inlineCode', 'the byte range excludes the backticks (mdast position includes them; C1 corrects it)');
  const sel = sourceSelectionFromByteRange(map, startByteOf(codeSpan!), endByteOf(codeSpan!));
  assert.equal(sel!.quote, 'inlineCode');
}

// ── C1: multibyte text within a span (é = 2 bytes, emoji = 4 bytes) ─────────
{
  const md = 'héllo 😀 world\n';
  const map = buildSourceMap(md);
  const tree = render(md);
  const spans = collectSpans(tree);
  assert.equal(spans.length, 1, 'the whole line is one prose text leaf');
  const span = spans[0]!;
  assert.equal(textOf(span), 'héllo 😀 world');
  assert.equal(startByteOf(span), 0);
  // h(1) é(2) l l o(3) space(1) emoji(4) space(1) w o r l d(5) = 17 bytes.
  assert.equal(endByteOf(span), 17, 'the span end byte counts multibyte chars correctly');
  const sel = sourceSelectionFromByteRange(map, startByteOf(span), endByteOf(span));
  assert.equal(sel!.quote, 'héllo 😀 world', 'byte range round-trips through multibyte content exactly');
}

// ── C1: escape/entity leaves BAIL (no span) rather than mis-anchor ──────────
{
  // MIXED leaves (glyph alongside other chars) and ISOLATED leaves (the
  // leaf is EXACTLY the escaped/entity glyph on its own, e.g. `\*`/`&amp;`)
  // — isolated is the case `resolveRawStart`'s old generic `indexOf`
  // fallback could false-match against (the decoded glyph reappears
  // verbatim as a substring of its own raw escape/entity sequence). An
  // escaped char inside link text (`[\*](url)`) bails for the same reason.
  for (const md of ['a\\*b\n', 'a&amp;b\n', '\\*\n', '&amp;\n', '[\\*](url)\n']) {
    const tree = render(md);
    const spans = collectSpans(tree);
    assert.equal(spans.length, 0, `escape/entity text (${JSON.stringify(md)}) is left unanchored, not mis-anchored`);
  }
}

// ── M1: byte-precise highlight — only the overlapping segment gets the class,
//        NOT the whole containing text node (a plain prose paragraph, not
//        aligned to any token boundary) ─────────────────────────────────────
{
  const md = 'The quick brown fox jumps.\n';
  const map = buildSourceMap(md);
  const start = md.indexOf('brown');
  const end = start + 'brown'.length;
  const highlights = makeCommentHighlights(map, [{
    id: 'c', line: 1, endLine: 1, colStart: start, colEnd: end, lineText: md.trimEnd(), comment: 'x', createdAt: '',
  }]);
  const tree = render(md, highlights);
  const spans = collectSpans(tree);
  // The single "The quick brown fox jumps." text leaf must be split into
  // (at least) three segments so only "brown" carries the highlight class.
  assert.ok(spans.length >= 3, 'the text node is split at the highlight boundaries');
  const highlighted = spans.filter((s) => String(s.properties?.className ?? '').includes('review-source-comment'));
  assert.equal(highlighted.length, 1, 'exactly one segment is highlighted');
  assert.equal(textOf(highlighted[0]!), 'brown', 'the highlighted segment is EXACTLY the comment range, not the whole sentence');
  const before = spans.find((s) => endByteOf(s) === start);
  const after = spans.find((s) => startByteOf(s) === end);
  assert.ok(before !== undefined && !String(before.properties?.className ?? '').includes('review-source-comment'), 'text before the range is not highlighted');
  assert.ok(after !== undefined && !String(after.properties?.className ?? '').includes('review-source-comment'), 'text after the range is not highlighted');
  // Segments tile the original leaf contiguously with no gaps/overlap.
  const ordered = [...spans].sort((a, b) => startByteOf(a) - startByteOf(b));
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(startByteOf(ordered[i]!), endByteOf(ordered[i - 1]!), 'split segments are contiguous');
  }
}

// ── m1 (critique): info-string collision — code content equal to the language
//    token must NOT anchor to the fence's info-string line ──────────────────
{
  const md = '```js\njs\n```\n';
  const map = buildSourceMap(md);
  const tree = render(md);
  const code = findFirst(tree, (n) => n.tagName === 'code')!;
  const spans = collectSpans(code);
  assert.ok(spans.length > 0, 'the single-token code block still anchors');
  const contentLineStart = map.lines[1]!.startByte; // line 2: the content "js" line, past the ```js fence line
  for (const s of spans) {
    assert.ok(startByteOf(s) >= contentLineStart, 'the code content anchors to its OWN line, not the ```js info-string line');
  }
  const whole = sourceSelectionFromByteRange(map, startByteOf(spans[0]!), endByteOf(spans[spans.length - 1]!));
  assert.equal(whole!.line, 2, 'content line is line 2 (past the fence), not line 1 (the fence/info-string)');
}

// ── M2: point-level line resolution for a multiline paragraph text leaf ─────
// A single mdast text node can span multiple raw source lines (a soft line
// break inside one paragraph, e.g. "alpha\nbravo", stays ONE text leaf with a
// literal embedded \n). `sourceLineFromElement` (span-start-byte only) would
// wrongly resolve every click inside this node to line 1. The exported pure
// point-level helpers (`byteOffsetWithinRange` + `sourceLineFromByteOffset`,
// which `sourceLineFromDomPoint` composes) must resolve the ACTUAL clicked
// line, fed the real span attrs + rendered text from the hast tree — proving
// the algorithm without needing a live DOM Selection.
{
  const md = 'Intro.\n\nalpha\nbravo\n\nMore.\n';
  const map = buildSourceMap(md);
  assert.equal(map.lines[2]!.text, 'alpha');
  assert.equal(map.lines[3]!.text, 'bravo');
  const tree = render(md);
  const spans = collectSpans(tree);
  const span = spans.find((s) => textOf(s) === 'alpha\nbravo');
  assert.ok(span !== undefined, 'the soft-broken two-line text stays one leaf/span');
  const range = { startByte: startByteOf(span!), endByte: endByteOf(span!) };
  const visibleText = textOf(span!);

  // A point at the start of the leaf ("alpha") resolves to line 3.
  const byteAtStart = byteOffsetWithinRange(range, visibleText, 0);
  assert.equal(sourceLineFromByteOffset(map, byteAtStart), 3, 'clicking the start of the leaf resolves line 3 ("alpha")');

  // A point inside "bravo" (char offset 6 = right after "alpha\n") resolves to line 4.
  const bravoOffset = visibleText.indexOf('bravo');
  const byteAtBravo = byteOffsetWithinRange(range, visibleText, bravoOffset);
  assert.equal(sourceLineFromByteOffset(map, byteAtBravo), 4, 'clicking inside "bravo" resolves line 4, not the span\'s start line');
}

// Mermaid fences survive the markdown pipeline as code blocks and are handed
// to the browser diagram renderer rather than shown as source.
{
  const tree = render('```mermaid\nflowchart LR\n  Start --> Done\n```\n');
  const code = findFirst(tree, (node) => node.type === 'element' && node.tagName === 'code');
  assert.ok(code, 'Mermaid fence produces a code element');
  assert.equal(isMermaidClassName((code.properties?.className as string[]).join(' ')), true, 'Mermaid code element is recognized for diagram rendering');
  assert.equal(isMermaidClassName('language-typescript'), false, 'ordinary code remains a code block');
}

console.log('OK: review markdown instrumentation (M1/C1/M2 real rehype-pipeline anchoring)');
