import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type {
  Deck, TuiState, Interaction, InteractionResponse,
  MountedPanel, MountedPanelOpts, GenerateVisual,
} from '../types.js';
import { setupTerminal, restoreTerminal, parseKeypress, getTerminalSize } from './terminal.js';
import { diffFrame, renderOverview, renderItemReview, renderFinal, renderHandoff, clampItemReviewScroll } from './render.js';
import { handleKeypress, assignShortcuts } from './input.js';
import { visualGeneratorForConversationSession } from '../visuals/conversation.js';
import { editBufferInEditor } from '../editor/roundtrip.js';
import { validateDeck } from '../inbox/deck-schema.js';
import { progressPath as progressPathFor, deckPath as deckPathFor, writeResponse, clearProgress } from '../inbox/convention.js';
import { startWebServer } from '../browser/server.js';
import type { WebServerHandle } from '../browser/server.js';
import { openBrowser } from '../browser/open.js';

/** Validate an arbitrary parsed value as a Deck. Delegates to the canonical
 * Zod validator in `inbox/deck-schema.ts` (the single source of truth shared
 * with sisyphus). Kept exported for back-compat. */
export function validateInput(parsed: unknown): Deck {
  return validateDeck(parsed);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildInitialState(deck: Deck, editorAvailable = false): TuiState {
  // Single-question decks skip the overview list — there's nothing to overview,
  // and overview hides the option hotkeys so users press 'y' and nothing happens.
  const initialPhase = deck.interactions.length === 1 ? 'item-review' : 'overview';
  const responses = new Map<string, InteractionResponse>();
  const preAnsweredIds = new Set<string>();
  // Seed responses + preAnsweredIds from any `preAnswered` field. The seeded
  // response counts as answered for navigation/auto-advance, but is rendered
  // distinctly so the human knows it carried over. `tryResume` runs after and
  // takes priority — mid-deck progress should not be overwritten by defaults.
  for (const interaction of deck.interactions) {
    const pa = interaction.preAnswered;
    if (pa === undefined) continue;
    const response: InteractionResponse = { id: interaction.id };
    if (pa.selectedOptionId !== undefined) response.selectedOptionId = pa.selectedOptionId;
    if (pa.selectedOptionIds !== undefined) response.selectedOptionIds = [...pa.selectedOptionIds];
    if (pa.freetext !== undefined) response.freetext = pa.freetext;
    responses.set(interaction.id, response);
    preAnsweredIds.add(interaction.id);
  }
  // Start cursor on the first unanswered interaction — humans land where they
  // need to act. If every interaction is pre-answered, fall back to index 0.
  const firstUnanswered = deck.interactions.findIndex((i) => !responses.has(i.id));
  return {
    phase: initialPhase,
    currentIndex: firstUnanswered >= 0 ? firstUnanswered : 0,
    interactions: deck.interactions,
    responses,
    visuals: new Map(),
    preAnsweredIds,
    inputMode: null,
    selectedAction: 0,
    detailExpanded: false,
    scrollOffset: 0,
    editorAvailable,
  };
}

function collectResponses(state: TuiState): InteractionResponse[] {
  const out: InteractionResponse[] = [];
  for (const interaction of state.interactions) {
    const r = state.responses.get(interaction.id);
    if (r !== undefined) out.push(r);
  }
  return out;
}

function tryResume(state: TuiState, progressPath: string, interactions: Interaction[]): void {
  try {
    const prior = JSON.parse(readFileSync(progressPath, 'utf8')) as { responses?: InteractionResponse[] };
    if (!Array.isArray(prior.responses)) return;
    const validIds = new Set(interactions.map((i) => i.id));
    for (const r of prior.responses) {
      if (validIds.has(r.id)) state.responses.set(r.id, r);
    }
    const firstUnanswered = interactions.findIndex((i) => !state.responses.has(i.id));
    state.currentIndex = firstUnanswered >= 0 ? firstUnanswered : 0;
  } catch {
    // corrupt or missing progress file — start fresh
  }
}

function atomicWriteProgress(progressPath: string, responses: InteractionResponse[]): void {
  const payload = JSON.stringify({ partial: true, responses, savedAt: new Date().toISOString() }, null, 2);
  const tmp = `${progressPath}.tmp`;
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, progressPath);
  } catch {
    // best-effort
  }
}

