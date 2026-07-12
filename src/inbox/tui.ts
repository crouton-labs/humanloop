import type { TicketSummary } from '../types.js';
import { RESET, BOLD, DIM, ITALIC, CYAN, RED, GRAY, YELLOW, truncateRow } from '../tui/ansi.js';

function ansiColor(text: string, color: string): string {
  switch (color) {
    case 'gray': return `${GRAY}${text}${RESET}`;
    case 'cyan': return `${CYAN}${text}${RESET}`;
    case 'red': return `${RED}${text}${RESET}`;
    case 'yellow': return `${YELLOW}${text}${RESET}`;
    default: return text;
  }
}

export const KIND_ICON: Record<string, string> = { notify: '✉', decision: '◆', context: '✎', error: '⚠', review: '▤' };
export const KIND_COLOR: Record<string, string> = { notify: 'gray', decision: 'cyan', context: 'cyan', error: 'red', review: 'yellow' };

export function formatTimeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/** Pure inbox rows; selection and terminal ownership belong to InboxController. */
export function buildInboxLines(items: TicketSummary[], width: number, selectedIndex: number, height = Number.MAX_SAFE_INTEGER): string[] {
  if (items.length === 0) return [`  ${DIM}${ITALIC}No pending interactions${RESET}`];
  const contentWidth = width - 4;
  const itemLines = items.map((item, index) => buildItemLines(item, index, selectedIndex, contentWidth));
  const window = visibleWindow(itemLines, selectedIndex, Math.max(1, height - 2));
  const lines = [`  ${BOLD}${items.length} pending${RESET}`, ''];
  if (window.start > 0) lines.push(`  ${DIM}↑ ${window.start} above${RESET}`);
  for (let index = window.start; index < window.end; index++) lines.push(...itemLines[index]!);
  if (window.end < items.length) lines.push(`  ${DIM}↓ ${items.length - window.end} below${RESET}`);
  return lines;
}

function buildItemLines(item: TicketSummary, index: number, selectedIndex: number, contentWidth: number): string[] {
  const kind = item.kind === 'deck' ? item.interactionKind ?? 'decision' : 'review';
  const icon = KIND_ICON[kind] ?? '·';
  // Source and title share the row budget: an unbounded source (a long node
  // or session name) would floor the title at its minimum and overflow the
  // column, bending the panel divider. Shrink the source only when the row
  // cannot hold it alongside the title's 10-col minimum.
  const rawSource = item.source.sessionName ?? item.source.askedBy ?? item.source.nodeId ?? '';
  const age = formatTimeAgo(item.blockedSince);
  const source = truncateRow(rawSource, Math.max(8, contentWidth - age.length - 8 - 10));
  const cursor = index === selectedIndex ? `${CYAN}▸${RESET} ` : '  ';
  const titleWidth = Math.max(10, contentWidth - source.length - age.length - 8);
  let row = `${cursor}${ansiColor(icon, KIND_COLOR[kind] ?? 'cyan')} `;
  if (source) row += `${ansiColor(source, 'yellow')} ${DIM}·${RESET} `;
  row += `${BOLD}${truncateRow(item.title || `(${item.id.slice(0, 8)})`, titleWidth)}${RESET}  ${DIM}${age}${RESET}`;
  if (item.claim) return [row, `      ${DIM}${truncateRow(`claimed by ${item.claim.owner}`, contentWidth - 6)}${RESET}`];
  if (item.subtitle) return [row, `      ${DIM}${truncateRow(item.subtitle, contentWidth - 6)}${RESET}`];
  return [row];
}

/** Select a contiguous row window that always contains the selected ticket. */
function visibleWindow(rows: string[][], selectedIndex: number, capacity: number): { start: number; end: number } {
  let start = Math.max(0, Math.min(selectedIndex, rows.length - 1));
  let end = start + 1;
  let preferBelow = true;
  while (true) {
    const below = end < rows.length ? { start, end: end + 1 } : undefined;
    const above = start > 0 ? { start: start - 1, end } : undefined;
    const preferred = preferBelow ? [below, above] : [above, below];
    const next = preferred.find((candidate): candidate is { start: number; end: number } => candidate !== undefined && windowHeight(rows, candidate.start, candidate.end) <= capacity);
    if (next === undefined) break;
    start = next.start;
    end = next.end;
    preferBelow = !preferBelow;
  }
  return { start, end };
}

function windowHeight(rows: string[][], start: number, end: number): number {
  let height = start > 0 ? 1 : 0;
  for (let index = start; index < end; index++) height += rows[index]!.length;
  if (end < rows.length) height++;
  return height;
}
