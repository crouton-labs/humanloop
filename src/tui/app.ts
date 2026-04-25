import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import type { DecisionsInput, DecisionsOutput, TuiState, Answer, Question } from '../types.js';
import { setupTerminal, restoreTerminal, parseKeypress, getTerminalSize } from './terminal.js';
import { flush, renderOverview, renderItemReview, renderFinal } from './render.js';
import { handleKeypress } from './input.js';
import { readConversation } from '../conversation/reader.js';
import { generateVisuals } from '../visuals/generate.js';

// Validate the parsed JSON before opening the terminal so bad agent input
// fails with a clear error instead of crashing inside the TUI.
export function validateInput(parsed: unknown): DecisionsInput {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Decisions file must be a JSON object with a `questions` array');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) {
    throw new Error('`questions` must be an array');
  }
  if (obj.questions.length === 0) {
    throw new Error('No questions in decisions file');
  }
  if (obj.title !== undefined && typeof obj.title !== 'string') {
    throw new Error('`title` must be a string when present');
  }

  const seen = new Set<string>();
  const validated: Question[] = [];
  for (let i = 0; i < obj.questions.length; i++) {
    const q = obj.questions[i] as Record<string, unknown> | null;
    const where = `questions[${i}]`;
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      throw new Error(`${where} must be an object`);
    }
    if (typeof q.id !== 'string' || q.id === '') {
      throw new Error(`${where}.id must be a non-empty string`);
    }
    if (seen.has(q.id)) {
      throw new Error(`Duplicate question id: ${JSON.stringify(q.id)}`);
    }
    seen.add(q.id);

    if (q.type === 'validation') {
      if (typeof q.statement !== 'string') throw new Error(`${where}.statement must be a string`);
      if (typeof q.rationale !== 'string') throw new Error(`${where}.rationale must be a string`);
      validated.push({ id: q.id, type: 'validation', statement: q.statement, rationale: q.rationale });
    } else if (q.type === 'choice') {
      if (typeof q.question !== 'string') throw new Error(`${where}.question must be a string`);
      if (typeof q.rationale !== 'string') throw new Error(`${where}.rationale must be a string`);
      if (!Array.isArray(q.options)) throw new Error(`${where}.options must be an array`);
      if (q.options.length < 2) throw new Error(`${where}.options must have at least 2 items (got ${q.options.length})`);
      const opts: string[] = [];
      for (let j = 0; j < q.options.length; j++) {
        if (typeof q.options[j] !== 'string') throw new Error(`${where}.options[${j}] must be a string`);
        opts.push(q.options[j] as string);
      }
      validated.push({ id: q.id, type: 'choice', question: q.question, rationale: q.rationale, options: opts });
    } else if (q.type === 'freetext') {
      if (typeof q.question !== 'string') throw new Error(`${where}.question must be a string`);
      if (typeof q.rationale !== 'string') throw new Error(`${where}.rationale must be a string`);
      validated.push({ id: q.id, type: 'freetext', question: q.question, rationale: q.rationale });
    } else {
      throw new Error(`${where}.type must be "validation" | "choice" | "freetext" (got ${JSON.stringify(q.type)})`);
    }
  }

  return { title: obj.title as string | undefined, questions: validated };
}

export async function launchTui(
  decisionsPath: string,
  sessionId?: string,
): Promise<DecisionsOutput> {
  if (!existsSync(decisionsPath)) {
    throw new Error(`Decisions file not found: ${decisionsPath}`);
  }

  const raw = readFileSync(decisionsPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const input = validateInput(parsed);

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
