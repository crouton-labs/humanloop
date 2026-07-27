import { relative, resolve } from 'node:path';
import { checkReviewableFile } from '../editor/visible-paths.js';
import { BOLD, CYAN, DIM, RESET, YELLOW, clipLine } from './ansi.js';
import { diffFrame } from './render.js';
import { getTerminalSize, parseKeypress } from './terminal.js';

export interface PickFilePathOptions {
  candidates: string[];
  cwd: string;
  title: string;
}

function displayLabel(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel !== '' && !rel.startsWith('..') && !resolve(cwd, rel).startsWith(`${resolve(cwd)}..`)
    ? rel
    : path;
}

function isPrintable(input: string): boolean {
  return input.length > 0 && !/[\x00-\x1F\x7F]/.test(input) && !input.startsWith('\x1b');
}

/**
 * Pick one of the file paths visible in a surface, or a freely typed path.
 * The caller owns raw mode and the alternate screen for the picker duration.
 */
export function pickFilePath({ candidates, cwd, title }: PickFilePathOptions): Promise<string | null> {
  return new Promise((finish) => {
    let filter = '';
    let selected = 0;
    let notice: string | undefined;
    let frame: string[] = [];

    const filtered = (): string[] => {
      const needle = filter.toLocaleLowerCase();
      return candidates.filter((candidate) => displayLabel(candidate, cwd).toLocaleLowerCase().includes(needle));
    };

    const repaint = (clear = false) => {
      const { cols, rows } = getTerminalSize();
      const matches = filtered();
      selected = Math.max(0, Math.min(selected, Math.max(0, matches.length - 1)));
      const lines = [`  ${BOLD}${CYAN}${title}${RESET}`, `  ${DIM}path:${RESET} ${filter || `${DIM}(type to filter or enter a path)${RESET}`}`];
      const visible = 12;
      const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), Math.max(0, matches.length - visible)));
      const end = Math.min(matches.length, start + visible);
      if (matches.length === 0) {
        lines.push(`  ${DIM}${filter === '' ? 'No file paths named here.' : 'Enter to review this path.'}${RESET}`);
      } else {
        if (start > 0) lines.push(`  ${DIM}↑ ${start} above${RESET}`);
        for (let index = start; index < end; index++) {
          const candidate = matches[index]!;
          const cursor = index === selected ? `${CYAN}▸${RESET}` : ' ';
          lines.push(`  ${cursor} ${displayLabel(candidate, cwd)}`);
        }
        if (end < matches.length) lines.push(`  ${DIM}↓ ${matches.length - end} below${RESET}`);
      }
      if (notice !== undefined) lines.push(`  ${YELLOW}${notice}${RESET}`);
      lines.push(`  ${DIM}j/k or arrows move · Enter select · Esc cancel${RESET}`);
      const next = lines.slice(0, rows).map((line) => clipLine(line, cols));
      if (clear) process.stdout.write('\x1b[2J\x1b[H');
      const diff = diffFrame(frame, next, rows, cols);
      process.stdout.write('\x1b[?2026h');
      for (const write of diff.writes) process.stdout.write(write);
      process.stdout.write('\x1b[?2026l');
      frame = diff.nextPrevFrame;
    };

    const close = (result: string | null) => {
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      finish(result);
    };

    const select = () => {
      const matches = filtered();
      const candidate = matches[selected] ?? (filter === '' ? '' : resolve(cwd, filter));
      if (candidate === '') {
        notice = 'Type a file path to review.';
        repaint();
        return;
      }
      const check = checkReviewableFile(candidate);
      if (!check.ok) {
        notice = check.reason;
        repaint();
        return;
      }
      close(candidate);
    };

    const onResize = () => repaint(true);
    const onData = (data: Buffer) => {
      const { input, key } = parseKeypress(data);
      notice = undefined;
      if (key.escape || (input === 'q' && filter === '')) {
        close(null);
        return;
      }
      if (key.return) {
        select();
        return;
      }
      if (input === 'j' || key.downArrow) {
        selected = Math.min(selected + 1, Math.max(0, filtered().length - 1));
        repaint();
        return;
      }
      if (input === 'k' || key.upArrow) {
        selected = Math.max(0, selected - 1);
        repaint();
        return;
      }
      if (key.backspace) {
        filter = [...filter].slice(0, -1).join('');
        selected = 0;
        repaint();
        return;
      }
      if (isPrintable(input)) {
        filter += input;
        selected = 0;
        repaint();
      }
    };

    process.stdin.on('data', onData);
    process.stdout.on('resize', onResize);
    repaint(true);
  });
}
