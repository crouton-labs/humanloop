import { useCallback, useEffect, useState } from 'react';
import type { Deck, InteractionResponse, ReviewPayload } from '@/types';
import { StatusBanner, type SurfaceStatus } from '@/components/StatusBanner';
import { DeckSurface } from '@/components/DeckSurface';
import { ReviewSurface } from '@/components/review/ReviewSurface';
import { cn } from '@/lib/utils';

type SurfaceKind = 'deck' | 'review';

/**
 * Thin surface shell: connect `/ws`, fetch `/api/surface`, then hand off to
 * either the deck app (unchanged Phase-2 behavior) or the review app. All
 * deck/review-specific state lives inside those surfaces — this shell only
 * owns the top-level convergence status vocabulary
 * (loading | ready | submitting | submitted | taken-back | error).
 */
export default function App() {
  const [surface, setSurface] = useState<SurfaceKind | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [status, setStatus] = useState<SurfaceStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [draftPing, setDraftPing] = useState(0);

  useEffect(() => {
    fetch('/api/surface')
      .then((r) => {
        if (!r.ok) throw new Error(`surface load failed: ${r.status}`);
        return r.json() as Promise<{ kind: SurfaceKind }>;
      })
      .then((body) => {
        setSurface(body.kind);
        if (body.kind === 'deck') {
          return fetch('/api/interaction')
            .then((r) => {
              if (!r.ok) throw new Error(`interaction load failed: ${r.status}`);
              return r.json() as Promise<{ deck: Deck }>;
            })
            .then((interaction) => {
              setDeck(interaction.deck);
              setStatus('ready');
            });
        }
        return fetch('/api/review')
          .then((r) => {
            if (!r.ok) throw new Error(`review load failed: ${r.status}`);
            return r.json() as Promise<ReviewPayload>;
          })
          .then((body2) => {
            setReview(body2);
            if (body2.result.submitted) setStatus('submitted');
            else setStatus('ready');
          });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type?: string };
        if (msg.type === 'taken-back') setStatus('taken-back');
        else if (msg.type === 'converged') setStatus((s) => (s === 'taken-back' ? s : 'submitted'));
        else if (msg.type === 'review-draft-updated') setDraftPing((n) => n + 1);
        // unknown message types are ignored, per the protocol-growth contract
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, []);

  const submitDeck = useCallback((responses: InteractionResponse[]) => {
    setStatus('submitting');
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses }),
    })
      .then((r) => {
        // 409 means another submit (a second tab, a race) already won — that's
        // convergence, not an error.
        if (!r.ok && r.status !== 409) throw new Error(`submit failed: ${r.status}`);
        setStatus('submitted');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  }, []);

  // Stable identities so a mid-debounce `App` re-render never restarts the
  // review autosave/submit effects (their deps include these callbacks).
  const handleSubmitting = useCallback(() => setStatus('submitting'), []);
  const handleSubmitted = useCallback(() => setStatus('submitted'), []);
  const handleReviewError = useCallback((message: string) => {
    setError(message);
    setStatus('error');
  }, []);

  const reviewReadOnly = status === 'taken-back' || status === 'submitted';

  // The review document + comment list need more width than the deck's
  // single-column layout, so the shell width is gated per-surface — the deck
  // keeps its narrower column, review gets the wider one.
  return (
    <div className={cn('mx-auto flex min-h-screen flex-col gap-6 p-8', surface === 'review' ? 'max-w-5xl' : 'max-w-3xl')}>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {deck?.title ?? (surface === 'review' ? 'humanloop — review' : 'humanloop — browser surface')}
        </h1>
        {(deck?.source?.sessionName || deck?.source?.askedBy) && (
          <p className="text-muted-foreground text-sm">
            {[deck.source?.sessionName, deck.source?.askedBy].filter(Boolean).join(' · ')}
          </p>
        )}
      </header>

      <StatusBanner status={status} error={error} />

      {surface === 'deck' && deck && (
        <DeckSurface deck={deck} onSubmit={submitDeck} disabled={status !== 'ready'} />
      )}
      {surface === 'review' && review && (
        <ReviewSurface
          review={review}
          readOnly={reviewReadOnly}
          draftPing={draftPing}
          onSubmitting={handleSubmitting}
          onSubmitted={handleSubmitted}
          onError={handleReviewError}
        />
      )}
      {!deck && !review && status === 'loading' && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
    </div>
  );
}
