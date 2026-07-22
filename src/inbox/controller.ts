import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Deck, DeckSource, FocusEvent, FollowUpState, InteractionResponse, ReviewDescriptor, ReviewTicketSummary, TicketSummary, VisualHandle, VisualProvider, VisualRequest, VisualResult } from '../types.js';
import type { Key } from '../tui/terminal.js';
import { getTerminalSize, parseKeypress, restoreTerminal, setupTerminal } from '../tui/terminal.js';
import { diffFrame } from '../tui/render.js';
import { renderMarkdown } from '../render/termrender.js';
import { startWebServer, type WebServerHandle } from '../browser/server.js';
import { openBrowser } from '../browser/open.js';
import { renderHandoff } from '../tui/render.js';
import { BOLD, CYAN, DIM, GRAY, RESET, YELLOW, clipLine } from '../tui/ansi.js';
import { buildInboxLines } from './tui.js';
import { inboxLayout } from './layout.js';
import { scanInbox } from './scan.js';
import { inboxActivityPath, inboxRootsDirectory, inboxStateDirectory, listInboxRoots, registeredInboxRoot } from './registry.js';
import { claimTicket, heartbeatClaim, releaseClaim } from './claim.js';
import { completeDeck, readTicketResult, ticketRoot } from './tickets.js';
import { clearProgress, deckPath, progressPath, readJson, responsePath, reviewPath, runHandler, visualsDir } from './convention.js';
import { DeckAdapter } from './deck-adapter.js';
import { validateDeck } from './deck-schema.js';
import { ReviewAdapter } from './review-adapter.js';
import { editBufferInEditor } from '../editor/roundtrip.js';
import { cancelFollowUp, readFollowUp, requestFollowUp } from './followup.js';
import {
  cancelVisualRequest,
  readVisualResult,
  reconcileVisualRequestsForTicket,
  startVisualRequest,
  VISUAL_CAPABILITY,
} from './visual.js';
import { kickInboxMaintenance } from './maintenance.js';