// ── mountPanel ────────────────────────────────────────────────────────────────

interface PanelInternals {
  state: TuiState;
  cols: number;
  rows: number;
  mounted: boolean;
  generateVisual: GenerateVisual | undefined;
  visualGeneration: number;
  progressPath: string | undefined;
  callbacks: {
    onProgress: MountedPanelOpts['onProgress'];
    onComplete: MountedPanelOpts['onComplete'];
    onExit: MountedPanelOpts['onExit'];
    onDirty: MountedPanelOpts['onDirty'];
    onEditorRequest: MountedPanelOpts['onEditorRequest'];
  };
}

function rebindPersist(internals: PanelInternals): void {
  internals.state.persist = () => {
    const responses = collectResponses(internals.state);
    if (internals.progressPath !== undefined) atomicWriteProgress(internals.progressPath, responses);
    internals.callbacks.onProgress?.(responses);
  };
}

function fireVisuals(internals: PanelInternals, interactions: Interaction[]): void {
  if (internals.generateVisual === undefined) return;
  const gen = internals.generateVisual;
  const generation = ++internals.visualGeneration;
  for (const interaction of interactions) {
    internals.state.visuals.set(interaction.id, { questionId: interaction.id, content: '', status: 'loading' });
    gen(interaction, internals.cols).then((r) => {
      if (!internals.mounted || generation !== internals.visualGeneration) return;
      if (!internals.state.interactions.some((x) => x.id === interaction.id)) return;
      internals.state.visuals.set(interaction.id, r.ok
        ? { questionId: interaction.id, content: r.ansi, status: 'ready' }
        : { questionId: interaction.id, content: '', status: 'error' });
      internals.callbacks.onDirty?.();
    }).catch(() => {
      if (!internals.mounted || generation !== internals.visualGeneration) return;
      if (!internals.state.interactions.some((x) => x.id === interaction.id)) return;
      internals.state.visuals.set(interaction.id, { questionId: interaction.id, content: '', status: 'error' });
      internals.callbacks.onDirty?.();
    });
  }
}

