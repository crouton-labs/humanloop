import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import type { DecisionsInput, DecisionsOutput, TuiState, Answer } from '../types.js';
import { setupTerminal, restoreTerminal, parseKeypress, getTerminalSize } from './terminal.js';
import { flush, renderOverview, renderItemReview, renderFinal } from './render.js';
import { handleKeypress } from './input.js';
import { readConversation } from '../conversation/reader.js';
import { generateVisuals } from '../visuals/generate.js';

export async function launchTui(
  decisionsPath: string,
  sessionId?: string,
): Promise<DecisionsOutput> {
  if (!existsSync(decisionsPath)) {
    throw new Error(`Decisions file not found: ${decisionsPath}`);
  }

  const raw = readFileSync(decisionsPath, 'utf8');
  const input: DecisionsInput = JSON.parse(raw);

  if (!input.questions || input.questions.length === 0) {
    throw new Error('No questions in decisions file');
  }

  const state: TuiState = {
    phase: 'overview',
    currentIndex: 0,
    questions: input.questions,
    answers: new Map(),
    visuals: new Map(),
    inputMode: null,
    selectedAction: 0,
    detailExpanded: false,
    scrollOffset: 0,
  };

  const progressPath = `${decisionsPath}.progress.json`;
  state.persist = () => {
    const answers: Answer[] = [];
    for (const q of input.questions) {
      const a = state.answers.get(q.id);
      if (a) answers.push(a);
    }
    const payload = {
      partial: true,
      answers,
      savedAt: new Date().toISOString(),
    };
    try {
      const tmp = `${progressPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2));
      renameSync(tmp, progressPath);
    } catch {
      // best-effort — do not crash the TUI if the directory isn't writable
    }
  };

  if (existsSync(progressPath)) {
    try {
      const prior = JSON.parse(readFileSync(progressPath, 'utf8')) as { answers?: Answer[] };
      const validIds = new Set(input.questions.map((q) => q.id));
      for (const a of prior.answers ?? []) {
        if (validIds.has(a.id)) state.answers.set(a.id, a);
      }
      const firstUnanswered = input.questions.findIndex((q) => !state.answers.has(q.id));
      state.currentIndex = firstUnanswered >= 0 ? firstUnanswered : 0;
    } catch {
      // corrupt progress file — ignore and start fresh
    }
  }

  // Initialize visuals — 'loading' if we'll generate them, skip otherwise
  if (sessionId) {
    for (const q of input.questions) {
      state.visuals.set(q.id, { questionId: q.id, content: '', status: 'loading' });
    }
  }

  setupTerminal();

  const render = () => {
    let lines: string[];
    switch (state.phase) {
      case 'overview':
        lines = renderOverview(state);
        break;
      case 'item-review':
        lines = renderItemReview(state);
        break;
      case 'final':
        lines = renderFinal(state);
        break;
    }
    flush(lines);
  };

  // Initial render
  render();

  // Fan out haiku visual generation in background
  if (sessionId) {
    try {
      const conversation = readConversation(sessionId);
      if (conversation.length > 0) {
        const { cols } = getTerminalSize();
        const visualWidth = Math.max(40, Math.min(cols - 4, 76));
        generateVisuals(input.questions, conversation, (qId, block) => {
          state.visuals.set(qId, block);
          render();
        }, visualWidth).catch((err) => {
          process.stderr.write(`Visual generation failed: ${err}\n`);
        });
      }
    } catch (err) {
      for (const q of input.questions) {
        state.visuals.set(q.id, { questionId: q.id, content: '', status: 'error' });
      }
    }
  }

  return new Promise<DecisionsOutput>((resolve) => {
    const exit = () => {
      restoreTerminal();
      process.stdin.removeListener('data', onData);

      const answers: Answer[] = [];
      for (const q of input.questions) {
        const a = state.answers.get(q.id);
        if (a) answers.push(a);
      }

      if (answers.length >= input.questions.length) {
        try { unlinkSync(progressPath); } catch { /* ignore */ }
      }

      resolve({
        answers,
        completedAt: new Date().toISOString(),
      });
    };

    const onData = (data: Buffer) => {
      const { input: inp, key } = parseKeypress(data);
      handleKeypress(inp, key, state, render, exit);
    };

    process.stdin.on('data', onData);
  });
}