export interface InboxControllerOptions {
  roots?: string[];
  cols?: number;
  rows?: number;
  scan?: (roots?: string[]) => TicketSummary[];
  completeDeck?: (dir: string, responses: InteractionResponse[], token: string) => Promise<unknown>;
  startDeckBrowser?: typeof startWebServer;
  openBrowser?: (url: string) => void;
  visualProvider?: VisualProvider;
  /** Pane underneath a tmux popup. Enables a registered focus handler to
   * reveal the host surface that created the selected ticket. */
  targetPane?: string;
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
  /** Scroll state belongs to the passive preview, never to an editable deck. */
  private previewScrollOffset = 0;
  private screen: Screen = 'list';
  private adapter: DeckAdapter | undefined;
  private activeDeck: Deck | undefined;
  private reviewAdapter: ReviewAdapter | undefined;
  private deckBrowser: WebServerHandle | undefined;
  /** Blocks terminal input until browser finalization/shutdown is quiescent. */
  private deckBrowserTakingBack = false;
  /** The single accepted submit that crossed the browser boundary. */
  private deckBrowserFinalizing: Promise<{ completedAt: string; responsePath: string }> | undefined;
  private deckBrowserStarting = false;
  private deckBrowserStartingGeneration: number | undefined;
  private focusingSource = false;
  /** Invalidates an in-flight asynchronous browser start when ownership ends. */
  private deckBrowserGeneration = 0;
  private claim: { dir: string; token: string } | undefined;
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
      this.previewScrollOffset = 0;
      return;
    }
    this.selectedIndex = Math.min(priorIndex, this.items.length - 1);
    this.selectedDir = this.items[this.selectedIndex]!.dir;
    this.previewScrollOffset = 0;
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
    const list = buildInboxLines(this.items, geometry.listWidth, this.selectedIndex, geometry.height);
    const detail = this.detailLines(geometry.detailWidth, geometry.height);
    if (geometry.mode === 'list') return this.withStatus(list);
    if (geometry.mode === 'detail') return this.withStatus(detail);
    const lines: string[] = [];
    // Dim box-drawing rule in the single-column gutter the layout reserves
    // (detailWidth = cols - listWidth - 1) so the list and detail read as two
    // distinct panels rather than one run-together block.
    const divider = `${GRAY}│${RESET}`;
    for (let i = 0; i < geometry.height; i++) {
      // Hard-clip the list line to its column: an overflowing row would eat
      // the pad and push the divider out of alignment for that row alone.
      const left = clipLine(list[i] ?? '', geometry.listWidth);
      const right = detail[i] ?? '';
      const pad = ' '.repeat(Math.max(0, geometry.listWidth - visibleWidth(left)));
      lines.push(`${left}${pad}${divider}${right}`);
    }
    return this.withStatus(lines);
  }

  handleKey(input: string, key: Key): void {
    // Option/Alt+I (M-i) and Ctrl-C request graceful close from ANY controller
    // mode. A root-table binding cannot fire while the popup grabs client input,
    // so the close-from-open path must live here — checked before adapter
    // forwarding so it works in active deck freetext as well as the list.
    if ((key.ctrl && input === 'c') || isToggleCloseChord(input)) { this.close(); return; }
    // Take-back is an ownership boundary, not an instantaneous UI toggle:
    // discard every key until a pre-existing browser finalizer and the listener
    // have both settled, so terminal edits cannot race browser completion.
    if (this.deckBrowserTakingBack) return;
    if (this.deckBrowser !== undefined) {
      if (input === 'w' || input === 'W') void this.takeBackDeckBrowser();
      return;
    }
    if (this.screen === 'detail' && this.adapter !== undefined) {
      if ((input === 'g' || input === 'G') && this.adapter.canAcceptHostKeys()) {
        void this.focusSelectedSource();
        return;
      }
      if ((input === 'w' || input === 'W') && this.adapter.canAcceptHostKeys()) {
        void this.openDeckBrowser();
        return;
      }
      this.adapter.handleKey(input, key);
      this.repaint();
      return;
    }
    if (key.escape || input === 'q') { this.close(); return; }
    // Passive previews share the deck's documented scroll bindings without
    // claiming or mounting an editable panel. Ctrl+E/Y are line-wise aliases;
    // u/d and Ctrl+U/D/Page keys move a useful chunk.
    if (input === 'd' || key.pageDown || (key.ctrl && (input === 'd' || input === 'e'))) this.scrollPreview(input === 'e' ? 1 : 10);
    else if (input === 'u' || key.pageUp || (key.ctrl && (input === 'u' || input === 'y'))) this.scrollPreview(input === 'y' ? -1 : -10);
    else if (input === 'j' || key.downArrow) this.select(this.selectedIndex + 1);
    else if (input === 'k' || key.upArrow) this.select(this.selectedIndex - 1);
    else if (input === 'g' || input === 'G') void this.focusSelectedSource();
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
    const deck = this.readDeck(item.dir);
    if (deck === undefined) { releaseClaim(item.dir, claim.token); this.claim = undefined; this.invalidate(); return; }
    const root = ticketRoot(item.dir);
    if (root !== null) {
      // A newly acquired claim makes every older running generation stale
      // before the panel can mint its own work. This only dispatches cleanup.
      const retirement = reconcileVisualRequestsForTicket(root, item.dir, claim.token);
      void retirement.delivery.finally(kickInboxMaintenance);
    }
    // Notifications use the same canonical deck panel as every other deck:
    // opening is not acknowledgement; panel completion is.
    this.activeDeck = deck;
    const followUp = this.followUpHandlers(item.dir, deck);
    this.screen = 'detail';
    this.adapter = new DeckAdapter({
      dir: item.dir,
      deck,
      cols: this.detailSize().cols,
      rows: this.detailSize().rows,
      onDirty: () => this.repaint(),
      visualProvider: this.visualProviderFor(item.dir, deck, claim.token),
      onEditorRequest: () => this.editActiveDeckInput(),
      followUpAvailable: followUp.available,
      onFollowUpRequest: followUp.onRequest,
      onFollowUpCancel: followUp.onCancel,
      onBack: () => { this.leaveDetail(); this.repaint(); },
      onComplete: (responses) => { void this.complete(responses); },
    });
    if (followUp.available) this.adapter.setFollowUpState(this.followUpViewState(item.dir));
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
    let closeRequested = false;
    this.reviewAdapter = new ReviewAdapter({ dir: item.dir, descriptor, claim, onClose: () => { closeRequested = true; } });
    this.suspendForChild();
    try {
      await this.reviewAdapter.start();
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.reviewAdapter = undefined;
      // M-i inside native review is a graceful close of the WHOLE inbox: the
      // adapter already saved the draft and released the claim, so just tear the
      // controller down instead of returning to the list. The ticket stays
      // pending because no submit flag was written.
      if (closeRequested) { this.suspended = false; this.close(); }
      else {
        this.resumeAfterChild();
        this.rescan();
        this.repaint(true);
      }
    }
  }

  reloadSelectedDeck(): void {
    if (this.adapter === undefined || this.claim === undefined) { this.repaint(); return; }
    const deck = this.readDeck(this.claim.dir);
    if (deck === undefined) { this.repaint(); return; }
    this.activeDeck = deck;
    const followUp = this.followUpHandlers(this.claim.dir, deck);
    this.adapter.setFollowUpHandlers(followUp.available, followUp.onRequest, followUp.onCancel);
    // Reload replaces the capability before it mints the next panel generation.
    this.adapter.reload(deck, this.visualProviderFor(this.claim.dir, deck, this.claim.token));
    if (followUp.available) this.adapter.setFollowUpState(this.followUpViewState(this.claim.dir));
    this.repaint();
  }

  private followUpHandlers(dir: string, deck: Deck): { available: boolean; onRequest?: (question: string) => void; onCancel?: () => void } {
    const root = ticketRoot(dir);
    const available = root !== null && registeredInboxRoot(root)?.followUpHandler !== undefined && isAnswerBearingDeck(deck);
    if (!available) return { available: false };
    return {
      available: true,
      onRequest: (question) => {
        requestFollowUp(root!, dir, { question });
        this.refreshFollowUp(dir);
      },
      onCancel: () => {
        cancelFollowUp(root!, dir);
        this.refreshFollowUp(dir);
      },
    };
  }

  private readDeck(dir: string): Deck | undefined {
    const deck = readJson<Deck>(deckPath(dir));
    if (deck === null) return undefined;
    try { return validateDeck(deck); } catch { return undefined; }
  }

  private followUpViewState(dir: string): FollowUpState {
    const { request, result } = readFollowUp(dir);
    if (request === null) return { status: 'idle' };
    if (result !== null && result.requestId === request.requestId) {
      return result.status === 'ready'
        ? { status: 'ready', markdown: result.markdown! }
        : { status: 'error', error: result.error! };
    }
    return request.state === 'running' ? { status: 'running' } : { status: 'idle' };
  }

  private refreshFollowUp(dir: string): void {
    if (this.adapter === undefined || this.claim?.dir !== dir || this.activeDeck === undefined) return;
    const followUp = this.followUpHandlers(dir, this.activeDeck);
    this.adapter.setFollowUpHandlers(followUp.available, followUp.onRequest, followUp.onCancel);
    if (followUp.available) this.adapter.setFollowUpState(this.followUpViewState(dir));
    this.repaint();
  }

  /** Hand the selected deck to its browser surface while retaining this ticket's claim. */
  private async openDeckBrowser(): Promise<void> {
    if (this.deckBrowser !== undefined || this.deckBrowserStarting || this.adapter === undefined || this.claim === undefined) return;
    const item = this.items[this.selectedIndex];
    if (item?.kind !== 'deck' || item.dir !== this.claim.dir) return;
    const deck = readJson<Deck>(deckPath(item.dir));
    if (deck === null) return;
    this.deckBrowserStarting = true;
    const generation = ++this.deckBrowserGeneration;
    this.deckBrowserStartingGeneration = generation;
    const claim = this.claim;
    const adapter = this.adapter;
    try {
      const start = this.options.startDeckBrowser ?? startWebServer;
      let browser: WebServerHandle;
      browser = await start({
        dir: item.dir,
        deck,
        finalize: async (responses) => this.finalizeDeckBrowser(item.dir, claim.token, generation, responses),
        onSubmit: () => this.finishDeckBrowser(item.dir, browser),
      });
      // Closing, taking back, or losing the claim while listen() was pending
      // retires this start. Stop the fresh listener before it can open a tab.
      if (this.closed || generation !== this.deckBrowserGeneration || this.claim?.token !== claim.token || this.adapter !== adapter) {
        await browser.stop();
        return;
      }
      this.deckBrowser = browser;
      (this.options.openBrowser ?? openBrowser)(browser.url);
    } catch (error) {
      if (!this.closed && generation === this.deckBrowserGeneration) this.status = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.deckBrowserStartingGeneration === generation) {
        this.deckBrowserStarting = false;
        this.deckBrowserStartingGeneration = undefined;
      }
      this.repaint();
    }
  }

  /** Finalize through this controller's claim-safe lifecycle before HTTP acks. */
  private async finalizeDeckBrowser(dir: string, token: string, generation: number, responses: InteractionResponse[]): Promise<{ completedAt: string; responsePath: string }> {
    // The generation advances synchronously at take-back's ownership boundary.
    // A request that reaches the listener after that point must fail before it
    // can write, even while stop() is still closing HTTP connections.
    if (this.deckBrowserTakingBack || generation !== this.deckBrowserGeneration || this.claim?.dir !== dir || this.claim.token !== token) {
      throw new Error('browser handoff no longer owns this ticket');
    }
    // The server's HTTP single-assignment marker is published after its
    // finalizer resolves, so simultaneous tabs can both reach us first. Share
    // the first finalizer rather than starting another write or replacing the
    // promise take-back must wait on.
    if (this.deckBrowserFinalizing !== undefined) return this.deckBrowserFinalizing;
    const finalizing = (async () => {
      await this.finishDeck(dir, responses, token);
      const result = readTicketResult(dir);
      if (result?.kind !== 'deck') throw new Error('ticket did not produce a deck result');
      return { completedAt: result.completedAt, responsePath: responsePath(dir) };
    })();
    this.deckBrowserFinalizing = finalizing;
    try {
      return await finalizing;
    } finally {
      if (this.deckBrowserFinalizing === finalizing) this.deckBrowserFinalizing = undefined;
    }
  }

  /** The browser has finalized through the controller; reconcile its owner delivery. */
  private async finishDeckBrowser(dir: string, browser: WebServerHandle): Promise<void> {
    if (this.deckBrowser === browser) this.deckBrowser = undefined;
    await browser.stop();
    if (this.claim?.dir === dir) this.leaveDetail();
    this.rescan();
    this.repaint();
  }

  /** Return browser authority to the terminal deck without changing its draft. */
  private async takeBackDeckBrowser(): Promise<void> {
    const browser = this.deckBrowser;
    if (browser === undefined || this.deckBrowserTakingBack) return;
    // Invalidate newly-arriving browser submits before awaiting anything. Keep
    // the handoff mounted and terminal input blocked until its running submit
    // (if any) has conclusively won or failed and the listener is gone.
    this.deckBrowserTakingBack = true;
    this.deckBrowserGeneration++;
    try {
      // A request that crossed the server boundary before this ownership change
      // must own its normal finish path: it includes the HTTP 200 flush and
      // onSubmit convergence before it stops the listener. Do not force-close
      // that response after merely observing controller persistence.
      const lifecycle = browser.pendingSubmitLifecycle?.();
      if (lifecycle !== undefined && await lifecycle.catch(() => false)) return;
      await browser.requestTakeBack();
      await browser.stop();
    } finally {
      if (this.deckBrowser === browser) this.deckBrowser = undefined;
      this.deckBrowserTakingBack = false;
      this.rescan();
      this.repaint(true);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deckBrowserGeneration++;
    this.deckBrowserTakingBack = false;
    this.deckBrowserStarting = false;
    void this.reviewAdapter?.stop();
    const browser = this.deckBrowser;
    this.deckBrowser = undefined;
    void browser?.stop();
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
    // Crash repair is durable but never part of a human keystroke.
    kickInboxMaintenance();
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
    this.repaint();
  }

  /** The controller owns the terminal handoff and repaint around $EDITOR. */
  private editActiveDeckInput(): void {
    const buffer = this.adapter?.inputBuffer();
    if (buffer === undefined) return;
    this.suspendForChild();
    let result: ReturnType<typeof editBufferInEditor> = { text: buffer };
    try {
      result = editBufferInEditor(buffer);
    } finally {
      this.resumeAfterChild();
      this.adapter?.setInputBuffer(result.text);
      this.resize();
      if (result.error !== undefined) this.status = result.error;
      this.repaint(true);
    }
  }

  /** Give the raw TTY to a child process (native review editor or $EDITOR). */
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

  /** Automatic ticket capability is deliberately marker + current-root-handler only. */
  private visualProviderFor(dir: string, deck: Deck, claimToken: string): VisualProvider | undefined {
    // An inline provider is intentional host injection, independent of ticket capability.
    if (this.options.visualProvider !== undefined) return this.options.visualProvider;
    const root = ticketRoot(dir);
    if (root === null || deck.source?.visual !== VISUAL_CAPABILITY || registeredInboxRoot(root)?.visualHandler === undefined) return undefined;
    return (request) => this.startTicketVisual(root, dir, claimToken, request);
  }

  private startTicketVisual(root: string, dir: string, claimToken: string, request: VisualRequest): VisualHandle {
    let watcher: FSWatcher | undefined;
    let settled = false;
    let settle!: (result: VisualResult) => void;
    const result = new Promise<VisualResult>((resolve) => { settle = resolve; });
    const finish = (outcome: VisualResult) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      watcher = undefined;
      settle(outcome);
    };
    let started: ReturnType<typeof startVisualRequest>;
    try {
      started = startVisualRequest({ root, dir, claimToken, request });
    } catch (error) {
      finish({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      return { result, cancel: () => {} };
    }
    const reread = () => {
      if (settled) return;
      try {
        const outcome = readVisualResult(root, dir, request.requestId);
        if (outcome === null) return;
        finish(outcome.status === 'ready'
          ? { status: 'ready', markdown: outcome.markdown }
          : { status: 'error', error: outcome.error });
      } catch (error) {
        finish({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    };
    try {
      // Install the watch before the first durable reread so a publication in
      // the narrow setup window is either observed or found by that reread.
      watcher = watch(join(visualsDir(dir), request.requestId), () => reread());
      watcher.once('error', (error) => finish({ status: 'error', error: error.message }));
      reread();
    } catch (error) {
      finish({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    void started.delivery.then(reread, (error) => finish({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return {
      result,
      cancel: () => {
        watcher?.close();
        watcher = undefined;
        void cancelVisualRequest(root, dir, request.requestId).finally(kickInboxMaintenance);
      },
    };
  }

  private leaveDetail(release = true): void {
    this.deckBrowserGeneration++;
    // A stale listener will stop itself after its await, but this controller
    // may immediately claim another ticket and start a fresh browser handoff.
    this.deckBrowserStarting = false;
    this.adapter?.close();
    this.adapter = undefined;
    this.activeDeck = undefined;
    this.selectedWatcher?.close();
    this.selectedWatcher = undefined;
    if (release && this.claim !== undefined) releaseClaim(this.claim.dir, this.claim.token);
    this.claim = undefined;
    this.screen = 'list';
  }

  private select(index: number): void {
    if (this.items.length === 0) return;
    const next = Math.max(0, Math.min(index, this.items.length - 1));
    if (next !== this.selectedIndex) this.previewScrollOffset = 0;
    this.selectedIndex = next;
    this.selectedDir = this.items[this.selectedIndex]!.dir;
  }

  private scrollPreview(delta: number): void {
    this.previewScrollOffset = Math.max(0, this.previewScrollOffset + delta);
  }

  private detailSize(): { cols: number; rows: number } {
    const layout = inboxLayout(this.cols, this.rows, this.screen);
    return { cols: Math.max(1, layout.detailWidth - 2), rows: layout.height };
  }

  private detailLines(width: number, rows: number): string[] {
    if (this.deckBrowser !== undefined) return renderHandoff(this.deckBrowser.url, width, rows);
    if (this.deckBrowserStarting) return [`  ${DIM}Opening browser review…${RESET}`];
    if (this.adapter !== undefined) return this.adapter.render();
    const selected = this.items[this.selectedIndex];
    if (selected === undefined) return this.previewViewport(this.passiveDetailLines(width), width, rows);
    const focusHint = this.focusAvailable(selected.dir) ? `  ${DIM}g${RESET} chat` : '';
    const footer = selected.kind === 'deck'
      ? [`  ${DIM}Enter${RESET} opens the full ticket  ${DIM}u/d${RESET} scroll  ${DIM}j/k${RESET} select`, `  ${DIM}Active ask:${RESET} c comment  u/d scroll  w browser${focusHint}  ${DIM}q${RESET} close`]
      : [`  ${DIM}Enter${RESET} opens the full review  ${DIM}u/d${RESET} scroll  ${DIM}j/k${RESET} select`, ` ${focusHint}  ${DIM}q${RESET} close`];
    return [...this.previewViewport(this.passiveDetailLines(width), width, Math.max(0, rows - footer.length)), ...footer.map((line) => clipLine(line, width))];
  }

  private focusAvailable(dir: string): boolean {
    const root = ticketRoot(dir);
    return this.options.targetPane !== undefined && root !== null && registeredInboxRoot(root)?.focusHandler !== undefined;
  }

  /** Ask the registered host to reveal this ticket's source beside the pane
   * underneath the popup. The popup closes only after the host acknowledges
   * that focus succeeded, so a failure remains visible as status. */
  private async focusSelectedSource(): Promise<void> {
    const item = this.items[this.selectedIndex];
    const targetPane = this.options.targetPane;
    if (item === undefined || targetPane === undefined || this.focusingSource) return;
    const root = ticketRoot(item.dir);
    const registration = root === null ? null : registeredInboxRoot(root);
    if (root === null || registration?.focusHandler === undefined) return;
    const event: FocusEvent = { schema: 'humanloop.focus/v1', root, dir: item.dir, ticketId: item.id, targetPane };
    this.focusingSource = true;
    try {
      await runHandler(registration.focusHandler.command, registration.focusHandler.args, event);
      this.close();
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      this.repaint();
    } finally {
      this.focusingSource = false;
    }
  }

  private passiveDetailLines(width: number): string[] {
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
    } else {
      const deck = readJson<Deck>(deckPath(selected.dir));
      if (deck !== null) {
        for (const interaction of deck.interactions) {
          lines.push('', `  ${BOLD}${interaction.title}${RESET}`);
          if (interaction.subtitle) for (const rendered of renderMarkdown(interaction.subtitle, Math.max(1, width - 2))) lines.push(`  ${rendered}`);
          if (interaction.body) for (const rendered of renderMarkdown(interaction.body, Math.max(1, width - 2))) lines.push(`  ${rendered}`);
          for (const option of interaction.options) lines.push(`    ${DIM}• ${option.label}${RESET}`);
        }
        const saved = readJson<{ responses?: unknown[] }>(progressPath(selected.dir))?.responses;
        lines.push('', `  ${DIM}${Array.isArray(saved) ? saved.length : 0} saved responses${RESET}`);
      }
    }
    return lines.map((line) => clipLine(line, width));
  }

  private previewViewport(lines: string[], width: number, rows: number): string[] {
    if (rows < 1) return [];
    const maxOffset = Math.max(0, lines.length - Math.max(1, rows - 1));
    this.previewScrollOffset = Math.min(this.previewScrollOffset, maxOffset);
    const start = this.previewScrollOffset;
    const hasAbove = start > 0;
    // Reserve an indicator row before selecting content so a remaining tail is
    // always signalled instead of silently disappearing below the viewport.
    let contentRows = rows - (hasAbove ? 1 : 0);
    let end = Math.min(lines.length, start + contentRows);
    const hasBelow = end < lines.length;
    if (hasBelow) { contentRows--; end = Math.min(lines.length, start + Math.max(0, contentRows)); }
    const out: string[] = [];
    if (hasAbove) out.push(`  ${DIM}↑ more above${RESET}`);
    out.push(...lines.slice(start, end));
    if (hasBelow) out.push(`  ${DIM}↓ more below${RESET}`);
    while (out.length < rows) out.push('');
    return out.map((line) => clipLine(line, width));
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
    // A single state-level activity marker replaces one watcher per historical
    // root. Closing hundreds of fs watchers was itself a multi-second UI path.
    const activity = basename(inboxActivityPath());
    try {
      this.watchers.push(watch(inboxStateDirectory(), (_event, file) => {
        if (String(file) === activity) { this.invalidate(); kickInboxMaintenance(); }
      }));
    } catch { /* the state directory appears when the next ticket is submitted */ }
    if (this.options.roots === undefined) {
      try { this.watchers.push(watch(inboxRootsDirectory(), () => { this.invalidate(); kickInboxMaintenance(); })); } catch { /* registry appears after the next explicit open */ }
    }
  }

  private watchSelected(dir: string): void {
    this.selectedWatcher?.close();
    try {
      this.selectedWatcher = watch(dir, (_event, file) => {
        if (file === 'deck.json') { this.reloadSelectedDeck(); return; }
        if (file === 'followup-result.json' || file === 'followup-request.json') { this.refreshFollowUp(dir); return; }
        this.invalidate();
      });
    } catch {
      this.selectedWatcher = undefined;
    }
  }
}

function visibleWidth(line: string): number { return line.replace(/\x1b\[[0-9;]*m/g, '').length; }

/** M-i (Option/Alt+I) reaches the controller as the two-byte ESC-i sequence. */
function isToggleCloseChord(input: string): boolean { return input === '\x1bi' || input === '\x1bI'; }

function isAnswerBearingDeck(deck: Deck): boolean {
  return deck.interactions.some((interaction) => interaction.kind !== 'notify');
}

/** Prefer a human-meaningful source label, falling back to the raw node id
 *  before an opaque "unknown source" — a crouter ticket always carries nodeId. */
function sourceLabel(source: DeckSource): string { return source.sessionName ?? source.askedBy ?? source.nodeId ?? 'unknown source'; }
