import { useCallback, useEffect, useState } from 'react';
import type { Deck, InteractionResponse, ReviewPayload } from '@/types';
import { StatusBanner, type SurfaceStatus } from '@/components/StatusBanner';
import { DeckSurface } from '@/components/DeckSurface';
import { ReviewSurface } from '@/components/review/ReviewSurface';
import { cn } from '@/lib/utils';

type SurfaceKind = 'deck' | 'review';

// ── Status transition lattice ───────────────────────────────────────────────
// `status` has many independent writers below: the WS message handler,
// `onclose`, both initial-load fetch chains (including their failure path),
// deck submit (start/success/failure), and review submit/take-back
// (start/success/failure). Four review rounds each found a NEW writer that
// could clobber a genuinely-terminal status with a stale/racing write — an
// initial-load 'ready' stomping a WS taken-back that arrived first, `onclose`
// downgrading a prior taken-back/converged, and (the bug this lattice closes)
// a stale submit failure resurrecting an editable terminal surface. Routing
// every write through `transition()` below closes the whole class at once
// instead of special-casing each writer ad hoc.
//
// Statuses are ranked by how final they are. A transition is allowed only if
// it strictly increases rank — the lattice only ever moves forward — with one
// narrow, explicit exception: 'submitting' and 'error' share a rank and may
// move to each other in either direction (a failed submit must release back
// to an editable 'error' state, and clicking Submit again must be able to
// move from 'error' back to 'submitting').
//
// Rank 4 ('submitted', 'taken-back', 'disconnected') is maximal and TERMINAL:
// once one is reached, no later write — including a stale submit's later
// failure — can ever move `status` again. Rank 3 ('taking-back',
// 'pending-handoff') is frozen (both are in `reviewReadOnly` below and gate
// the deck's `disabled`) but not terminal: it can still advance to a rank-4
// terminal status (the take-back handshake completing, or the initial load
// discovering the review was already submitted), it just can never fall back
// to 'ready' / 'submitting' / 'error'.
const STATUS_RANK: Record<SurfaceStatus, number> = {
  loading: 0,
  ready: 1,
  submitting: 2,
  error: 2,
  'taking-back': 3,
  'pending-handoff': 3,
  submitted: 4,
  'taken-back': 4,
  disconnected: 4,
};

// The one explicit lateral exception to the rank-only rule above.
const LATERAL_TRANSITIONS = new Set(['submitting->error', 'error->submitting']);

function statusTransitionAllowed(prev: SurfaceStatus, next: SurfaceStatus): boolean {
  if (STATUS_RANK[next] > STATUS_RANK[prev]) return true;
  return LATERAL_TRANSITIONS.has(`${prev}->${next}`);
}

/**
 * Thin surface shell: connect `/ws`, fetch `/api/surface`, then hand off to
 * either the deck app (unchanged Phase-2 behavior) or the review app. All
 * deck/review-specific state lives inside those surfaces — this shell only
 * owns the top-level convergence status vocabulary
 * (loading | ready | submitting | submitted | taking-back | taken-back |
 * pending-handoff | disconnected | error). Every writer below calls
 * `transition()`, never `setStatus` directly, so no writer can clobber a
 * more-final status — see the lattice comment above.
 */
