import { extname } from 'node:path';
import { renderMarkdownWithMap, type RenderedDoc } from './termrender.js';

// ── Source files as review documents ─────────────────────────────────────────
//
// A review ticket may point at a .ts/.py/.sql source file, not just a .md
// artifact. Every surface still wants ONE rendering story, so a source file is
// presented as a single fenced code block: termrender (Pygments) and the
// browser (highlight.js) then syntax-highlight it for free, and the fence's
// language comes from the file extension.
//
// The one cost is a line shift: the fence's opening line makes source line N
// land on line N+1 of the wrapped document. `codeRenderedDoc` folds that back
// out so every span/anchor the surfaces expose is a real SOURCE line number.

/** Extension → fence info string. Names are the ones Pygments (termrender) and
 *  highlight.js (browser) both accept, so one map serves every surface. */
const FENCE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.swift': 'swift', '.kt': 'kotlin', '.php': 'php', '.lua': 'lua', '.pl': 'perl',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'fish',
  '.sql': 'sql', '.json': 'json', '.jsonc': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml', '.ini': 'ini', '.xml': 'xml', '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.vim': 'vim', '.el': 'lisp',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell',
  '.scala': 'scala', '.dart': 'dart', '.r': 'r', '.jl': 'julia', '.zig': 'zig',
  '.tf': 'terraform', '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql',
  '.dockerfile': 'dockerfile', '.diff': 'diff', '.patch': 'diff', '.csv': 'text',
  '.txt': 'text', '.log': 'text', '.env': 'bash', '.mk': 'makefile',
};

/** Markdown extensions render as a DOCUMENT (headings, tables, Mermaid); every
 *  other text file renders as code. */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

export function isMarkdownFile(file: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(file).toLowerCase());
}

/** Fence info string for a source file — `text` when the extension is unknown,
 *  which every highlighter degrades to plain text on. */
export function fenceLanguageFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '') {
    // Extensionless but conventionally-named files still have obvious types.
    const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
    if (base === 'dockerfile') return 'dockerfile';
    if (base === 'makefile') return 'makefile';
    return 'text';
  }
  return FENCE_BY_EXT[ext] ?? 'text';
}

/** Wrap source text as a fenced block. The fence is grown past the longest
 *  backtick run in the content, so a file that itself contains ``` can't close
 *  its own block. */
export function codeFenceDocument(content: string, language: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  return `${fence}${language}\n${body}\n${fence}\n`;
}

/** Shift a rendered wrapped-document map back onto SOURCE line numbers: the
 *  opening fence occupies line 1, so document line N is source line N-1.
 *
 *  Rows that touch a fence line are the panel's border/title chrome, not
 *  source: they lose BOTH their span and their block row so nothing anchors to
 *  them — otherwise the top border would be a step in j/k that selects the
 *  whole file. */
function foldFenceOffset(doc: RenderedDoc, sourceLineCount: number): RenderedDoc {
  const closingFenceLine = sourceLineCount + 2;
  const clamp = (line: number): number => Math.max(1, Math.min(line - 1, sourceLineCount));
  const chrome = doc.spans.map((span) => span !== null && (span[0] <= 1 || span[1] >= closingFenceLine));
  return {
    lines: doc.lines,
    rows: doc.rows.map((row, index) => (chrome[index] === true ? null : row)),
    spans: doc.spans.map((span, index) => {
      if (span === null || chrome[index] === true) return null;
      return [clamp(span[0]), clamp(span[1])] as [number, number];
    }),
    blocks: doc.blocks.map((block) => ({ type: block.type, start: clamp(block.start), end: clamp(block.end) })),
  };
}

/** Render a source file as a syntax-highlighted code panel whose spans are
 *  source lines — the code-file counterpart of `renderReviewDoc`. */
export function codeRenderedDoc(content: string, language: string, width: number): RenderedDoc {
  const sourceLineCount = content.split('\n').length;
  return foldFenceOffset(renderMarkdownWithMap(codeFenceDocument(content, language), width), sourceLineCount);
}
