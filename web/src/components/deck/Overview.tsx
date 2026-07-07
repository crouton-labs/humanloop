import { cn } from '@/lib/utils';
import type { DeckState } from '@/lib/deckState';
import { responseSummary } from '@/lib/deckState';
import type { DeckAction } from '@/lib/deckReducer';
import { Button } from '@/components/ui/button';
import { StatusIcon } from './StatusIcon';

export interface OverviewProps {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
}

/** The multi-interaction list — mirrors `render.ts`'s `renderOverview`.
 *  Clicking a row focuses AND opens it (matches pressing Enter on a focused
 *  row); `j`/`k`/click both move `currentIndex` through the same
 *  `overview/move` / `overview/enter` actions. */
export function Overview({ state, dispatch }: OverviewProps) {
  const answered = state.responses.size;
  const total = state.interactions.length;

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Interactions</h2>
        <span className="text-xs text-muted-foreground">{answered}/{total} answered</span>
      </div>
      <ul className="flex flex-col gap-1">
        {state.interactions.map((interaction, i) => {
          const response = state.responses.get(interaction.id);
          const preAnswered = state.preAnsweredIds.has(interaction.id);
          const status = response === undefined ? 'unanswered' : preAnswered ? 'pre-answered' : 'answered';
          const focused = i === state.currentIndex;
          return (
            <li key={interaction.id}>
              <button
                type="button"
                onClick={() => dispatch({ type: 'overview/enter', index: i })}
                className={cn(
                  'flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:bg-accent',
                  focused && 'border-ring bg-accent/60',
                )}
              >
                <StatusIcon status={status} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{interaction.title}</div>
                  {response !== undefined && (
                    <div className="truncate text-xs text-muted-foreground">
                      {responseSummary(response, interaction)}
                    </div>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span><kbd className="rounded border border-border bg-muted px-1">enter</kbd> review</span>
          <span><kbd className="rounded border border-border bg-muted px-1">j</kbd>/<kbd className="rounded border border-border bg-muted px-1">k</kbd> navigate</span>
          <span><kbd className="rounded border border-border bg-muted px-1">q</kbd> finish</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'overview/finish' })}>
          Finish
        </Button>
      </div>
    </div>
  );
}
