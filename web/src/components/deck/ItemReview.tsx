import type { RefObject } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { cn } from '@/lib/utils';
import type { DeckState } from '@/lib/deckState';
import { responseSummary } from '@/lib/deckState';
import type { DeckAction } from '@/lib/deckReducer';
import { OptionRow } from './OptionRow';
import { InputPanel } from './InputPanel';

export interface ItemReviewProps {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  multiInteraction: boolean;
}

/** One interaction's detail card — mirrors `render.ts`'s
 *  `renderItemReview`/`renderActions`: position, title, "previously
 *  answered" marker, scrollable subtitle+body markdown, then either the
 *  option list / freetext prompt or the open comment/freetext panel. */
export function ItemReview({ state, dispatch, scrollRef, multiInteraction }: ItemReviewProps) {
  const interaction = state.interactions[state.currentIndex]!;
  const response = state.responses.get(interaction.id);
  const preAnswered = state.preAnsweredIds.has(interaction.id);
  const opts = interaction.options;
  const multi = interaction.multiSelect === true;
  const checked = new Set(response?.selectedOptionIds ?? []);
  const commentRowIndex = opts.length;
  const commentRowFocused = state.selectedAction === commentRowIndex
    && interaction.allowFreetext === true && opts.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        {multiInteraction ? (
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'item-review/back' })}>
            ← Overview
          </Button>
        ) : <span />}
        {multiInteraction && (
          <span className="text-xs text-muted-foreground">
            {state.currentIndex + 1} / {state.interactions.length}
          </span>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold leading-snug">{interaction.title}</h2>
        {preAnswered && (
          <p className="mt-1 text-xs italic text-muted-foreground">
            ◆ {interaction.preAnswered?.label ?? 'Previously answered'} — n/p to review, or pick any option to override
          </p>
        )}
      </div>

      {(interaction.subtitle !== undefined || interaction.body !== undefined) && (
        <div ref={scrollRef} className="max-h-[45vh] overflow-y-auto rounded-md border border-border bg-card p-4">
          {interaction.subtitle !== undefined && <Markdown>{interaction.subtitle}</Markdown>}
          {interaction.body !== undefined && (
            <Markdown className={interaction.subtitle !== undefined ? 'mt-4' : undefined}>{interaction.body}</Markdown>
          )}
        </div>
      )}

      {state.inputMode !== null ? (
        <InputPanel
          mode={state.inputMode}
          interaction={interaction}
          onChange={(buffer) => dispatch({ type: 'input/update', buffer })}
          onSubmit={() => dispatch({ type: 'input/submit' })}
          onCancel={() => dispatch({ type: 'input/cancel' })}
          onCycleAttached={() => dispatch({ type: 'input/cycle-attached' })}
        />
      ) : (
        <div className="flex flex-col gap-1">
          {opts.map((option, i) => (
            <OptionRow
              key={option.id}
              option={option}
              index={i}
              multi={multi}
              focused={state.selectedAction === i}
              checked={multi ? checked.has(option.id) : response?.selectedOptionId === option.id}
              comment={multi ? response?.optionComments?.[option.id] : undefined}
              allowComment={interaction.allowFreetext === true}
              onPick={() => {
                if (multi) dispatch({ type: 'item-review/toggle-option', optionId: option.id, index: i });
                else dispatch({ type: 'item-review/pick-option', optionId: option.id, index: i });
              }}
              onOpenComment={() => {
                dispatch({ type: 'item-review/set-focus', index: i });
                dispatch({ type: 'item-review/open-comment', optionId: option.id });
              }}
            />
          ))}

          {interaction.allowFreetext === true && opts.length > 0 && (
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'item-review/set-focus', index: commentRowIndex });
                dispatch({ type: 'item-review/open-comment' });
              }}
              className={cn(
                'flex items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent',
                commentRowFocused && 'border-ring bg-accent/60',
              )}
            >
              <MessageSquarePlus className="size-4" />
              {multi ? 'Add overall comment (or comment on an option above)' : 'Add comment'}
            </button>
          )}

          {interaction.allowFreetext === true && opts.length === 0 && (
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => dispatch({ type: 'item-review/open-freetext' })}
            >
              {interaction.freetextLabel ?? 'Enter response'}
            </Button>
          )}

          {interaction.allowFreetext !== true && opts.length === 0 && (
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => dispatch({ type: 'item-review/step', delta: 1 })}
            >
              Continue
            </Button>
          )}

          {multi && (
            <Button
              className="mt-2 w-fit"
              disabled={checked.size === 0}
              onClick={() => dispatch({ type: 'item-review/enter-row' })}
            >
              Confirm selection ({checked.size})
            </Button>
          )}

          {state.hint !== undefined && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{state.hint}</p>
          )}

          {response !== undefined && (
            <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
              Current: {responseSummary(response, interaction)}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
        {multiInteraction && (
          <>
            <span><kbd className="rounded border border-border bg-muted px-1">n</kbd>/<kbd className="rounded border border-border bg-muted px-1">p</kbd> prev/next</span>
            <span><kbd className="rounded border border-border bg-muted px-1">q</kbd> overview</span>
          </>
        )}
        {multi
          ? <span><kbd className="rounded border border-border bg-muted px-1">space</kbd> toggle</span>
          : <span><kbd className="rounded border border-border bg-muted px-1">enter</kbd> pick</span>}
        <span><kbd className="rounded border border-border bg-muted px-1">u</kbd>/<kbd className="rounded border border-border bg-muted px-1">d</kbd> scroll</span>
        <span><kbd className="rounded border border-border bg-muted px-1">?</kbd> help</span>
      </div>
    </div>
  );
}
