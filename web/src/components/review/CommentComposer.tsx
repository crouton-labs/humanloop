import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ComposerState } from '@/lib/reviewState';
import { reviewRangeLabel } from '@/lib/sourceMap';

export function CommentComposer({
  composer,
  onChange,
  onSubmit,
  onCancel,
}: {
  composer: ComposerState;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const label = composer.mode === 'edit' ? 'Edit comment' : 'Add comment';
  const rangeLabel = reviewRangeLabel({
    id: 'anchor',
    line: composer.anchor.line,
    endLine: composer.anchor.endLine,
    colStart: composer.anchor.colStart,
    colEnd: composer.anchor.colEnd,
    lineText: composer.anchor.lineText,
    comment: '',
    createdAt: '',
  });

  return (
    <section className="rounded-lg border border-ring bg-card p-4 shadow-sm" aria-label={`${label} on ${rangeLabel}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="text-xs text-muted-foreground">{rangeLabel}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label={`Cancel comment on ${rangeLabel}`}>Cancel</Button>
      </div>
      {composer.anchor.quote !== undefined && (
        <blockquote className="mb-2 max-h-24 overflow-auto rounded-md border-l-4 border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {composer.anchor.quote}
        </blockquote>
      )}
      <Textarea
        ref={ref}
        value={composer.buffer}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        placeholder="What should change?"
        aria-label={`${label} text for ${rangeLabel}`}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span><kbd className="rounded border border-border bg-muted px-1">enter</kbd> save · <kbd className="rounded border border-border bg-muted px-1">shift+enter</kbd> newline · <kbd className="rounded border border-border bg-muted px-1">esc</kbd> cancel</span>
        <Button size="sm" onClick={onSubmit} aria-label={`${composer.mode === 'edit' ? 'Save' : 'Add'} comment on ${rangeLabel}`}>{composer.mode === 'edit' ? 'Save comment' : 'Add comment'}</Button>
      </div>
    </section>
  );
}