export function mountPanel(opts: MountedPanelOpts): MountedPanel {
  const internals: PanelInternals = {
    state: buildInitialState(opts.deck, opts.onEditorRequest !== undefined),
    cols: opts.cols,
    rows: opts.rows,
    mounted: true,
    generateVisual: opts.generateVisual,
    visualGeneration: 0,
    progressPath: opts.progressPath,
    callbacks: { onProgress: opts.onProgress, onComplete: opts.onComplete, onExit: opts.onExit, onDirty: opts.onDirty, onEditorRequest: opts.onEditorRequest },
  };

  assignShortcuts(internals.state.interactions);
  rebindPersist(internals);
  if (internals.progressPath !== undefined) {
    tryResume(internals.state, internals.progressPath, opts.deck.interactions);
  }
  fireVisuals(internals, opts.deck.interactions);

  const renderLines = (): string[] => {
    switch (internals.state.phase) {
      case 'overview':    return renderOverview(internals.state, internals.cols, internals.rows);
      case 'item-review': return renderItemReview(internals.state, internals.cols, internals.rows);
      case 'final':       return renderFinal(internals.state, internals.cols, internals.rows);
    }
  };

  return {
    handleKey(input, key) {
      if (!internals.mounted) return;

      if (key.ctrl && input === 'o' && internals.state.inputMode !== null && internals.callbacks.onEditorRequest !== undefined) {
        internals.callbacks.onEditorRequest();
        return;
      }

      const onAutoComplete = () => {
        const responses = collectResponses(internals.state);
        if (internals.progressPath !== undefined) {
          try { unlinkSync(internals.progressPath); } catch { /* ignore */ }
        }
        internals.callbacks.onComplete?.(responses);
      };

      handleKeypress(input, key, internals.state, () => {}, () => {
        const responses = collectResponses(internals.state);
        if (responses.length >= internals.state.interactions.length) {
          onAutoComplete();
        } else {
          internals.callbacks.onExit?.();
        }
      });

      // Pre-render clamp (input layer): keep scrollOffset within the current
      // body's bounds so u/d stay responsive. The renderer itself is pure.
      if (internals.state.phase === 'item-review') {
        clampItemReviewScroll(internals.state, internals.cols, internals.rows);
      }
    },

    render() {
      if (!internals.mounted) return [];
      return renderLines();
    },

    handleResize(cols, rows) {
      internals.cols = cols;
      internals.rows = rows;
      // New dimensions change the scroll bounds — re-clamp before laying out.
      if (internals.state.phase === 'item-review') {
        clampItemReviewScroll(internals.state, cols, rows);
      }
      fireVisuals(internals, internals.state.interactions);
      return renderLines();
    },

    unmount() {
      internals.mounted = false;
      internals.state.visuals.clear();
      internals.state.persist = undefined;
    },

    loadDeck(deck, loadOpts) {
      if (!internals.mounted) return;
      const prior = collectResponses(internals.state);
      internals.state = buildInitialState(deck, internals.callbacks.onEditorRequest !== undefined);
      if (loadOpts !== undefined && loadOpts.progressPath !== undefined) {
        internals.progressPath = loadOpts.progressPath;
      }
      assignShortcuts(internals.state.interactions);
      rebindPersist(internals);
      if (internals.progressPath !== undefined) {
        tryResume(internals.state, internals.progressPath, deck.interactions);
      }
      // A live request replacement is allowed to add/remove questions but not
      // discard answers the human has already made to surviving ids.
      const validIds = new Set(deck.interactions.map((interaction) => interaction.id));
      for (const response of prior) {
        if (validIds.has(response.id)) internals.state.responses.set(response.id, response);
      }
      const currentId = internals.state.interactions[internals.state.currentIndex]?.id;
      if (currentId === undefined || !validIds.has(currentId)) {
        const firstUnanswered = internals.state.interactions.findIndex((interaction) => !internals.state.responses.has(interaction.id));
        internals.state.currentIndex = firstUnanswered >= 0 ? firstUnanswered : 0;
      }
      fireVisuals(internals, deck.interactions);
    },

    canAcceptHostKeys() {
      if (!internals.mounted) return false;
      return internals.state.inputMode === null;
    },

    atDeckTop() {
      if (!internals.mounted) return true;
      return internals.state.phase === 'overview' && internals.state.inputMode === null;
    },

    getInputBuffer() {
      if (!internals.mounted || internals.state.inputMode === null) return undefined;
      return internals.state.inputMode.buffer;
    },

    setInputBuffer(text) {
      if (!internals.mounted || internals.state.inputMode === null) return;
      internals.state.inputMode.buffer = text;
      internals.state.inputMode.cursor = [...text].length;
    },
  };
}

// ── Dir-based resolver (interaction-directory convention) ─────────────────────

export interface ResolveDirOpts {
  /** Originating provider session id → per-interaction visual context from history. */
  sessionId?: string;
  /** Explicit visual generator; overrides the sessionId default. */
  generateVisual?: GenerateVisual;
  cols?: number;
  rows?: number;
}

/**
 * Resolve an interaction directory in place: mount the panel TUI keyed off
 * `<dir>/progress.json`, and on finish (full completion OR human-finished
 * with skips) write `<dir>/response.json` atomically and drop the progress
 * file. A hard process kill leaves `progress.json` for a later resume —
 * `tryResume` (unchanged logic) reads the new dir-derived path.
 *
 * While the panel is mounted, `<dir>/deck.json` is polled for changes (an
 * agent calling `hl deck update`). On a valid rewrite the panel is reloaded
 * in place via `loadDeck`, so the human's pane reflects the new questions
 * without a respawn; answers for surviving interaction ids are kept. The
 * returned `deck` is the one actually answered (post-reload).
 */
