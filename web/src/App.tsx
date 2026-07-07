import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import type { Deck, InteractionResponse } from '@/types';

// Placeholder Phase 1 page: proves the transport end-to-end. Renders the raw
// deck JSON and writes a stub response.json on submit — the real per-kind
// deck UI (options, freetext, comments, markdown body) is Phase 2. See
// phase1-server-contract.md for the API this talks to.

type Status = 'loading' | 'ready' | 'submitting' | 'submitted' | 'taken-back' | 'error';

function stubResponses(deck: Deck): InteractionResponse[] {
  return deck.interactions.map((interaction) => {
    const response: InteractionResponse = { id: interaction.id };
    if (interaction.multiSelect) {
      response.selectedOptionIds = interaction.options.length > 0 ? [interaction.options[0]!.id] : [];
    } else if (interaction.options.length > 0) {
      response.selectedOptionId = interaction.options[0]!.id;
    } else if (interaction.allowFreetext) {
      response.freetext = 'Stub response from the browser surface (Phase 1 placeholder).';
    }
    return response;
  });
}

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [status, setStatus] = useState<Status>('loading');
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

  const submitStub = useCallback(() => {
    if (!deck) return;
    setStatus('submitting');
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses: stubResponses(deck) }),
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
  }, [deck]);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {deck?.title ?? 'humanloop — browser surface'}
        </h1>
        <p className="text-muted-foreground text-sm">
          Phase 1 placeholder — raw deck JSON below. The real deck UI (options,
          freetext, comments, markdown) ships in Phase 2.
        </p>
      </header>

      {status === 'taken-back' && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          The terminal took control back. This page is now read-only — submitting
          here no longer has any effect. You can close this tab.
        </div>
      )}
      {status === 'submitted' && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-200">
          Submitted — response.json has been written. The terminal session will
          converge automatically. You can close this tab.
        </div>
      )}
      {status === 'error' && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error ?? 'Something went wrong.'}
        </div>
      )}

      <div className="rounded-md border bg-card">
        <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
          deck.json
        </div>
        <pre className="max-h-[60vh] overflow-auto p-4 text-xs leading-relaxed">
          {deck ? JSON.stringify(deck, null, 2) : status === 'loading' ? 'Loading…' : ''}
        </pre>
      </div>

      <div>
        <Button
          onClick={submitStub}
          disabled={!deck || status === 'submitting' || status === 'submitted' || status === 'taken-back'}
        >
          {status === 'submitting' ? 'Submitting…' : 'Submit stub response'}
        </Button>
      </div>
    </div>
  );
}
