import type { TuiState, Answer, Question } from '../types.js';
import type { Key } from './terminal.js';

export type RenderFn = () => void;
export type ExitFn = () => void;

export function handleKeypress(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
  exit: ExitFn,
): void {
  if (key.ctrl && input === 'c') {
    exit();
    return;
  }

  if (state.inputMode) {
    handleInputMode(input, key, state, render);
    checkAutoExit(state, exit);
    return;
  }

  switch (state.phase) {
    case 'overview':
      handleOverview(input, key, state, render, exit);
      break;
    case 'item-review':
      handleItemReview(input, key, state, render);
      checkAutoExit(state, exit);
      break;
    case 'final':
      handleFinal(input, key, state, render, exit);
      break;
  }
}

function checkAutoExit(state: TuiState, exit: ExitFn): void {
  if (state.phase === 'final' && state.answers.size >= state.questions.length) {
    exit();
  }
}

// ── Overview ─────────────────────────────────────────────────────────────────

function handleOverview(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
  exit: ExitFn,
): void {
  if (input === 'j' || key.downArrow) {
    state.currentIndex = Math.min(state.currentIndex + 1, state.questions.length - 1);
    render();
  } else if (input === 'k' || key.upArrow) {
    state.currentIndex = Math.max(state.currentIndex - 1, 0);
    render();
  } else if (key.return) {
    state.phase = 'item-review';
    state.selectedAction = 0;
    state.detailExpanded = false;
    render();
  } else if (input === 'q') {
    if (state.answers.size >= state.questions.length) {
      exit();
    } else {
      state.phase = 'final';
      render();
    }
  }
}

// ── Item Review ──────────────────────────────────────────────────────────────

function handleItemReview(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
): void {
  const q = state.questions[state.currentIndex]!;

  // Navigation
  if (input === 'n') {
    advanceItem(state, 1);
    render();
    return;
  }
  if (input === 'p') {
    advanceItem(state, -1);
    render();
    return;
  }
  if (input === 'q') {
    state.phase = 'overview';
    render();
    return;
  }
  if (input === ' ') {
    state.detailExpanded = !state.detailExpanded;
    render();
    return;
  }

  // Action selection with j/k
  if (input === 'j' || key.downArrow) {
    const max = actionCount(q) - 1;
    state.selectedAction = Math.min(state.selectedAction + 1, max);
    render();
    return;
  }
  if (input === 'k' || key.upArrow) {
    state.selectedAction = Math.max(state.selectedAction - 1, 0);
    render();
    return;
  }

  // Type-specific actions
  if (q.type === 'validation') {
    handleValidationAction(input, key, state, q, render);
  } else if (q.type === 'choice') {
    handleChoiceAction(input, key, state, q, render);
  } else {
    handleFreetextAction(input, key, state, render);
  }
}

function handleValidationAction(
  input: string,
  key: Key,
  state: TuiState,
  q: Question,
  render: RenderFn,
): void {
  if (input === '1' || (key.return && state.selectedAction === 0)) {
    state.answers.set(q.id, { id: q.id, type: 'validation', approved: true });
    state.persist?.();
    advanceItem(state, 1);
    render();
  } else if (input === '2' || (key.return && state.selectedAction === 1)) {
    state.inputMode = { kind: 'comment', buffer: '' };
    state.answers.set(q.id, { id: q.id, type: 'validation', approved: true, comment: '' });
    state.persist?.();
    render();
  } else if (input === '3' || (key.return && state.selectedAction === 2)) {
    state.answers.set(q.id, { id: q.id, type: 'validation', approved: false });
    state.persist?.();
    advanceItem(state, 1);
    render();
  } else if (input === '4' || (key.return && state.selectedAction === 3)) {
    state.inputMode = { kind: 'comment', buffer: '' };
    state.answers.set(q.id, { id: q.id, type: 'validation', approved: false, comment: '' });
    state.persist?.();
    render();
  }
}

