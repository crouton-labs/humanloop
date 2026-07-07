import { useEffect, useState, useCallback } from 'react';
import type { Deck, InteractionResponse } from '@/types';
import { StatusBanner, type SurfaceStatus } from '@/components/StatusBanner';
import { DeckSurface } from '@/components/DeckSurface';

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [status, setStatus] = useState<SurfaceStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/interaction')
      .then((r) => r.json())
      .then((body: { deck: Deck }) => {
        setDeck(body.deck);
        setStatus('ready');
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
        if (msg.type === 'converged') setStatus((s) => (s === 'taken-back' ? s : 'submitted'));
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
          {deck?.title ?? 'humanloop — browser surface'}
        </h1>
        {(deck?.source?.sessionName || deck?.source?.askedBy) && (
          <p className="text-muted-foreground text-sm">
            {[deck.source?.sessionName, deck.source?.askedBy].filter(Boolean).join(' · ')}
          </p>
        )}
      </header>

      <StatusBanner status={status} error={error} />

      {deck && (
        <DeckSurface deck={deck} onSubmit={submitDeck} disabled={status !== 'ready'} />
      )}
      {!deck && status === 'loading' && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
    </div>
  );
}
