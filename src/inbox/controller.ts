import { watch, type FSWatcher } from 'node:fs';
import type { Deck, InteractionResponse, TicketSummary } from '../types.js';
import type { Key } from '../tui/terminal.js';
import { getTerminalSize, parseKeypress, restoreTerminal, setupTerminal } from '../tui/terminal.js';
import { diffFrame } from '../tui/render.js';
import { BOLD, CYAN, DIM, RESET, YELLOW } from '../tui/ansi.js';
import { buildInboxLines } from './tui.js';
import { inboxLayout } from './layout.js';
import { scanInbox } from './scan.js';
import { inboxRootsDirectory, listInboxRoots } from './registry.js';
import { claimTicket, heartbeatClaim, releaseClaim } from './claim.js';
import { completeDeck, readTicketResult } from './tickets.js';
import { clearProgress, deckPath, progressPath, readJson } from './convention.js';
import { DeckAdapter } from './deck-adapter.js';

export interface InboxControllerOptions {
  roots?: string[];
  cols?: number;
  rows?: number;
  scan?: (roots?: string[]) => TicketSummary[];
  completeDeck?: (dir: string, responses: InteractionResponse[], token: string) => Promise<unknown>;
}

type Screen = 'list' | 'detail';

/** One terminal owner for scanning, stable selection, claims, and frame diffs. */
export class InboxController {
  private readonly options: InboxControllerOptions;
  private readonly scan: (roots?: string[]) => TicketSummary[];
  private readonly finishDeck: (dir: string, responses: InteractionResponse[], token: string) => Promise<unknown>;
  private items: TicketSummary[] = [];
  private selectedDir: string | undefined;
  private selectedIndex = 0;
  private screen: Screen = 'list';
  private adapter: DeckAdapter | undefined;
  private claim: { dir: string; token: string } | undefined;
  private cols: number;
  private rows: number;
  private frame: string[] = [];
  private status: string | undefined;
  private watchers: FSWatcher[] = [];
  private selectedWatcher: FSWatcher | undefined;
  private closed = false;
  private running = false;
  private finishRun: (() => void) | undefined;

  constructor(options: InboxControllerOptions = {}) {
    this.options = options;
    this.scan = options.scan ?? scanInbox;
    this.finishDeck = options.completeDeck ?? completeDeck;
    const size = getTerminalSize();
    this.cols = options.cols ?? size.cols;
    this.rows = options.rows ?? size.rows;
    this.rescan();
  }

  snapshot(): { items: TicketSummary[]; selectedDir?: string; screen: Screen; inputBuffer?: string } {
    return { items: [...this.items], selectedDir: this.selectedDir, screen: this.screen, inputBuffer: this.adapter?.inputBuffer() };
  }

  rescan(): void {
    const priorDir = this.selectedDir;
    const priorIndex = this.selectedIndex;
    this.items = this.scan(this.options.roots);
    const found = priorDir === undefined ? -1 : this.items.findIndex((item) => item.dir === priorDir);
    if (found >= 0) {
      this.selectedIndex = found;
      this.selectedDir = priorDir;
      return;
    }
    if (this.adapter !== undefined && priorDir !== undefined) {
      const canceled = readTicketResult(priorDir)?.kind === 'canceled';
      if (canceled) clearProgress(priorDir);
      this.status = canceled ? 'canceled by requester' : 'ticket resolved elsewhere';
      this.leaveDetail();
    }
    if (this.items.length === 0) {
      this.selectedIndex = 0;
      this.selectedDir = undefined;
      return;
    }
    this.selectedIndex = Math.min(priorIndex, this.items.length - 1);
    this.selectedDir = this.items[this.selectedIndex]!.dir;
  }

  invalidate(): void { this.rescan(); this.repaint(); }

  resize(cols = getTerminalSize().cols, rows = getTerminalSize().rows): void {
    this.cols = cols;
    this.rows = rows;
    this.frame = [];
    this.adapter?.resize(this.detailSize().cols, this.detailSize().rows);
    this.repaint(true);
  }

