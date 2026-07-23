import type { FeedbackComment, ReviewPayload } from '@/types';
import { buildSourceMap, hasValidRangeColumns, sourceSelectionFromLineRange, type SourceMap, type SourceSelection } from './sourceMap';
import { deriveAnchorUnits, remapUnitIndex, unitBoundsForRange, unitIndexForLine, type AnchorUnit } from './anchorUnits';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'save-error' | 'conflict';

export interface ComposerState {
  mode: 'create' | 'edit';
  anchor: SourceSelection;
  commentId?: string;
  buffer: string;
}

export interface ReviewState {
  file: string;
  output: string;
  jobId: string;
  content: string;
  sourceMap: SourceMap;
  /** Ordered leaf anchor units (bullet / table row / code line / whole
   *  paragraph / whole diagram). Never empty. j/k steps through these. */
  units: AnchorUnit[];
  comments: FeedbackComment[];
  version: number;
  /** 0-based index of the anchored unit — the keyboard cursor. */
  activeUnit: number;
  /** Fixed origin unit while a Shift+j/k range is extended; null otherwise. */
  selectionAnchorUnit: number | null;
  /** A byte-precise MOUSE drag selection (column comments). Keyboard motion
   *  clears it and works on whole units instead. */
  selection: SourceSelection | null;
  composer: ComposerState | null;
  listOpen: boolean;
  listIndex: number;
  helpOpen: boolean;
  notice: string | null;
  saveState: SaveState;
  submitRequested: boolean;
  readOnly: boolean;
}

function clampUnit(units: AnchorUnit[], index: number): number {
  return Math.max(0, Math.min(index, units.length - 1));
}

/** Source-line bounds of the current keyboard selection (active unit, widened
 *  across any Shift-extended range). */
export function activeUnitBounds(state: ReviewState): { line: number; endLine: number } {
  const anchor = state.selectionAnchorUnit ?? state.activeUnit;
  return unitBoundsForRange(state.units, Math.min(state.activeUnit, anchor), Math.max(state.activeUnit, anchor));
}

export function buildInitialReviewState(review: ReviewPayload): ReviewState {
  const sourceMap = buildSourceMap(review.content);
  const units = deriveAnchorUnits(review.content);
  const firstLine = review.result.comments[0]?.line;
  const activeUnit = typeof firstLine === 'number' ? unitIndexForLine(units, firstLine) : 0;
  return {
    file: review.file,
    output: review.output,
    jobId: review.jobId,
    content: review.content,
    sourceMap,
    units,
    comments: [...review.result.comments],
    version: review.version,
    activeUnit: clampUnit(units, activeUnit),
    selectionAnchorUnit: null,
    selection: null,
    composer: null,
    listOpen: false,
    listIndex: 0,
    helpOpen: false,
    notice: null,
    saveState: 'clean',
    submitRequested: false,
    readOnly: review.result.submitted,
  };
}

export function collectReviewComments(state: ReviewState): FeedbackComment[] {
  return state.comments.map((comment) => ({ ...comment }));
}

export function selectedAnchor(state: ReviewState): SourceSelection {
  if (state.selection !== null) return state.selection;
  const { line, endLine } = activeUnitBounds(state);
  return sourceSelectionFromLineRange(state.sourceMap, line, endLine) ?? {
    line,
    endLine,
    startByte: 0,
    endByte: 0,
    lineText: state.sourceMap.lines[line - 1]?.text ?? '',
  };
}

export function makeFeedbackComment(anchor: SourceSelection, comment: string, id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`): FeedbackComment {
  const out: FeedbackComment = {
    id,
    line: anchor.line,
    endLine: anchor.endLine,
    lineText: anchor.lineText,
    comment,
    createdAt: new Date().toISOString(),
  };
  if (anchor.quote !== undefined && anchor.quote.length > 0) out.quote = anchor.quote;
  if (hasValidRangeColumns(anchor)) {
    out.colStart = anchor.colStart;
    out.colEnd = anchor.colEnd;
  }
  return out;
}

export function isDirty(state: ReviewState): boolean {
  return state.saveState === 'dirty' || state.saveState === 'saving' || state.saveState === 'save-error' || state.saveState === 'conflict';
}

export function replaceFromPayload(state: ReviewState, review: ReviewPayload): ReviewState {
  const sourceMap = buildSourceMap(review.content);
  const units = deriveAnchorUnits(review.content);
  const prevUnit = state.units[state.activeUnit];
  const activeUnit = prevUnit !== undefined ? remapUnitIndex(units, prevUnit) : 0;
  return {
    ...state,
    file: review.file,
    output: review.output,
    jobId: review.jobId,
    content: review.content,
    sourceMap,
    units,
    comments: [...review.result.comments],
    version: review.version,
    activeUnit: clampUnit(units, activeUnit),
    selectionAnchorUnit: null,
    selection: null,
    composer: null,
    notice: null,
    saveState: 'clean',
    readOnly: review.result.submitted,
  };
}
