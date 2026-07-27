import { relative } from 'node:path';
import type { FeedbackComment } from '../types.js';

function commentText(text: string): string {
  return text.replace(/\r?\n/g, '\n  ');
}

/** Format line-anchored feedback as the markdown block returned to accessory hosts. */
export function formatReviewMarkdown(
  file: string,
  cwd: string,
  comments: readonly FeedbackComment[],
  totalLines: number,
): string {
  if (comments.length === 0) return '';

  const relativePath = relative(cwd, file);
  const label = relativePath.startsWith('..') ? file : relativePath;
  const ordered = comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) =>
      a.comment.line - b.comment.line
      || a.comment.endLine - b.comment.endLine
      || a.index - b.index);

  const bullets = ordered.map(({ comment }) => {
    const text = commentText(comment.comment);
    if (comment.line === 1 && comment.endLine === totalLines) return `- ${text}`;
    const location = comment.endLine > comment.line
      ? `L${comment.line}–L${comment.endLine}`
      : `L${comment.line}`;
    return `- **${location}** — ${text}`;
  });

  return `Review of \`${label}\`:\n\n${bullets.join('\n')}`;
}

/** Prefix an inserted block with enough newlines to leave a blank line before it. */
export function withLeadingSeparator(buffer: string, block: string): string;
export function withLeadingSeparator(buffer: string, cursorPrefixText: string, block: string): string;
export function withLeadingSeparator(buffer: string, cursorPrefixTextOrBlock: string, block?: string): string {
  const cursorPrefixText = block === undefined ? buffer : cursorPrefixTextOrBlock;
  const insertedBlock = block === undefined ? cursorPrefixTextOrBlock : block;
  if (buffer.length === 0) return insertedBlock;
  if (cursorPrefixText.endsWith('\n\n')) return insertedBlock;
  if (cursorPrefixText.endsWith('\n')) return `\n${insertedBlock}`;
  return `\n\n${insertedBlock}`;
}