  render(): string[] {
    const geometry = inboxLayout(this.cols, this.rows, this.screen);
    if (geometry.mode === 'minimum') return [`${YELLOW}Resize terminal to at least 60×18 to use inbox.${RESET}`];
    const list = buildInboxLines(this.items, geometry.listWidth, this.selectedIndex);
    const detail = this.detailLines(geometry.detailWidth, geometry.height);
    if (geometry.mode === 'list') return this.withStatus(list);
    if (geometry.mode === 'detail') return this.withStatus(detail);
    const lines: string[] = [];
    for (let i = 0; i < geometry.height; i++) {
      const left = list[i] ?? '';
      const right = detail[i] ?? '';
      lines.push(`${left}${' '.repeat(Math.max(1, geometry.listWidth - visibleWidth(left)))} ${right}`);
    }
    return this.withStatus(lines);
  }

  handleKey(input: string, key: Key): void {
    if (key.ctrl && input === 'c') { this.close(); return; }
    if (this.screen === 'detail' && this.adapter !== undefined) {
      this.adapter.handleKey(input, key);
      this.repaint();
      return;
    }
    if (key.escape || input === 'q') { this.close(); return; }
    if (input === 'j' || key.downArrow) this.select(this.selectedIndex + 1);
    else if (input === 'k' || key.upArrow) this.select(this.selectedIndex - 1);
    else if (key.return || input === 'a') this.activate();
    this.repaint();
  }

  activate(): void {
    const item = this.items[this.selectedIndex];
    if (item === undefined || item.kind !== 'deck') return;
    const claim = claimTicket(item.dir);
    if (claim === null) { this.status = 'ticket is being edited by another inbox'; return; }
    this.claim = { dir: item.dir, token: claim.token };
    const deck = readJson<Deck>(deckPath(item.dir));
    if (deck === null) { releaseClaim(item.dir, claim.token); this.claim = undefined; this.invalidate(); return; }
    if (item.interactionKind === 'notify') {
      void this.complete([{ id: deck.interactions[0]?.id ?? 'notify', selectedOptionId: deck.interactions[0]?.options[0]?.id }]);
      return;
    }
    this.screen = 'detail';
    this.adapter = new DeckAdapter({
      dir: item.dir,
      deck,
      cols: this.detailSize().cols,
      rows: this.detailSize().rows,
      onDirty: () => this.repaint(),
      onBack: () => { this.leaveDetail(); this.repaint(); },
      onComplete: (responses) => { void this.complete(responses); },
    });
    this.watchSelected(item.dir);
  }

