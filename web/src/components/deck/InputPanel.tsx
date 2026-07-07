import { useEffect, useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { Interaction } from '@/types';
import type { InputMode } from '@/lib/deckState';

export interface InputPanelProps {
  mode: Extract<InputMode, { kind: 'comment' | 'freetext' }>;
  interaction: Interaction;
  onChange: (buffer: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onCycleAttached: () => void;
}

/** Comment / freetext entry — a real `<textarea>`, so cursor motion, word
 *  jump, undo, and IME composition are all native browser behavior instead
 *  of the terminal's hand-rolled buffer editing (see `useDeckKeymap.ts`'s
 *  header for why that's an intentional narrowing, not an oversight). Enter
 *  submits, Shift+Enter inserts a newline, Escape cancels, Tab cycles the
 *  attached option — those three are intercepted by `useDeckKeymap`; typing
 *  itself flows through `onChange` untouched. */
export function InputPanel({ mode, interaction, onChange, onSubmit, onCancel, onCycleAttached }: InputPanelProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const label = interaction.freetextLabel ?? (mode.kind === 'comment' ? 'Comment' : 'Response');
  const attached = mode.kind === 'comment' && mode.selectedOptionId !== undefined
    ? interaction.options.find((o) => o.id === mode.selectedOptionId)
    : undefined;

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {mode.kind === 'comment' && interaction.options.length > 0 && (
          <button
            type="button"
            onClick={onCycleAttached}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            title="Tab cycles the attached option"
          >
            attached: {attached !== undefined ? attached.label : 'none (overall)'}
          </button>
        )}
      </div>
      <Textarea
        ref={ref}
        value={mode.buffer}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type your response…"
        rows={4}
        className="resize-y"
      />
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          <kbd className="rounded border border-border bg-muted px-1">enter</kbd> submit ·{' '}
          <kbd className="rounded border border-border bg-muted px-1">shift+enter</kbd> newline ·{' '}
          <kbd className="rounded border border-border bg-muted px-1">esc</kbd> cancel
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={onSubmit}>Submit</Button>
        </div>
      </div>
    </div>
  );
}
