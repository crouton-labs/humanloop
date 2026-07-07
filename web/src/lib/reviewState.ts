import type { FeedbackComment, ReviewPayload } from '@/types';
import { buildSourceMap, hasValidRangeColumns, sourceSelectionFromLineRange, type SourceMap, type SourceSelection } from './sourceMap';

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
  comments: FeedbackComment[];
  version: number;
  activeLine: number;
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

function normalizeLine(line: number, map: SourceMap): number {
  return Math.max(1, Math.min(line, Math.max(1, map.lines.length)));
}

export function buildInitialReviewState(review: ReviewPayload): ReviewState {
  const sourceMap = buildSourceMap(review.content);
  const activeLine = normalizeLine(review.result.comments[0]?.line ?? 1, sourceMap);
  return {
    file: review.file,
    output: review.output,
    jobId: review.jobId,
    content: review.content,
    sourceMap,
    comments: [...review.result.comments],
    version: review.version,
    activeLine,
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
  return state.selection ?? sourceSelectionFromLineRange(state.sourceMap, state.activeLine) ?? {
    line: state.activeLine,
    endLine: state.activeLine,
    startByte: 0,
    endByte: 0,
    lineText: state.sourceMap.lines[state.activeLine - 1]?.text ?? '',
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
  return {
    ...state,
    file: review.file,
    output: review.output,
    jobId: review.jobId,
    content: review.content,
    sourceMap,
    comments: [...review.result.comments],
    version: review.version,
    activeLine: normalizeLine(state.activeLine, sourceMap),
    selection: null,
    composer: null,
    notice: null,
    saveState: 'clean',
    readOnly: review.result.submitted,
  };
}