function handleChoiceAction(
  input: string,
  key: Key,
  state: TuiState,
  q: Question & { type: 'choice' },
  render: RenderFn,
): void {
  const numOptions = q.options.length;

  const digit = parseInt(input, 10);
  if (digit >= 1 && digit <= numOptions) {
    state.answers.set(q.id, {
      id: q.id,
      type: 'choice',
      selected: q.options[digit - 1]!,
      isCustom: false,
    });
    state.persist?.();
    advanceItem(state, 1);
    render();
    return;
  }

  if (digit === numOptions + 1 || (key.return && state.selectedAction === numOptions)) {
    state.inputMode = { kind: 'custom-option', buffer: '' };
    render();
    return;
  }

  if (key.return && state.selectedAction < numOptions) {
    state.answers.set(q.id, {
      id: q.id,
      type: 'choice',
      selected: q.options[state.selectedAction]!,
      isCustom: false,
    });
    state.persist?.();
    advanceItem(state, 1);
    render();
  }
}

function handleFreetextAction(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
): void {
  if (input === 'r' || key.return) {
    const existing = state.answers.get(state.questions[state.currentIndex]!.id);
    const prefill = existing?.type === 'freetext' ? existing.response : '';
    state.inputMode = { kind: 'freetext', buffer: prefill };
    render();
  }
}

// ── Input Mode ───────────────────────────────────────────────────────────────

function handleInputMode(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
): void {
  const mode = state.inputMode!;

  if (key.escape) {
    state.inputMode = null;
    render();
    return;
  }

  if (key.return) {
    commitInput(state);
    state.inputMode = null;
    advanceItem(state, 1);
    render();
    return;
  }

  if (key.backspace) {
    // Drop the last *codepoint*, not the last UTF-16 code unit, so backspace
    // on an emoji removes the whole glyph instead of leaving a lone surrogate.
    const chars = [...mode.buffer];
    chars.pop();
    mode.buffer = chars.join('');
    render();
    return;
  }

  // Accept any printable input — including pasted multi-char chunks and
  // multi-byte UTF-8 (emoji / CJK). Strip control bytes (ESC sequences,
  // bracketed-paste markers, BEL, BS, CR) so they can't corrupt the TUI.
  const cleaned = input
    .replace(/\x1b\[20[01]~/g, '') // bracketed-paste start/end markers
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI sequences
    .replace(/[\x00-\x1F\x7F]/g, ''); // C0 controls and DEL
  if (cleaned.length > 0) {
    mode.buffer += cleaned;
    render();
  }
}

function commitInput(state: TuiState): void {
  const q = state.questions[state.currentIndex]!;
  const mode = state.inputMode!;

  if (mode.kind === 'comment') {
    const existing = state.answers.get(q.id) as { id: string; type: 'validation'; approved: boolean } | undefined;
    const approved = existing ? existing.approved : false;
    state.answers.set(q.id, {
      id: q.id,
      type: 'validation',
      approved,
      comment: mode.buffer || undefined,
    });
  } else if (mode.kind === 'custom-option') {
    if (mode.buffer) {
      state.answers.set(q.id, {
        id: q.id,
        type: 'choice',
        selected: mode.buffer,
        isCustom: true,
      });
    }
  } else if (mode.kind === 'freetext') {
    if (mode.buffer) {
      state.answers.set(q.id, {
        id: q.id,
        type: 'freetext',
        response: mode.buffer,
      });
    }
  }

  state.persist?.();
}

// ── Final ────────────────────────────────────────────────────────────────────

function handleFinal(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
  exit: ExitFn,
): void {
  if (key.return) {
    exit();
  } else if (input === 'p') {
    state.phase = 'item-review';
    state.currentIndex = state.questions.length - 1;
    render();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function advanceItem(state: TuiState, direction: number): void {
  const next = state.currentIndex + direction;
  if (next < 0) return;
  if (next >= state.questions.length) {
    state.phase = 'final';
    return;
  }
  state.currentIndex = next;
  state.selectedAction = 0;
  state.detailExpanded = false;
}

function actionCount(q: Question): number {
  switch (q.type) {
    case 'validation': return 4;
    case 'choice': return q.options.length + 1;
    case 'freetext': return 1;
  }
}
