import { useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import { Markdown } from '@/components/Markdown';
import type { ReviewState } from '@/lib/reviewState';
import type { ReviewAction } from '@/lib/reviewReducer';
import { actionsForMouseSelection } from '@/lib/reviewReducer';
import {
  type MarkdownSourceHighlight,
  makeCommentHighlights,
  sourceByteRangeFromComment,
  sourceLineFromDomPoint,
  sourceLineFromElement,
  sourceSelectionFromDomSelection,
  sourceSelectionFromLineRange,
} from '@/lib/sourceMap';

export function ReviewDocument({
  state,
  dispatch,
  scrollRef,
}: {
  state: ReviewState;
  dispatch: (action: ReviewAction) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const highlights: MarkdownSourceHighlight[] = [
    ...makeCommentHighlights(state.sourceMap, state.comments, 'review-source-comment'),
  ];
  const activeSelection = state.selection
    ?? sourceSelectionFromLineRange(state.sourceMap, state.activeLine);
  if (activeSelection !== null) {
    const range = state.selection
      ? { startByte: state.selection.startByte, endByte: state.selection.endByte }
      : sourceByteRangeFromComment({
        id: 'active',
        line: state.activeLine,
        endLine: state.activeLine,
        lineText: '',
        comment: '',
        createdAt: '',
      }, state.sourceMap);
    if (range !== null && range.endByte > range.startByte) {
      highlights.push({ range, className: 'review-source-active' });
    }
  }

  const onMouseUp = useCallback(() => {
    if (state.readOnly) return;
    const selection = window.getSelection();
    const container = containerRef.current;
    if (selection === null || container === null) return;
    if (selection.isCollapsed) return;
    if (selection.anchorNode === null || !container.contains(selection.anchorNode)) return;

    const mapped = sourceSelectionFromDomSelection(state.sourceMap, selection);
    if (mapped === null) selection.removeAllRanges();
    // Mouse and keyboard dispatch the SAME action sequence for a successful
    // selection (set the anchor, open the composer) — see
    // `actionsForMouseSelection`.
    for (const action of actionsForMouseSelection(mapped)) dispatch(action);
  }, [dispatch, state.readOnly, state.sourceMap]);

  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    // Prefer the exact clicked point (a collapsed selection's
    // anchorNode/anchorOffset) over the containing span's start-byte line —
    // a multiline text node (`alpha\nbravo` in one leaf) must resolve the
    // clicked sub-line, not always the span's first line. Fall back to the
    // element-based lookup when there's no usable point (e.g. a click that
    // didn't produce a DOM selection point inside the document).
    let line: number | null = null;
    const container = containerRef.current;
    if (selection !== null && selection.anchorNode !== null && container !== null && container.contains(selection.anchorNode)) {
      line = sourceLineFromDomPoint(state.sourceMap, selection.anchorNode, selection.anchorOffset);
    }
    if (line === null) line = sourceLineFromElement(state.sourceMap, event.target as Element);
    if (line !== null) dispatch({ type: 'cursor/set-line', line });
  }, [dispatch, state.sourceMap]);

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span className="truncate font-mono">{state.file}</span>
        <span>L{state.activeLine}{state.selection && state.selection.line !== state.selection.endLine ? `–${state.selection.endLine}` : ''}</span>
      </div>
      <div
        ref={scrollRef}
        className="max-h-[62vh] overflow-y-auto px-5 py-4"
      >
        <div
          ref={containerRef}
          onMouseUp={onMouseUp}
          onClick={onClick}
          className="review-document"
        >
          <Markdown sourceMap={state.sourceMap} sourceHighlights={highlights}>
            {state.content}
          </Markdown>
        </div>
      </div>
    </section>
  );
}
