import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ReviewPayload } from '@/types';
import { Button } from '@/components/ui/button';
import { reviewReducer, buildInitialReviewState, collectReviewComments } from '@/lib/reviewReducer';
import { useReviewKeymap } from '@/hooks/useReviewKeymap';
import { reviewRangeLabel } from '@/lib/sourceMap';
import { cn } from '@/lib/utils';
import { ReviewDocument } from './ReviewDocument';
import { CommentComposer } from './CommentComposer';
import { CommentList } from './CommentList';
import { ReviewHelpOverlay } from './ReviewHelpOverlay';

const AUTOSAVE_DELAY_MS = 700;

export interface ReviewSurfaceProps {
  review: ReviewPayload;
  /** True once the top-level surface has converged (taken-back / submitted) —
   *  freezes editing and detaches the keymap. */
  readOnly: boolean;
  /** Increments each time the server broadcasts `review-draft-updated`, so a
   *  second tab / relaunched nvim draft can refetch or stale-notice. */
  draftPing: number;
  onSubmitting: () => void;
  onSubmitted: () => void;
  onError: (message: string) => void;
}

export function ReviewSurface({ review, readOnly, draftPing, onSubmitting, onSubmitted, onError }: ReviewSurfaceProps) {
  const [state, dispatch] = useReducer(reviewReducer, review, buildInitialReviewState);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const effectiveReadOnly = readOnly || state.readOnly;

  useReviewKeymap(state, dispatch, { scrollRef, disabled: effectiveReadOnly });

  // Take-back / submitted convergence pushed from the top-level surface.
  useEffect(() => {
    if (readOnly) dispatch({ type: 'server/mark-readonly' });
  }, [readOnly]);

  // ── Autosave: debounce a dirty draft to PUT /api/review/draft ────────────
  useEffect(() => {
    if (state.saveState !== 'dirty' || effectiveReadOnly) return;
    const timer = window.setTimeout(() => {
      const snapshot = stateRef.current;
      const sentComments = collectReviewComments(snapshot);
      dispatch({ type: 'draft/save-start' });
      void (async () => {
        try {
          const res = await fetch('/api/review/draft', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comments: sentComments, baseVersion: snapshot.version }),
          });
          // Any 2xx acks the autosave, even a body that's empty or not JSON —
          // parse best-effort and fall back to the prior version.
          if (res.ok) {
            let ackVersion = snapshot.version;
            try {
              const body = await res.json() as { version?: number };
              if (typeof body.version === 'number') ackVersion = body.version;
            } catch {
              // empty/non-JSON body on a successful ack — keep prior version.
            }
            dispatch({ type: 'draft/save-ack', version: ackVersion, savedComments: sentComments });
            return;
          }
          const body = await res.json() as { error?: string; version?: number; result?: ReviewPayload['result'] };
          if (res.status === 409 && body.error === 'stale_draft' && typeof body.version === 'number') {
            // Another tab/nvim saved a newer draft. Keep the local edits as-is —
            // do NOT auto-resave — and surface a conflict the user must resolve
            // explicitly (draft/resolve-conflict) to avoid clobbering the newer
            // server draft in a silent retry loop.
            dispatch({
              type: 'draft/conflict',
              version: body.version,
              message: 'Draft changed elsewhere. Your edits are kept — click Save to overwrite, or reload to see the newer draft.',
            });
            return;
          }
          if (res.status === 409 && body.error === 'already_submitted') {
            onSubmitted();
            return;
          }
          dispatch({ type: 'draft/save-error', message: body.error ?? `autosave failed: ${res.status}` });
        } catch (err) {
          dispatch({ type: 'draft/save-error', message: err instanceof Error ? err.message : String(err) });
        }
      })();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state.saveState, state.comments, effectiveReadOnly, onSubmitted]);

  // ── Submit ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!state.submitRequested) return;
    dispatch({ type: 'submit/clear-request' });
    if (effectiveReadOnly) return;
    const snapshot = stateRef.current;
    onSubmitting();
    void (async () => {
      try {
        const res = await fetch('/api/review/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments: collectReviewComments(snapshot), baseVersion: snapshot.version }),
        });
        const body = await res.json() as { error?: string; version?: number; result?: ReviewPayload['result'] };
        if (res.ok) {
          onSubmitted();
          return;
        }
        if (res.status === 409 && body.error === 'already_submitted') {
          onSubmitted();
          return;
        }
        if (res.status === 409 && body.error === 'stale_draft' && typeof body.version === 'number') {
          dispatch({ type: 'draft/conflict', version: body.version, message: 'Draft changed elsewhere — review the latest and submit again.' });
          onError('Draft changed elsewhere before submit. Your edits are kept; submit again to finalize.');
          return;
        }
        onError(body.error ?? `submit failed: ${res.status}`);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [state.submitRequested, effectiveReadOnly, onSubmitting, onSubmitted, onError]);

  // ── React to a review-draft-updated WS ping ──────────────────────────────
  const firstPing = useRef(true);
  useEffect(() => {
    if (firstPing.current) { firstPing.current = false; return; }
    void (async () => {
      try {
        const res = await fetch('/api/review');
        if (!res.ok) return;
        const body = await res.json() as ReviewPayload;
        const snapshot = stateRef.current;
        // The server broadcasts `review-draft-updated` to every socket,
        // including the tab that triggered it. A version at or below what we
        // already have is our own save (or stale) — skip the refetch.
        if (typeof body.version === 'number' && body.version <= snapshot.version) return;
        if (snapshot.saveState === 'clean' && snapshot.composer === null) {
          dispatch({ type: 'server/replace', review: body });
        } else {
          dispatch({ type: 'draft/external-update', version: body.version, message: 'The draft changed elsewhere. Your unsaved edits are kept; saving will re-anchor them.' });
        }
      } catch {
        // ignore transient refetch failure
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPing]);

  // The "add comment" button's accessible name reflects the full active
  // anchor (a range, not just its start line), matching the composer and
  // comment-list labels.
  const activeRangeLabel = state.selection
    ? reviewRangeLabel({
      id: 'active', line: state.selection.line, endLine: state.selection.endLine,
      colStart: state.selection.colStart, colEnd: state.selection.colEnd,
      lineText: '', comment: '', createdAt: '',
    })
    : `L${state.activeLine}`;

  const saveLabel = effectiveReadOnly
    ? 'read-only'
    : state.saveState === 'saving' ? 'saving…'
      : state.saveState === 'save-error' ? 'save error'
        : state.saveState === 'conflict' ? 'conflict'
          : state.saveState === 'dirty' ? 'unsaved' : 'saved';

  return (
    <div className={cn('flex flex-col gap-4', effectiveReadOnly && 'pointer-events-none opacity-60')}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{state.comments.length} comment{state.comments.length === 1 ? '' : 's'} · version {state.version} · {saveLabel}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'list/toggle' })}>
            {state.listOpen ? 'Hide comments' : 'Comments'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'help/toggle' })} aria-label="Show review keyboard shortcuts">?</Button>
          <Button size="sm" onClick={() => dispatch({ type: 'submit/request' })} disabled={effectiveReadOnly}>
            {state.comments.length === 0 ? 'Looks good — submit' : 'Submit review'}
          </Button>
        </div>
      </div>

      {state.saveState === 'conflict' && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-900 dark:text-red-200">
          <span>{state.notice}</span>
          <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'draft/resolve-conflict' })}>
            Save my edits
          </Button>
        </div>
      )}

      {state.notice !== null && state.saveState !== 'conflict' && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          {state.notice}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <ReviewDocument state={state} dispatch={dispatch} scrollRef={scrollRef} />
          {state.composer !== null && (
            <CommentComposer
              composer={state.composer}
              onChange={(buffer) => dispatch({ type: 'composer/update', buffer })}
              onSubmit={() => dispatch({ type: 'composer/submit' })}
              onCancel={() => dispatch({ type: 'composer/cancel' })}
            />
          )}
          {state.composer === null && !effectiveReadOnly && (
            <Button variant="outline" className="w-fit" onClick={() => dispatch({ type: 'composer/open' })}>
              Add comment on {activeRangeLabel}
            </Button>
          )}
        </div>
        {state.listOpen && (
          <CommentList
            comments={state.comments}
            activeIndex={state.listIndex}
            readOnly={effectiveReadOnly}
            onEdit={(id) => dispatch({ type: 'composer/edit', id })}
            onDelete={(id) => dispatch({ type: 'comment/delete', id })}
            onClose={() => dispatch({ type: 'list/close' })}
          />
        )}
      </div>

      {state.helpOpen && <ReviewHelpOverlay onClose={() => dispatch({ type: 'help/close' })} />}
    </div>
  );
}
