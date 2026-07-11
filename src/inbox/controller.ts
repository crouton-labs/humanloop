import { readFileSync, watch, type FSWatcher } from 'node:fs';
import type { Deck, DeckSource, InteractionResponse, ReviewDescriptor, ReviewTicketSummary, TicketSummary } from '../types.js';
import type { Key } from '../tui/terminal.js';
import { getTerminalSize, parseKeypress, restoreTerminal, setupTerminal } from '../tui/terminal.js';
import { diffFrame } from '../tui/render.js';
import { renderMarkdown } from '../render/termrender.js';
import { BOLD, CYAN, DIM, RESET, YELLOW } from '../tui/ansi.js';
import { buildInboxLines } from './tui.js';
import { inboxLayout } from './layout.js';
import { scanInbox } from './scan.js';
import { inboxRootsDirectory, listInboxRoots } from './registry.js';
import { claimTicket, heartbeatClaim, releaseClaim } from './claim.js';
import { completeDeck, readTicketResult } from './tickets.js';
import { reconcileCompletions } from './completion.js';
import { clearProgress, deckPath, progressPath, readJson, reviewPath } from './convention.js';
import { DeckAdapter } from './deck-adapter.js';
import { ReviewAdapter } from './review-adapter.js';

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
  private reviewAdapter: ReviewAdapter | undefined;
  private claim: { dir: string; token: string } | undefined;
  private reconciling = false;
  private suspended = false;
  private submittingDir: string | undefined;
  private stdinListener: ((data: Buffer) => void) | undefined;
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
      // Suppress the "resolved elsewhere" banner when WE are the ones resolving
      // this ticket: the response.json we just published trips the root watch
      // mid-submit, and that is our own completion, not an external event.
      if (priorDir !== this.submittingDir) this.status = canceled ? 'canceled by requester' : 'ticket resolved elsewhere';
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
    // Option/Alt+I (M-i) and Ctrl-C request graceful close from ANY controller
    // mode. A root-table binding cannot fire while the popup grabs client input,
    // so the close-from-open path must live here — checked before adapter
    // forwarding so it works in active deck freetext as well as the list.
    if ((key.ctrl && input === 'c') || isToggleCloseChord(input)) { this.close(); return; }
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
    if (item === undefined) return;
    if (item.kind === 'review') { void this.activateReview(item); return; }
    if (item.kind !== 'deck') return;
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

  /** Claim the review, hand the whole popup TTY to the native editor, then
   *  converge to the on-disk outcome when it exits. Draft/final ownership stays
   *  in ReviewAdapter; the controller only owns the terminal handoff. */
  private async activateReview(item: ReviewTicketSummary): Promise<void> {
    const claim = claimTicket(item.dir);
    if (claim === null) { this.status = 'ticket is being edited by another inbox'; this.repaint(); return; }
    const descriptor = readJson<ReviewDescriptor>(reviewPath(item.dir));
    if (descriptor === null) { releaseClaim(item.dir, claim.token); this.invalidate(); return; }
    this.reviewAdapter = new ReviewAdapter({ dir: item.dir, descriptor, claim });
    this.suspendForChild();
    try {
      await this.reviewAdapter.start();
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.reviewAdapter = undefined;
      this.resumeAfterChild();
      this.rescan();
      this.reconcileRoots();
      this.repaint(true);
    }
  }

  reloadSelectedDeck(): void { this.adapter?.reload(); this.repaint(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.reviewAdapter?.stop();
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
    // Close the crash window between an earlier result publication and its
    // handler launch: dispatch every resolved-but-undelivered ticket now.
    this.reconcileRoots();
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
      this.stdinListener = onData;
      const onResize = () => this.resize();
      let done = false;
      this.finishRun = () => {
        if (done) return;
        done = true;
        process.stdin.removeListener('data', onData);
        this.stdinListener = undefined;
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
    this.submittingDir = claim.dir;
    try { await this.finishDeck(claim.dir, responses, claim.token); }
    catch (error) { this.submittingDir = undefined; this.status = error instanceof Error ? error.message : String(error); return; }
    this.submittingDir = undefined;
    this.leaveDetail(false);
    this.rescan();
    this.reconcileRoots();
    this.repaint();
  }

  /** Give the raw TTY to a child process (native review editor). */
  private suspendForChild(): void {
    this.suspended = true;
    if (this.stdinListener !== undefined) process.stdin.removeListener('data', this.stdinListener);
    restoreTerminal();
  }

  /** Retake the TTY after the child exits and force a full repaint. */
  private resumeAfterChild(): void {
    this.suspended = false;
    if (this.closed) return;
    setupTerminal();
    if (this.stdinListener !== undefined) process.stdin.on('data', this.stdinListener);
    this.frame = [];
  }

  private resolvedRoots(): string[] {
    return this.options.roots ?? listInboxRoots().filter((root) => root.available).map((root) => root.root);
  }

  /** Owner-boundary reconciliation for resolved results still lacking an ack.
   *  Guarded so overlapping fs events cannot stack concurrent scans. */
  private reconcileRoots(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    const roots = this.resolvedRoots();
    void (async () => {
      try { for (const root of roots) { try { await reconcileCompletions(root); } catch { /* undelivered stays for the next pass */ } } }
      finally { this.reconciling = false; }
    })();
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
    const lines = [`  ${BOLD}${CYAN}${selected.title}${RESET}`, '', `  ${DIM}${selected.kind} · ${sourceLabel(selected.source)}${RESET}`];
    if (selected.kind === 'review') {
      lines.push('', `  ${DIM}${selected.file}${RESET}`);
      const draft = readJson<{ comments?: unknown[] }>(progressPath(selected.dir))?.comments;
      const draftCount = Array.isArray(draft) ? draft.length : 0;
      lines.push(`  ${DIM}${draftCount} draft comment${draftCount === 1 ? '' : 's'}${RESET}`, '');
      let md = '';
      try { md = readFileSync(selected.file, 'utf8'); } catch { md = ''; }
      if (md === '') lines.push(`  ${DIM}(source file unavailable)${RESET}`);
      else for (const rendered of renderMarkdown(md, Math.max(1, width - 2))) lines.push(`  ${rendered}`);
      lines.push('', `  ${DIM}Enter${RESET} start review  ${DIM}j/k${RESET} select  ${DIM}q${RESET} close`);
      while (lines.length < rows) lines.push('');
      // Rendered markdown carries ANSI; slicing by column count would sever
      // escape sequences, so review preview lines are returned unsliced.
      return lines;
    }
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
    // While a child owns the TTY (native review), fs-watch invalidations must
    // not scribble the inbox frame over the editor's screen.
    if (this.closed || !this.running || this.suspended) return;
    if (clear) process.stdout.write('\x1b[2J\x1b[H');
    const diff = diffFrame(this.frame, this.render(), this.rows, this.cols);
    process.stdout.write('\x1b[?2026h');
    for (const write of diff.writes) process.stdout.write(write);
    process.stdout.write('\x1b[?2026l');
    this.frame = diff.nextPrevFrame;
  }

  private watchRoots(): void {
    for (const root of this.resolvedRoots()) {
      try { this.watchers.push(watch(root, () => { this.invalidate(); this.reconcileRoots(); })); } catch { /* unavailable roots remain discoverable through later rescans */ }
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

/** M-i (Option/Alt+I) reaches the controller as the two-byte ESC-i sequence. */
function isToggleCloseChord(input: string): boolean { return input === '\x1bi' || input === '\x1bI'; }

/** Prefer a human-meaningful source label, falling back to the raw node id
 *  before an opaque "unknown source" — a crouter ticket always carries nodeId. */
function sourceLabel(source: DeckSource): string { return source.sessionName ?? source.askedBy ?? source.nodeId ?? 'unknown source'; }
