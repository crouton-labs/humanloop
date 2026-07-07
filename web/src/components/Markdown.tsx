import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '@/lib/utils';
import type { MarkdownSourceHighlight, SourceMap } from '@/lib/sourceMap';
import { rehypeSourceSpans } from '@/lib/sourceMap';

// The "friendlier markdown than nvim" requirement — a real renderer (GFM
// tables, fenced code blocks with syntax highlighting, headings, lists,
// links) instead of termrender's terminal-width ANSI rendering. Styling
// lives in `index.css`'s `.markdown-body` block (retunes
// @tailwindcss/typography's `prose` onto our own design tokens).
export function Markdown({
  children,
  className,
  sourceMap,
  sourceHighlights = [],
}: {
  children: string;
  className?: string;
  sourceMap?: SourceMap;
  sourceHighlights?: MarkdownSourceHighlight[];
}) {
  // Highlight MUST run before source instrumentation: `rehype-highlight`
  // rebuilds the `<pre><code>` subtree from scratch (dropping any children we
  // added), so we instrument the *highlighted* tree. `rehypeSourceSpans`
  // re-anchors each token — prose leaves via their AST positions, and fenced
  // code tokens (which carry no position) by locating the code text in source.
  const rehypePlugins = sourceMap === undefined
    ? [rehypeHighlight]
    : [rehypeHighlight, rehypeSourceSpans(sourceMap, sourceHighlights)];

  return (
    <div className={cn('markdown-body prose prose-sm dark:prose-invert max-w-none', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