  reloadSelectedDeck(): void { this.adapter?.reload(); this.repaint(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.leaveDetail();
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.selectedWatcher?.close();
    this.selectedWatcher = undefined;
    this.finishRun?.();
  }

  async run(): Promise<void> {
    setupTerminal();
    this.running = true;
    this.watchRoots();
    this.repaint(true);
    const heartbeat = setInterval(() => {
      if (this.claim !== undefined) heartbeatClaim(this.claim.dir, this.claim.token);
    }, 10_000);
    await new Promise<void>((resolve) => {
      const onData = (data: Buffer) => {
        const { input, key } = parseKeypress(data);
        this.handleKey(input, key);
        if (this.closed) finish();
      };
      const onResize = () => this.resize();
      let done = false;
      this.finishRun = () => {
        if (done) return;
        done = true;
        process.stdin.removeListener('data', onData);
        process.stdout.removeListener('resize', onResize);
        clearInterval(heartbeat);
        this.running = false;
        this.finishRun = undefined;
        restoreTerminal();
        resolve();
      };
      const finish = this.finishRun;
      process.stdin.on('data', onData);
      process.stdout.on('resize', onResize);
    });
  }

  private async complete(responses: InteractionResponse[]): Promise<void> {
    const claim = this.claim;
    if (claim === undefined) return;
    try { await this.finishDeck(claim.dir, responses, claim.token); }
    catch (error) { this.status = error instanceof Error ? error.message : String(error); return; }
    this.leaveDetail(false);
    this.rescan();
    this.repaint();
  }

  private leaveDetail(release = true): void {
    this.adapter?.close();
    this.adapter = undefined;
    this.selectedWatcher?.close();
    this.selectedWatcher = undefined;
    if (release && this.claim !== undefined) releaseClaim(this.claim.dir, this.claim.token);
    this.claim = undefined;
    this.screen = 'list';
  }

  private select(index: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
    this.selectedDir = this.items[this.selectedIndex]!.dir;
  }

  private detailSize(): { cols: number; rows: number } {
    const layout = inboxLayout(this.cols, this.rows, this.screen);
    return { cols: Math.max(1, layout.detailWidth - 2), rows: layout.height };
  }

  private detailLines(width: number, rows: number): string[] {
    if (this.adapter !== undefined) return this.adapter.render();
    const selected = this.items[this.selectedIndex];
    if (selected === undefined) return [`  ${DIM}Select a pending interaction.${RESET}`];
    const lines = [`  ${BOLD}${CYAN}${selected.title}${RESET}`, '', `  ${DIM}${selected.kind} · ${selected.source.sessionName ?? selected.source.askedBy ?? 'unknown source'}${RESET}`];
    if (selected.kind === 'deck') {
      const deck = readJson<Deck>(deckPath(selected.dir));
      if (deck !== null) {
        for (const interaction of deck.interactions) {
          lines.push('', `  ${BOLD}${interaction.title}${RESET}`);
          for (const option of interaction.options) lines.push(`    ${DIM}• ${option.label}${RESET}`);
        }
        const saved = readJson<{ responses?: unknown[] }>(progressPath(selected.dir))?.responses;
        lines.push('', `  ${DIM}${Array.isArray(saved) ? saved.length : 0} saved responses${RESET}`);
      }
    }
    if (selected.subtitle) lines.push('', `  ${selected.subtitle}`);
    lines.push('', `  ${DIM}Enter${RESET} open  ${DIM}j/k${RESET} select  ${DIM}q${RESET} close`);
    while (lines.length < rows) lines.push('');
    return lines.map((line) => line.slice(0, width));
  }

  private withStatus(lines: string[]): string[] {
    if (this.status === undefined || this.rows < 1) return lines;
    const next = [...lines];
    while (next.length < this.rows) next.push('');
    next[this.rows - 1] = `${YELLOW}${this.status}${RESET}`;
    return next;
  }

  private repaint(clear = false): void {
    if (this.closed || !this.running) return;
    if (clear) process.stdout.write('\x1b[2J\x1b[H');
    const diff = diffFrame(this.frame, this.render(), this.rows, this.cols);
    process.stdout.write('\x1b[?2026h');
    for (const write of diff.writes) process.stdout.write(write);
    process.stdout.write('\x1b[?2026l');
    this.frame = diff.nextPrevFrame;
  }

  private watchRoots(): void {
    const roots = this.options.roots ?? listInboxRoots().filter((root) => root.available).map((root) => root.root);
    for (const root of roots) {
      try { this.watchers.push(watch(root, () => this.invalidate())); } catch { /* unavailable roots remain discoverable through later rescans */ }
    }
    if (this.options.roots === undefined) {
      try { this.watchers.push(watch(inboxRootsDirectory(), () => this.invalidate())); } catch { /* registry appears after the next explicit open */ }
    }
  }

  private watchSelected(dir: string): void {
    this.selectedWatcher?.close();
    try {
      this.selectedWatcher = watch(dir, (_event, file) => {
        if (file === 'deck.json') this.reloadSelectedDeck();
        else this.invalidate();
      });
    } catch {
      this.selectedWatcher = undefined;
    }
  }
}

function visibleWidth(line: string): number { return line.replace(/\x1b\[[0-9;]*m/g, '').length; }
