import type { RenderedDoc } from './termrender.js';
import { sanitize } from '../tui/ansi.js';

/** Map plain text one source line to one unwrapped rendered row. */
export function plainTextDoc(content: string): RenderedDoc {
  const lines = content.split('\n').map(sanitize);
  return {
    lines,
    spans: lines.map((_, index) => [index + 1, index + 1]),
    rows: lines.map(() => 0),
    blocks: [{ type: 'plaintext', start: 1, end: lines.length }],
  };
}