export default function App() {
  const [surface, setSurface] = useState<SurfaceKind | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [deckResponses, setDeckResponses] = useState<InteractionResponse[]>([]);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [status, setStatus] = useState<SurfaceStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [draftPing, setDraftPing] = useState(0);
  const [takeBackPing, setTakeBackPing] = useState(0);

  // The single writer every `status` transition below must go through — see
  // the lattice comment above the component.
  const transition = useCallback((next: SurfaceStatus) => {
    setStatus((prev) => (statusTransitionAllowed(prev, next) ? next : prev));
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
              return r.json() as Promise<{ deck: Deck; responses?: InteractionResponse[] }>;
            })
            .then((interaction) => {
              setDeck(interaction.deck);
              setDeckResponses(Array.isArray(interaction.responses) ? interaction.responses : []);
              // The fetch chain and the WS effect run independently — a
              // taken-back/taking-back/disconnected status can already have
              // landed (via WS onmessage/onclose) while this request was
              // still in flight. `transition('ready')` (rank 1) is a no-op
              // against anything already at rank ≥ 1 other than 'loading'
              // itself, so this can never stomp a terminal/frozen status back
              // to editable.
              transition('ready');
            });
        }
        return fetch('/api/review')
          .then((r) => {
            if (!r.ok) throw new Error(`review load failed: ${r.status}`);
            return r.json() as Promise<ReviewPayload>;
          })
          .then((body2) => {
            setReview(body2);
            // Same lattice as the deck branch above: whichever of
            // submitted/pending-handoff/ready this resolves to, `transition`
            // only applies it if that's a rank increase over whatever status
            // is current — a WS taken-back/taking-back/converged push or an
            // onclose fallback that landed while this request was in flight
            // wins over this stale initial snapshot.
            if (body2.result.submitted) transition('submitted');
            else if (!body2.activated) transition('pending-handoff');
            else transition('ready');
          });
      })
      .catch((e: unknown) => {
        // Same class of bug as a stale submit failure (see the lattice
        // comment above): if a terminal/frozen status already landed via WS
        // while this fetch chain was still in flight, a later failure here
        // must not resurrect an editable/generic-error surface over it.
        setError(e instanceof Error ? e.message : String(e));
        transition('error');
      });
  }, [transition]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type?: string };
        if (msg.type === 'taken-back') transition('taken-back');
        else if (msg.type === 'converged') transition('submitted');
        else if (msg.type === 'review-draft-updated') setDraftPing((n) => n + 1);
        else if (msg.type === 'take-back-requested') {
          // Freeze the surface THE INSTANT take-back-requested arrives — in
          // the same state update as the takeBackPing bump that kicks off
          // ReviewSurface's flush, so there is no window where the UI stays
          // editable while the terminal is waiting on the flush/ack
          // handshake. Without this, an edit made after this message but
          // before the later 'taken-back' message would never make it into
          // the forced-save snapshot. `transition('taking-back')` (rank 3) is
          // a no-op if a terminal status already landed; the ping bump is
          // unconditional — it drives ReviewSurface's flush-and-ack effect
          // regardless of whether the banner status itself moved.
          transition('taking-back');
          setTakeBackPing((n) => n + 1);
        }
        // unknown message types are ignored, per the protocol-growth contract
      } catch {
        // ignore malformed frames
      }
    };
    // Fallback for a lost taken-back/converged frame (network hiccup, or the
    // terminal process itself crashing mid-handoff without a clean broadcast):
    // an onclose with no prior convergence status still must not leave the tab
    // stuck editable/stale. Deliberately its own status — unlike taken-back it
    // can't disambiguate which of taken-back/converged actually happened.
    ws.onclose = () => {
      transition('disconnected');
    };
    return () => ws.close();
  }, [transition]);

  const submitDeck = useCallback((responses: InteractionResponse[]) => {
    transition('submitting');
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses }),
    })
      .then((r) => {
        // 409 means another submit (a second tab, a race) already won — that's
        // convergence, not an error.
        if (!r.ok && r.status !== 409) throw new Error(`submit failed: ${r.status}`);
        transition('submitted');
      })
      .catch((e: unknown) => {
        // Same class of bug as the review submit path below: if a terminal WS
        // event (taken-back/converged/disconnected) already landed while this
        // deck submit was in flight, this stale failure must not resurrect an
        // editable surface — `transition('error')` is a no-op against it.
        setError(e instanceof Error ? e.message : String(e));
        transition('error');
      });
  }, [transition]);

  // Stable identities so a mid-debounce `App` re-render never restarts the
  // review autosave/submit effects (their deps include these callbacks).
  const handleSubmitting = useCallback(() => transition('submitting'), [transition]);
  const handleSubmitted = useCallback(() => transition('submitted'), [transition]);
  const handleReviewError = useCallback((message: string) => {
    // `transition('error')` is the fix for the class of bug this whole
    // lattice exists to close: a stale submit failure (the in-flight
    // request that lost a race to a terminal WS event — taken-back /
    // converged / disconnected — arriving first) can no longer overwrite a
    // terminal status here. `error` is still recorded so it renders on the
    // legitimate non-terminal path (status genuinely moves to 'error' from
    // 'submitting'); StatusBanner only ever displays it when `status ===
    // 'error'`, so recording it unconditionally is harmless when the
    // transition itself was rejected.
    setError(message);
    transition('error');
  }, [transition]);

  // 'submitting' freezes the surface the instant Submit is clicked —
  // matches the deck's `disabled={status !== 'ready'}` — so a comment can
  // never be added/edited/deleted while submit is awaiting the in-flight
  // autosave flush it's about to submit. Unlike the other statuses here,
  // 'submitting' is NOT terminal: a failed submit takes status back to
  // 'error', which is deliberately excluded from this list so the surface
  // un-freezes rather than deadlocking (ReviewSurface's own reducer state
  // mirrors this via a matching 'server/unmark-readonly' dispatch on the
  // submit-failure path).
  const reviewReadOnly = status === 'submitting' || status === 'taking-back' || status === 'taken-back' || status === 'submitted' || status === 'pending-handoff' || status === 'disconnected';

  // The review document (prose + code + tables + diagrams) reads best with
  // real width, so the shell is gated per-surface — the deck keeps its
  // narrow reading column, review gets a wide one.
  return (
    <div className={cn('mx-auto flex min-h-screen flex-col gap-6 p-8', surface === 'review' ? 'max-w-7xl' : 'max-w-3xl')}>
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
        <DeckSurface deck={deck} initialResponses={deckResponses} onSubmit={submitDeck} disabled={status !== 'ready'} />
      )}
      {surface === 'review' && review && (
        <ReviewSurface
          review={review}
          readOnly={reviewReadOnly}
          draftPing={draftPing}
          takeBackPing={takeBackPing}
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
