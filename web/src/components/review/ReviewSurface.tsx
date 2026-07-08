import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FeedbackComment, ReviewPayload } from '@/types';
import { Button } from '@/components/ui/button';
import { reviewReducer, buildInitialReviewState, collectReviewComments } from '@/lib/reviewReducer';
import type { ReviewState } from '@/lib/reviewState';
import { useReviewKeymap } from '@/hooks/useReviewKeymap';
import { reviewRangeLabel } from '@/lib/sourceMap';
import { cn } from '@/lib/utils';
import { ReviewDocument } from './ReviewDocument';
import { CommentComposer } from './CommentComposer';
import { CommentList } from './CommentList';
import { ReviewHelpOverlay } from './ReviewHelpOverlay';

const AUTOSAVE_DELAY_MS = 700;

// Discriminated result of a draft-save attempt. `ok: true` carries the exact
// version + comments the server just acked — the caller (Submit, in
// particular) must use THIS value rather than re-reading React state right
// after the await, since React may not have re-rendered yet.
type DraftSaveResult =
  | { ok: true; version: number; comments: FeedbackComment[] }
  | { ok: false; reason: 'conflict' | 'already-submitted' | 'error' };

export interface ReviewSurfaceProps {
  review: ReviewPayload;
  /** True once the top-level surface has converged (taken-back / submitted) —
   *  freezes editing and detaches the keymap. */
  readOnly: boolean;
  /** Increments each time the server broadcasts `review-draft-updated`, so a
   *  second tab / relaunched nvim draft can refetch or stale-notice. */
  draftPing: number;
  /** Increments each time the server broadcasts `take-back-requested` —
   *  the terminal wants control back and is waiting for this tab to flush
   *  any pending edit and ack before it proceeds. */
  takeBackPing: number;
  onSubmitting: () => void;
  onSubmitted: () => void;
  onError: (message: string) => void;
}

