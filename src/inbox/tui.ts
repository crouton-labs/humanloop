import stringWidth from 'string-width';
import type { InboxItem } from '../types.js';
import {
  setupTerminal,
  restoreTerminal,
  parseKeypress,
  getTerminalSize,
} from '../tui/terminal.js';
import { diffFrame } from '../tui/render.js';

// ── ANSI helpers (local to this module) ──────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const CYAN = `${ESC}36m`;
const RED = `${ESC}31m`;
const GRAY = `${ESC}90m`;
const YELLOW = `${ESC}33m`;

function ansiColor(text: string, color: string): string {
  switch (color) {
    case 'gray': return `${GRAY}${text}${RESET}`;
    case 'cyan': return `${CYAN}${text}${RESET}`;
    case 'red': return `${RED}${text}${RESET}`;
    case 'yellow': return `${YELLOW}${text}${RESET}`;
    default: return text;
  }
}

// ── Row model (ported verbatim from sisyphus cross-session-inbox.ts:8-21) ────

export const KIND_ICON: Record<string, string> = {
  notify: '✉',
  decision: '◆',
  context: '✎',
  error: '⚠',
};

export const KIND_COLOR: Record<string, string> = {
  notify: 'gray',
  decision: 'cyan',
  context: 'cyan',
  error: 'red',
};

// ── formatTimeAgo (ported from sisyphus src/tui/lib/format.ts:5-12) ──────────

export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ── truncate (ported from sisyphus src/tui/lib/format.ts:19-37) ──────────────

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n/g, ' ').replace(/✅/g, '✓').replace(/❌/g, '✗').replace(/\p{Emoji_Presentation}/gu, '');
  if (max < 4) return clean.slice(0, max);
  const w = stringWidth(clean);
  if (w <= max) return clean;
  let result = clean;
  while (stringWidth(result) > max - 1 && result.length > 0) {
    const cut = result.lastIndexOf(' ', result.length - 2);
    if (cut > max * 0.4) {
      result = result.slice(0, cut);
    } else {
      result = result.slice(0, result.length - 1);
    }
  }
  return result + '…';
}

// ── buildInboxLines ───────────────────────────────────────────────────────────

export function buildInboxLines(
  items: InboxItem[],
  width: number,
  selectedIndex: number,
): string[] {
  const lines: string[] = [];

  if (items.length === 0) {
    lines.push(`  ${DIM}${ITALIC}No pending interactions${RESET}`);
    return lines;
  }

  lines.push(`  ${BOLD}${items.length} pending${RESET}`);
  lines.push('');

  const contentWidth = width - 4;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const kindKey = item.kind ?? '';
    const icon = kindKey in KIND_ICON ? KIND_ICON[kindKey]! : '·';
    const iconColor = kindKey in KIND_COLOR ? KIND_COLOR[kindKey]! : 'cyan';

    const sourceLabel = item.source?.sessionName ?? item.source?.askedBy ?? '';
    const titleText = item.title ?? `(${item.id.slice(0, 8)})`;
    const blocked = formatTimeAgo(item.blockedSince);

    const cursor = i === selectedIndex ? `${CYAN}▸${RESET} ` : '  ';

    const maxTitle = Math.max(10, contentWidth - sourceLabel.length - blocked.length - 8);

    let row = cursor;
    row += ansiColor(icon, iconColor);
    if (sourceLabel) {
      row += ` ${ansiColor(sourceLabel, 'yellow')}`;
      row += ` ${DIM}·${RESET} `;
    } else {
      row += ' ';
    }
    row += `${BOLD}${truncate(titleText, maxTitle)}${RESET}`;
    row += `  ${DIM}${blocked}${RESET}`;

    lines.push(row);

    if (item.subtitle) {
      lines.push(`      ${DIM}${truncate(item.subtitle, contentWidth - 6)}${RESET}`);
    }
  }

  return lines;
}

// ── pickFromInbox ─────────────────────────────────────────────────────────────

export function pickFromInbox(
  items: InboxItem[],
  opts: { cols: number; rows: number },
): Promise<InboxItem | null> {
  if (items.length === 0) return Promise.resolve(null);

  return new Promise<InboxItem | null>((resolve) => {
    let selectedIndex = 0;
    let prevFrame: string[] = [];
    let onData!: (data: Buffer) => void;

    const flush = () => {
      const { cols: currentCols, rows: currentRows } = getTerminalSize();
      const lines = buildInboxLines(items, currentCols, selectedIndex);
      const { writes, nextPrevFrame } = diffFrame(prevFrame, lines, currentRows);
      process.stdout.write('\x1b[?2026h');
      for (const w of writes) process.stdout.write(w);
      process.stdout.write('\x1b[?2026l');
      prevFrame = nextPrevFrame;
    };

    const done = (result: InboxItem | null) => {
      restoreTerminal();
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', flush);
      resolve(result);
    };

    setupTerminal();
    flush();

    onData = (data: Buffer) => {
      const { input, key } = parseKeypress(data);

      if (key.downArrow || input === 'j') {
        selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        flush();
        return;
      }
      if (key.upArrow || input === 'k') {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        flush();
        return;
      }
      if (key.return) {
        const selected = items[selectedIndex];
        done(selected ?? null);
        return;
      }
      if (key.escape || (key.ctrl && input === 'c') || input === 'q') {
        done(null);
        return;
      }
    };

    process.stdin.on('data', onData);

    process.stdout.on('resize', flush);
  });
}
