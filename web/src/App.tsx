import { useEffect, useState, useCallback } from 'react';
import type { Deck, FeedbackComment, InteractionResponse, ReviewPayload } from '@/types';
import { StatusBanner, type SurfaceStatus } from '@/components/StatusBanner';
import { DeckSurface } from '@/components/DeckSurface';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type SurfaceKind = 'deck' | 'review';

function parseCommentsJson(value: string): FeedbackComment[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('comments JSON must be an array');
  return parsed as FeedbackComment[];
}

function ReviewSurface({
  review,
  status,
  onDraftSaved,
  onSubmitted,
  onError,
}: {
  review: ReviewPayload;
  status: SurfaceStatus;
  onDraftSaved: (review: ReviewPayload) => void;
  onSubmitted: (review?: ReviewPayload) => void;
  onError: (message: string) => void;
}) {
  const [commentsJson, setCommentsJson] = useState(() => JSON.stringify(review.result.comments, null, 2));
  const [version, setVersion] = useState(review.version);
  const [saveState, setSaveState] = useState<'clean' | 'saving' | 'error'>('clean');
  const applyCanonicalResult = useCallback((result: ReviewPayload['result'], nextVersion: number) => {
    const nextReview = { ...review, result, version: nextVersion };
    setVersion(nextVersion);
    setCommentsJson(JSON.stringify(result.comments, null, 2));
    onDraftSaved(nextReview);
    return nextReview;
  }, [onDraftSaved, review]);

  useEffect(() => {
    setCommentsJson(JSON.stringify(review.result.comments, null, 2));
    setVersion(review.version);
    setSaveState('clean');
  }, [review.result.comments, review.version]);
  const disabled = status === 'loading' || status === 'submitting' || status === 'submitted' || status === 'taken-back';

  const saveDraft = useCallback(async () => {
    setSaveState('saving');
    try {
      const comments = parseCommentsJson(commentsJson);
      const res = await fetch('/api/review/draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: version }),
      });
      const body = await res.json() as { error?: string; version?: number; result?: ReviewPayload['result'] };
      if (!res.ok) {
        if (res.status === 409 && body.error === 'stale_draft') {
          if (typeof body.version !== 'number' || !body.result) throw new Error('stale draft response missing canonical review state');
          applyCanonicalResult(body.result, body.version);
          setSaveState('error');
          onError('Draft changed elsewhere; refreshed to the latest server version. Reapply your edits and save again.');
          return;
        }
        if (res.status === 409 && body.error === 'already_submitted') {
          const submittedReview = body.result
            ? applyCanonicalResult(body.result, typeof body.version === 'number' ? body.version : version)
            : undefined;
          setSaveState('clean');
          onSubmitted(submittedReview);
          return;
        }
        throw new Error(body.error ?? `draft save failed: ${res.status}`);
      }
      if (typeof body.version !== 'number' || !body.result) throw new Error('draft save returned an invalid response');
      applyCanonicalResult(body.result, body.version);
      setSaveState('clean');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveState('error');
      onError(message);
    }
  }, [applyCanonicalResult, commentsJson, onError, onSubmitted, version]);

  const submitReview = useCallback(async () => {
    try {
      const comments = parseCommentsJson(commentsJson);
      const res = await fetch('/api/review/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments, baseVersion: version }),
      });
      const body = await res.json() as { error?: string; result?: ReviewPayload['result']; version?: number };
      if (!res.ok) {
        if (res.status === 409 && body.error === 'already_submitted') {
          const submittedReview = body.result
            ? applyCanonicalResult(body.result, typeof body.version === 'number' ? body.version : version)
            : undefined;
          onSubmitted(submittedReview);
          return;
        }
        if (res.status === 409 && body.error === 'stale_draft' && typeof body.version === 'number' && body.result) {
          applyCanonicalResult(body.result, body.version);
        }
        throw new Error(body.error ?? `submit failed: ${res.status}`);
      }
      const submittedReview = body.result ? applyCanonicalResult(body.result, version) : undefined;
      onSubmitted(submittedReview);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [applyCanonicalResult, commentsJson, onError, onSubmitted, version]);

  return (
    <div className={disabled ? 'pointer-events-none opacity-60' : ''}>
      <div className="grid gap-4">
        <section className="rounded-lg border bg-card p-4">
          <div className="mb-2 text-sm text-muted-foreground">Source: {review.file}</div>
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{review.content}</pre>
        </section>

        <section className="rounded-lg border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">Review comments JSON</h2>
              <p className="text-sm text-muted-foreground">Minimal Phase 3 backend handoff surface. Full anchored review UI comes later.</p>
            </div>
            <div className="text-xs text-muted-foreground">version {version} · {saveState}</div>
          </div>
          <Textarea
            className="min-h-56 font-mono text-sm"
            value={commentsJson}
            onChange={(event) => {
              setCommentsJson(event.target.value);
              setSaveState('clean');
            }}
            disabled={disabled}
          />
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" onClick={saveDraft} disabled={disabled || saveState === 'saving'}>
              Save draft
            </Button>
            <Button type="button" onClick={submitReview} disabled={disabled}>
              Submit review
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const [surface, setSurface] = useState<SurfaceKind | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [status, setStatus] = useState<SurfaceStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const loadReview = useCallback(() => {
    fetch('/api/review')
      .then((r) => {
        if (!r.ok) throw new Error(`review load failed: ${r.status}`);
        return r.json() as Promise<ReviewPayload>;
      })
      .then((body) => {
        setReview(body);
        setError(null);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  }, []);

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
        loadReview();
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  }, [loadReview]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type?: string };
        if (msg.type === 'taken-back') setStatus('taken-back');
        if (msg.type === 'converged') setStatus((s) => (s === 'taken-back' ? s : 'submitted'));
        if (msg.type === 'review-draft-updated' && surface === 'review') loadReview();
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, [loadReview, surface]);

  const submitDeck = useCallback((responses: InteractionResponse[]) => {
    setStatus('submitting');
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses }),
    })
      .then((r) => {
        // 409 means another submit (a second tab, a race) already won and
        // wrote the canonical response.json — that's convergence, not an
        // error, so treat it the same as this tab's own submit succeeding.
        if (!r.ok && r.status !== 409) throw new Error(`submit failed: ${r.status}`);
        setStatus('submitted');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {deck?.title ?? (review ? 'humanloop — review' : 'humanloop — browser surface')}
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
          status={status}
          onDraftSaved={(nextReview) => {
            setReview(nextReview);
            setError(null);
            setStatus('ready');
          }}
          onSubmitted={(nextReview) => {
            if (nextReview) setReview(nextReview);
            setError(null);
            setStatus('submitted');
          }}
          onError={(message) => {
            setError(message);
            setStatus('error');
          }}
        />
      )}
      {!deck && !review && status === 'loading' && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
    </div>
  );
}
