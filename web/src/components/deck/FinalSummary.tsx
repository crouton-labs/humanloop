import { Button } from '@/components/ui/button';
import type { DeckState } from '@/lib/deckState';
import { responseSummary } from '@/lib/deckState';
import type { DeckAction } from '@/lib/deckReducer';
import { StatusIcon } from './StatusIcon';

export interface FinalSummaryProps {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
}

/** The pre-submit summary screen — mirrors `render.ts`'s `renderFinal`.
 *  Submitting from here is unconditional (a partial deck can still submit,
 *  matching the terminal's own `handleFinal`). */
export function FinalSummary({ state, dispatch }: FinalSummaryProps) {
  const total = state.interactions.length;
  const answered = state.responses.size;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Summary</h2>
        <span className="text-xs text-muted-foreground">{answered}/{total} answered</span>
      </div>
      <ul className="flex flex-col gap-1">
        {state.interactions.map((interaction) => {
          const response = state.responses.get(interaction.id);
          const preAnswered = state.preAnsweredIds.has(interaction.id);
          const status = response === undefined ? 'unanswered' : preAnswered ? 'pre-answered' : 'answered';
          return (
            <li key={interaction.id} className="flex items-start gap-3 rounded-md px-3 py-2">
              <StatusIcon status={status} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{interaction.title}</div>
                {response !== undefined && (
                  <div className="truncate text-xs text-muted-foreground">
                    {responseSummary(response, interaction)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {answered < total && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {total - answered} unanswered — you can still submit, or go back (p).
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'final/prev' })}>← Back to last item</Button>
        <Button size="sm" className="ml-auto" onClick={() => dispatch({ type: 'final/confirm' })}>
          Submit
        </Button>
      </div>
    </div>
  );
}
