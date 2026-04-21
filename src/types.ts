// ── Input: what the agent writes ─────────────────────────────────────────────

export type QuestionType = 'validation' | 'choice' | 'freetext';

export interface ValidationQuestion {
  id: string;
  type: 'validation';
  statement: string;
  rationale: string;
}

export interface ChoiceQuestion {
  id: string;
  type: 'choice';
  question: string;
  rationale: string;
  options: string[];
}

export interface FreetextQuestion {
  id: string;
  type: 'freetext';
  question: string;
  rationale: string;
}

export type Question = ValidationQuestion | ChoiceQuestion | FreetextQuestion;

export interface DecisionsInput {
  title?: string;
  questions: Question[];
}

// ── Output: what the agent reads back ────────────────────────────────────────

export interface ValidationAnswer {
  id: string;
  type: 'validation';
  approved: boolean;
  comment?: string;
}

export interface ChoiceAnswer {
  id: string;
  type: 'choice';
  selected: string; // option text or freetext value
  isCustom: boolean;
  comment?: string;
}

export interface FreetextAnswer {
  id: string;
  type: 'freetext';
  response: string;
}

export type Answer = ValidationAnswer | ChoiceAnswer | FreetextAnswer;

export interface DecisionsOutput {
  answers: Answer[];
  completedAt: string;
}

// ── Visual context: what haiku generates ─────────────────────────────────────

export interface VisualBlock {
  questionId: string;
  content: string; // rendered terminal content (ANSI)
  status: 'loading' | 'ready' | 'error';
}

// ── TUI state ────────────────────────────────────────────────────────────────

export type Phase = 'overview' | 'item-review' | 'final';

export type InputMode =
  | null
  | { kind: 'comment'; buffer: string }
  | { kind: 'freetext'; buffer: string }
  | { kind: 'custom-option'; buffer: string };

export interface TuiState {
  phase: Phase;
  currentIndex: number;
  questions: Question[];
  answers: Map<string, Answer>;
  visuals: Map<string, VisualBlock>;
  inputMode: InputMode;
  selectedAction: number;
  detailExpanded: boolean;
  scrollOffset: number;
  persist?: () => void;
}
