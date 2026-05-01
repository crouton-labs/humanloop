import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import type {
  Deck, TuiState, Interaction, InteractionResponse,
  MountedPanel, MountedPanelOpts, GenerateVisual,
} from '../types.js';
import { setupTerminal, restoreTerminal, parseKeypress, getTerminalSize } from './terminal.js';
import { diffFrame, renderOverview, renderItemReview, renderFinal } from './render.js';
import { handleKeypress, assignShortcuts } from './input.js';
import { readConversation } from '../conversation/reader.js';
import { defaultGenerateVisual } from '../visuals/generate.js';

export function validateInput(parsed: unknown): Deck {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Deck file must be a JSON object with an `interactions` array');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.interactions)) {
    throw new Error('`interactions` must be an array');
  }
  if (obj.interactions.length === 0) {
    throw new Error('No interactions in deck file');
  }
  if (obj.title !== undefined && typeof obj.title !== 'string') {
    throw new Error('`title` must be a string when present');
  }

  const seen = new Set<string>();
  const validated: Interaction[] = [];
  for (let i = 0; i < obj.interactions.length; i++) {
    const raw = obj.interactions[i] as Record<string, unknown> | null;
    const where = `interactions[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${where} must be an object`);
    }
    if (typeof raw.id !== 'string' || raw.id === '') {
      throw new Error(`${where}.id must be a non-empty string`);
    }
    if (seen.has(raw.id)) {
      throw new Error(`Duplicate interaction id: ${JSON.stringify(raw.id)}`);
    }
    seen.add(raw.id);

    if (typeof raw.title !== 'string' || raw.title === '') {
      throw new Error(`${where}.title must be a non-empty string`);
    }

    if (!Array.isArray(raw.options)) {
      throw new Error(`${where}.options must be an array`);
    }

    const opts: Interaction['options'] = [];
    for (let j = 0; j < raw.options.length; j++) {
      const o = raw.options[j] as Record<string, unknown> | null;
      const owhere = `${where}.options[${j}]`;
      if (typeof o !== 'object' || o === null || Array.isArray(o)) {
        throw new Error(`${owhere} must be an object`);
      }
      if (typeof o.id !== 'string' || o.id === '') {
        throw new Error(`${owhere}.id must be a non-empty string`);
      }
      if (typeof o.label !== 'string') {
        throw new Error(`${owhere}.label must be a string`);
      }
      const opt: Interaction['options'][number] = { id: o.id, label: o.label };
      if (o.description !== undefined) {
        if (typeof o.description !== 'string') throw new Error(`${owhere}.description must be a string`);
        opt.description = o.description;
      }
      if (o.shortcut !== undefined) {
        if (typeof o.shortcut !== 'string') throw new Error(`${owhere}.shortcut must be a string`);
        opt.shortcut = o.shortcut;
      }
      opts.push(opt);
    }

    const interaction: Interaction = { id: raw.id, title: raw.title, options: opts };
    if (raw.subtitle !== undefined) {
      if (typeof raw.subtitle !== 'string') throw new Error(`${where}.subtitle must be a string`);
      interaction.subtitle = raw.subtitle;
    }
    if (raw.body !== undefined) {
      if (typeof raw.body !== 'string') throw new Error(`${where}.body must be a string`);
      interaction.body = raw.body;
    }
    if (raw.bodyPath !== undefined) {
      if (typeof raw.bodyPath !== 'string') throw new Error(`${where}.bodyPath must be a string`);
      interaction.bodyPath = raw.bodyPath;
    }
    if (raw.freetextLabel !== undefined) {
      if (typeof raw.freetextLabel !== 'string') throw new Error(`${where}.freetextLabel must be a string`);
      interaction.freetextLabel = raw.freetextLabel;
    }
    if (raw.allowFreetext !== undefined) {
      if (typeof raw.allowFreetext !== 'boolean') throw new Error(`${where}.allowFreetext must be a boolean`);
      interaction.allowFreetext = raw.allowFreetext;
    }
    if (raw.kind !== undefined) {
      interaction.kind = raw.kind as Interaction['kind'];
    }
    validated.push(interaction);
  }

  const deck: Deck = { interactions: validated };
  if (obj.title !== undefined) deck.title = obj.title as string;
  return deck;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildInitialState(deck: Deck): TuiState {
  return {
    phase: 'overview',
    currentIndex: 0,
    interactions: deck.interactions,
    responses: new Map(),
    visuals: new Map(),
    inputMode: null,
    selectedAction: 0,
    detailExpanded: false,
    scrollOffset: 0,
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
  progressPath: string | undefined;
  callbacks: {
    onProgress: MountedPanelOpts['onProgress'];
    onComplete: MountedPanelOpts['onComplete'];
    onExit: MountedPanelOpts['onExit'];
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
  for (const interaction of interactions) {
    internals.state.visuals.set(interaction.id, { questionId: interaction.id, content: '', status: 'loading' });
    gen(interaction).then((r) => {
      if (!internals.mounted) return;
      if (!internals.state.interactions.some((x) => x.id === interaction.id)) return;
      internals.state.visuals.set(interaction.id, r.ok
        ? { questionId: interaction.id, content: r.ansi, status: 'ready' }
        : { questionId: interaction.id, content: '', status: 'error' });
    }).catch(() => {
      if (!internals.mounted) return;
      if (!internals.state.interactions.some((x) => x.id === interaction.id)) return;
      internals.state.visuals.set(interaction.id, { questionId: interaction.id, content: '', status: 'error' });
    });
  }
}

export function mountPanel(opts: MountedPanelOpts): MountedPanel {
  const internals: PanelInternals = {
    state: buildInitialState(opts.deck),
    cols: opts.cols,
    rows: opts.rows,
    mounted: true,
    generateVisual: opts.generateVisual,
    progressPath: opts.progressPath,
    callbacks: { onProgress: opts.onProgress, onComplete: opts.onComplete, onExit: opts.onExit },
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
    },

    render() {
      if (!internals.mounted) return [];
      return renderLines();
    },

    handleResize(cols, rows) {
      internals.cols = cols;
      internals.rows = rows;
      return renderLines();
    },

    unmount() {
      internals.mounted = false;
      internals.state.visuals.clear();
      internals.state.persist = undefined;
    },

    loadDeck(deck, loadOpts) {
      if (!internals.mounted) return;
      internals.state = buildInitialState(deck);
      if (loadOpts !== undefined && loadOpts.progressPath !== undefined) {
        internals.progressPath = loadOpts.progressPath;
      }
      assignShortcuts(internals.state.interactions);
      rebindPersist(internals);
      if (internals.progressPath !== undefined) {
        tryResume(internals.state, internals.progressPath, deck.interactions);
      }
      fireVisuals(internals, deck.interactions);
    },

    canAcceptHostKeys() {
      if (!internals.mounted) return false;
      return internals.state.inputMode === null;
    },
  };
}

// ── launchTui shim ────────────────────────────────────────────────────────────

export async function launchTui(
  decisionsPath: string,
  sessionId?: string,
): Promise<{ responses: InteractionResponse[]; completedAt: string }> {
  if (!existsSync(decisionsPath)) {
    throw new Error(`Decisions file not found: ${decisionsPath}`);
  }

  const raw = readFileSync(decisionsPath, 'utf8');
  const deck = validateInput(JSON.parse(raw));

  let conversationContext = '';
  if (sessionId !== undefined) {
    try {
      const conv = readConversation(sessionId);
      conversationContext = conv.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    } catch {
      // empty context — proceed without visuals context
    }
  }

  setupTerminal();
  const { cols, rows } = getTerminalSize();

  return new Promise<{ responses: InteractionResponse[]; completedAt: string }>((resolve) => {
    let panel: MountedPanel | null = null;
    let prevFrameLocal: string[] = [];
    let lastResponses: InteractionResponse[] = [];
    let onData!: (data: Buffer) => void;

    const flushHost = (lines: string[]) => {
      const { rows: currentRows } = getTerminalSize();
      const { writes, nextPrevFrame } = diffFrame(prevFrameLocal, lines, currentRows);
      process.stdout.write('\x1b[?2026h');
      for (const w of writes) process.stdout.write(w);
      process.stdout.write('\x1b[?2026l');
      prevFrameLocal = nextPrevFrame;
    };

    const onComplete = (responses: InteractionResponse[]) => {
      restoreTerminal();
      process.stdin.removeListener('data', onData);
      panel?.unmount();
      resolve({ responses, completedAt: new Date().toISOString() });
    };

    panel = mountPanel({
      deck,
      progressPath: `${decisionsPath}.progress.json`,
      cols,
      rows,
      generateVisual: sessionId !== undefined
        ? (interaction) => defaultGenerateVisual(interaction, conversationContext)
        : undefined,
      onProgress: (responses) => {
        lastResponses = responses;
        if (panel !== null) flushHost(panel.render());
      },
      onComplete,
      onExit: () => {
        onComplete(lastResponses);
      },
    });

    flushHost(panel.render());

    onData = (data: Buffer) => {
      const { input: inp, key } = parseKeypress(data);
      panel!.handleKey(inp, key);
      flushHost(panel!.render());
    };
    process.stdin.on('data', onData);
  });
}
