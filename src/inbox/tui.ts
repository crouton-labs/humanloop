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
export function buildInboxLines(items: TicketSummary[], width: number, selectedIndex: number): string[] {
  if (items.length === 0) return [`  ${DIM}${ITALIC}No pending interactions${RESET}`];
  const lines = [`  ${BOLD}${items.length} pending${RESET}`, ''];
  const contentWidth = width - 4;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const kind = item.kind === 'deck' ? item.interactionKind ?? 'decision' : 'review';
    const icon = KIND_ICON[kind] ?? '·';
    const source = item.source.sessionName ?? item.source.askedBy ?? item.source.nodeId ?? '';
    const age = formatTimeAgo(item.blockedSince);
    const cursor = index === selectedIndex ? `${CYAN}▸${RESET} ` : '  ';
    const titleWidth = Math.max(10, contentWidth - source.length - age.length - 8);
    let row = `${cursor}${ansiColor(icon, KIND_COLOR[kind] ?? 'cyan')} `;
    if (source) row += `${ansiColor(source, 'yellow')} ${DIM}·${RESET} `;
    row += `${BOLD}${truncateRow(item.title || `(${item.id.slice(0, 8)})`, titleWidth)}${RESET}  ${DIM}${age}${RESET}`;
    lines.push(row);
    if (item.claim) lines.push(`      ${DIM}claimed by ${item.claim.owner}${RESET}`);
    else if (item.subtitle) lines.push(`      ${DIM}${truncateRow(item.subtitle, contentWidth - 6)}${RESET}`);
  }
  return lines;
}