export function ReviewSurface({ review, readOnly, draftPing, takeBackPing, onSubmitting, onSubmitted, onError }: ReviewSurfaceProps) {
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

  // Tracks any PUT /api/review/draft currently in flight so a concurrent
  // debounce-fire and take-back-flush can't double-send, and so Submit can
  // await the SAME save instead of racing it (Major 3: submit must never
  // carry a baseVersion the browser's own in-flight autosave is about to
  // bump past, or it trips a false 409 stale_draft against itself).
  const pendingSaveRef = useRef<Promise<DraftSaveResult> | null>(null);

  const runDraftSave = useCallback((snapshot: ReviewState): Promise<DraftSaveResult> => {
    const promise = (async (): Promise<DraftSaveResult> => {
      const sentComments = collectReviewComments(snapshot);
      dispatch({ type: 'draft/save-start' });
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
          // Return the exact version+comments this request just flushed —
          // NOT a re-read of React state, which may not have re-rendered yet
          // by the time a caller resumes from awaiting this promise. This is
          // what lets Submit use "the updated version" reliably.
          return { ok: true, version: ackVersion, comments: sentComments };
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
          return { ok: false, reason: 'conflict' };
        }
        if (res.status === 409 && body.error === 'already_submitted') {
          onSubmitted();
          return { ok: false, reason: 'already-submitted' };
        }
        dispatch({ type: 'draft/save-error', message: body.error ?? `autosave failed: ${res.status}` });
        return { ok: false, reason: 'error' };
      } catch (err) {
        dispatch({ type: 'draft/save-error', message: err instanceof Error ? err.message : String(err) });
        return { ok: false, reason: 'error' };
      }
    })();
    pendingSaveRef.current = promise;
    void promise.finally(() => { if (pendingSaveRef.current === promise) pendingSaveRef.current = null; });
    return promise;
  }, [onSubmitted]);

  // ── Autosave: debounce a dirty draft to PUT /api/review/draft ────────────
  useEffect(() => {
    if (state.saveState !== 'dirty' || effectiveReadOnly) return;
    const timer = window.setTimeout(() => {
      void runDraftSave(stateRef.current);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state.saveState, state.comments, effectiveReadOnly, runDraftSave]);

  // ── React to a take-back-requested WS ping: flush a still-unsent dirty edit
  // synchronously (bypassing the debounce) before acking, so a fast terminal
  // take-back can't race the autosave debounce and silently drop the edit. A
  // 'save-error'/'conflict' state is deliberately NOT auto-resolved here (that
  // stays a human decision, per the stale-draft-conflict contract) — take-back
  // proceeds regardless rather than blocking forever on a state only a human
  // can resolve. ─────────────────────────────────────────────────────────────────────────
  const firstTakeBackPing = useRef(true);
  useEffect(() => {
    if (firstTakeBackPing.current) { firstTakeBackPing.current = false; return; }
    void (async () => {
      // Wait out any save already in flight rather than firing a duplicate PUT.
      if (pendingSaveRef.current) await pendingSaveRef.current;
      const snapshot = stateRef.current;
      if (snapshot.saveState === 'dirty') await runDraftSave(snapshot);
      try { await fetch('/api/review/take-back-ack', { method: 'POST' }); } catch { /* best-effort; server bounds its wait with a timeout */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeBackPing, runDraftSave]);

  // ── Submit ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!state.submitRequested) return;
    dispatch({ type: 'submit/clear-request' });
    if (effectiveReadOnly) return;
    onSubmitting();
    // Unlike onSubmitted, an ORDINARY submit failure (status still
    // 'submitting') must leave the surface editable again — both the
    // top-level status and the reducer's own readOnly ratchet (set by the
    // mark-readonly effect keyed off the `readOnly` prop) need to release,
    // or the surface deadlocks read-only forever after a recoverable
    // failure. `onError` is App's monotonic `transition('error')` (see
    // App.tsx's status-lattice comment): if a terminal WS event
    // (taken-back/converged/disconnected) already landed while this submit
    // was in flight, that call is a no-op and the top-level `readOnly` prop
    // stays true, so unconditionally unmarking the reducer's ratchet here is
    // harmless — `effectiveReadOnly = readOnly || state.readOnly` still
    // reads true off the prop alone. The unmark is only load-bearing on the
    // genuine 'submitting' → 'error' path, where the prop itself goes false.
    const failSubmit = (message: string) => {
      dispatch({ type: 'server/unmark-readonly' });
      onError(message);
    };
    void (async () => {
      try {
        // Never race the browser's own in-flight autosave (Major 3): the
        // 700ms debounce can fire a draft PUT moments before Submit is
        // clicked. If that PUT lands first it bumps the server's version,
        // and a submit still carrying the pre-save baseVersion would trip a
        // false 409 stale_draft against its own save. Await whatever save is
        // already in flight; if none is in flight but the state is still
        // dirty, run one now — either way, submit ends up carrying the exact
        // version + comments that flush produced, not a stale snapshot.
        let flushed: DraftSaveResult | null = null;
        if (pendingSaveRef.current) {
          flushed = await pendingSaveRef.current;
        } else if (stateRef.current.saveState === 'dirty') {
          flushed = await runDraftSave(stateRef.current);
        }
        if (flushed !== null && !flushed.ok) {
          if (flushed.reason === 'already-submitted') {
            // onSubmitted() already fired inside runDraftSave.
            return;
          }
          if (flushed.reason === 'conflict') {
            failSubmit('Draft changed elsewhere before submit. Resolve the conflict, then submit again.');
            return;
          }
          failSubmit('Autosave failed before submit — resolve the save error, then submit again.');
          return;
        }
        const comments = flushed !== null ? flushed.comments : collectReviewComments(stateRef.current);
        const baseVersion = flushed !== null ? flushed.version : stateRef.current.version;
        const res = await fetch('/api/review/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments, baseVersion }),
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
          failSubmit('Draft changed elsewhere before submit. Your edits are kept; submit again to finalize.');
          return;
        }
        failSubmit(body.error ?? `submit failed: ${res.status}`);
      } catch (err) {
        failSubmit(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [state.submitRequested, effectiveReadOnly, onSubmitting, onSubmitted, onError, runDraftSave]);

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