export async function resolveInteractionDir(
  dir: string,
  deck: Deck,
  opts: ResolveDirOpts = {},
): Promise<{ responses: InteractionResponse[]; completedAt: string; responsePath: string; deck: Deck }> {
  setupTerminal();
  const term = getTerminalSize();
  const cols = opts.cols ?? term.cols;
  const rows = opts.rows ?? term.rows;

  const generateVisual: GenerateVisual | undefined =
    opts.generateVisual ?? (opts.sessionId === undefined ? undefined : visualGeneratorForConversationSession(opts.sessionId));

  return new Promise<{ responses: InteractionResponse[]; completedAt: string; responsePath: string; deck: Deck }>((resolve) => {
    let panel: MountedPanel | null = null;
    let prevFrameLocal: string[] = [];
    let lastResponses: InteractionResponse[] = [];
    let onData!: (data: Buffer) => void;
    // The deck the human is actually answering. An agent may replace it
    // mid-flight via `hl deck update` (atomic deck.json rewrite); the poller
    // below reloads the panel in place and tracks the live deck here so the
    // returned envelope/summary describes what was answered, not the kickoff.
    let currentDeck: Deck = deck;
    let deckWatch: ReturnType<typeof setInterval> | null = null;
    // Guards finalize() against running twice. The server already makes
    // /api/submit single-assignment (only the first accepted submit fires
    // onSubmit), but finalize() is also reachable via onComplete/onExit/a
    // hard Ctrl+C during handoff — this is defense-in-depth so a second call
    // from any path is a no-op instead of double-tearing-down (stop() twice,
    // removeListener on an already-removed listener) and resolving the outer
    // promise a second time.
    let finalized = false;
    // Set while the panel has handed control to the browser (the `w` keybind
    // below). Non-null means: the panel renders nothing, the host renders the
    // handoff screen instead, and only the take-back key reaches this loop.
    let handoff: WebServerHandle | null = null;

    const flushHost = (lines: string[]) => {
      const { cols: currentCols, rows: currentRows } = getTerminalSize();
      const { writes, nextPrevFrame } = diffFrame(prevFrameLocal, lines, currentRows, currentCols);
      process.stdout.write('\x1b[?2026h');
      for (const w of writes) process.stdout.write(w);
      process.stdout.write('\x1b[?2026l');
      prevFrameLocal = nextPrevFrame;
    };

    // On resize the terminal reflows/scrolls existing content, so the diff
    // model no longer matches the screen: re-layout at the new size, clear
    // everything, and redraw from scratch.
    const onResize = () => {
      const { cols: c, rows: r } = getTerminalSize();
      if (handoff !== null) {
        prevFrameLocal = [];
        process.stdout.write('\x1b[2J\x1b[H');
        flushHost(renderHandoff(handoff.url, c, r));
        return;
      }
      if (panel === null) return;
      const lines = panel.handleResize(c, r);
      prevFrameLocal = [];
      process.stdout.write('\x1b[2J\x1b[H');
      flushHost(lines);
    };

    // `written` is set when the browser (not this function) already wrote
    // response.json via the web server's /api/submit — the canonical write
    // happens exactly once, whichever surface produced it; this just converges
    // the terminal side and resolves the promise with what's already on disk.
    const finalize = (
      responses: InteractionResponse[],
      written?: { responsePath: string; completedAt: string },
    ) => {
      if (finalized) return;
      finalized = true;
      if (deckWatch !== null) { clearInterval(deckWatch); deckWatch = null; }
      if (handoff !== null) { const h = handoff; handoff = null; void h.stop(); }
      restoreTerminal();
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      panel?.unmount();
      if (written !== undefined) {
        resolve({ responses, completedAt: written.completedAt, responsePath: written.responsePath, deck: currentDeck });
        return;
      }
      const completedAt = new Date().toISOString();
      // Resolved supersedes in-progress: write response.json, drop progress.json.
      const rp = writeResponse(dir, responses, completedAt, currentDeck);
      clearProgress(dir);
      resolve({ responses, completedAt, responsePath: rp, deck: currentDeck });
    };

    panel = mountPanel({
      deck,
      progressPath: progressPathFor(dir),
      cols,
      rows,
      generateVisual,
      onEditorRequest: () => {
        const buffer = panel?.getInputBuffer();
        if (buffer !== undefined) runEditorEscapeHatch(buffer);
      },
      onProgress: (responses) => {
        lastResponses = responses;
        if (panel !== null) flushHost(panel.render());
      },
      onComplete: finalize,
      onExit: () => {
        finalize(lastResponses);
      },
      // Async visual finished loading between keystrokes — repaint so the
      // "loading context..." placeholder is replaced immediately.
      onDirty: () => {
        if (panel !== null) flushHost(panel.render());
      },
    });

    flushHost(panel.render());

    // ── Live deck reload ──────────────────────────────────────────────────
    // Poll deck.json mtime (cheap stat; full read only on change). atomicWrite
    // does write-tmp + rename, so stat/read always see a whole file — no
    // fs.watch rename flakiness. The TUI never writes deck.json, so there is
    // no feedback loop. A structurally identical rewrite is ignored so a
    // no-op touch never disrupts the human mid-answer.
    const deckFile = deckPathFor(dir);
    const deckMtime = (): number => {
      try { return statSync(deckFile).mtimeMs; } catch { return 0; }
    };
    let lastDeckMtime = deckMtime();
    let lastDeckJson = JSON.stringify(currentDeck);
    deckWatch = setInterval(() => {
      if (panel === null) return;
      // Deck reload is deferred while handed off — the browser already fetched
      // a snapshot and applying loadDeck() here would repaint the (currently
      // hidden) panel over the handoff screen. Re-checked on the next tick
      // after take-back, so a `hl deck update` mid-handoff is not lost.
      if (handoff !== null) return;
      const m = deckMtime();
      if (m === 0 || m === lastDeckMtime) return;
      lastDeckMtime = m;
      let nextDeck: Deck;
      try {
        const parsed = JSON.parse(readFileSync(deckFile, 'utf8'));
        nextDeck = validateDeck(parsed);
      } catch {
        // Mid-rename, invalid, or rejected by schema: keep the live deck,
        // retry on the next tick. `hl deck update` validates before writing,
        // so a persistently bad file is an out-of-band edit, not our concern.
        return;
      }
      const nextJson = JSON.stringify(nextDeck);
      if (nextJson === lastDeckJson) return; // touch / identical content
      lastDeckJson = nextJson;
      currentDeck = nextDeck;
      panel.loadDeck(nextDeck, { progressPath: progressPathFor(dir) });
      flushHost(panel.render());
    }, 500);

    // $EDITOR escape hatch (ctrl+o): the host owns the stdin listener + raw
    // mode, so it — not handleInputMode — is where the editor round-trip has
    // to live. Detected here before delegating to the panel; only acts while
    // an input-mode buffer exists (panel.getInputBuffer() undefined otherwise).
    const runEditorEscapeHatch = (buffer: string) => {
      if (panel === null) return;
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      let result: ReturnType<typeof editBufferInEditor> = { text: buffer };
      try {
        restoreTerminal();
        result = editBufferInEditor(buffer);
      } finally {
        setupTerminal();
        process.stdin.on('data', onData);
        process.stdout.on('resize', onResize);
        panel.setInputBuffer(result.text);
        const { cols: c, rows: r } = getTerminalSize();
        const lines = panel.handleResize(c, r);
        if (result.error !== undefined) {
          while (lines.length < r) lines.push('');
          lines[r - 1] = `  ${result.error}`.slice(0, c);
        }
        prevFrameLocal = [];
        process.stdout.write('\x1b[2J\x1b[H');
        flushHost(lines);
      }
    };

    // Start the local web server over this interaction dir, open a browser
    // tab on it, and park the panel: from here the browser is the sole editor
    // (browser-authoritative handoff — no two-way sync). `onSubmit` fires once
    // the browser's POST has already written response.json; finalize() is
    // told so via `written` and does not write it again.
    const enterHandoff = async () => {
      if (handoff !== null) return;
      let server: WebServerHandle;
      try {
        server = await startWebServer({
          dir,
          deck: currentDeck,
          onSubmit: (responses, completedAt, responsePath) => {
            finalize(responses, { responsePath, completedAt });
          },
        });
      } catch (err) {
        // Failed to bind (e.g. no loopback available) — stay in the normal TUI;
        // nothing was torn down, so surface the error as a one-line footer.
        const { cols: c, rows: r } = getTerminalSize();
        const lines = panel!.render();
        while (lines.length < r) lines.push('');
        lines[r - 1] = `  Could not start the browser surface: ${err instanceof Error ? err.message : String(err)}`.slice(0, c);
        flushHost(lines);
        return;
      }
      handoff = server;
      const { cols: c, rows: r } = getTerminalSize();
      prevFrameLocal = [];
      process.stdout.write('\x1b[2J\x1b[H');
      flushHost(renderHandoff(server.url, c, r));
      openBrowser(server.url);
    };

    // Reclaim control: tell any open browser tab it's now read-only, stop the
    // server, and restore the live panel exactly as the human left it.
    const takeBack = () => {
      if (handoff === null) return;
      const h = handoff;
      handoff = null;
      // Deck's requestTakeBack() is just an awaited flush-broadcast of
      // taken-back (no ack-wait, deck has no autosave/dirty state to flush) —
      // so this stays effectively instant. Kept async and NOT awaited before
      // the render/flush below so the terminal repaint never blocks on it.
      void (async () => {
        await h.requestTakeBack();
        await h.stop();
      })();
      prevFrameLocal = [];
      process.stdout.write('\x1b[2J\x1b[H');
      flushHost(panel!.render());
    };

    onData = (data: Buffer) => {
      const { input: inp, key } = parseKeypress(data);
      if (handoff !== null) {
        // Handed off: the panel gets no keys at all. Only take-back (and a
        // hard Ctrl+C exit, mirroring the panel's own exit-on-partial) reach
        // the host while the browser is the sole editor.
        if (inp === 'w') { takeBack(); return; }
        if (key.ctrl && inp === 'c') { finalize(lastResponses); return; }
        return;
      }
      // 'w' hands the current interaction off to the browser. Gated on
      // canAcceptHostKeys() (not mid comment/freetext) so it never shadows a
      // literal 'w' typed into a buffer; 'w' is also reserved from option
      // auto-shortcuts (see assignShortcuts) so it never collides with a pick.
      if (inp === 'w' && panel!.canAcceptHostKeys()) {
        void enterHandoff();
        return;
      }
      panel!.handleKey(inp, key);
      flushHost(panel!.render());
    };
    process.stdin.on('data', onData);
    process.stdout.on('resize', onResize);
  });
}

// ── launchTui — file-path entry over the dir resolver (a kept public export
//    per the interaction-layer plan; consumed until consumers move to ask()) ──

export async function launchTui(
  decisionsPath: string,
  sessionId?: string,
): Promise<{ responses: InteractionResponse[]; completedAt: string }> {
  if (!existsSync(decisionsPath)) {
    throw new Error(`Decisions file not found: ${decisionsPath}`);
  }

  const raw = readFileSync(decisionsPath, 'utf8');
  const deck = validateInput(JSON.parse(raw));
  // The interaction dir is the deck file's directory; progress/response live
  // there per the convention.
  const dir = dirname(resolvePath(decisionsPath));

  const { responses, completedAt } = await resolveInteractionDir(dir, deck, { sessionId });
  return { responses, completedAt };
}
