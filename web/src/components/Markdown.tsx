import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '@/lib/utils';

// The "friendlier markdown than nvim" requirement — a real renderer (GFM
// tables, fenced code blocks with syntax highlighting, headings, lists,
// links) instead of termrender's terminal-width ANSI rendering. Styling
// lives in `index.css`'s `.markdown-body` block (retunes
// @tailwindcss/typography's `prose` onto our own design tokens).
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('markdown-body prose prose-sm dark:prose-invert max-w-none', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
