import { MessageSquarePlus } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { InteractionOption } from '@/types';

export interface OptionRowProps {
  option: InteractionOption;
  index: number;
  multi: boolean;
  focused: boolean;
  checked: boolean;
  comment?: string;
  allowComment: boolean;
  onPick: () => void;
  onOpenComment: () => void;
}

/** One option row — single-select radio-like pick, or multi-select checkbox
 *  toggle. Click anywhere on the row picks/toggles it (mouse parity with the
 *  keyboard shortcut letter); the comment affordance is its own click target
 *  so it doesn't also toggle the option. Mirrors `render.ts`'s
 *  `renderActions` (cursor `▸`, `[x]`/`[ ]` box, `[shortcut]` badge,
 *  description line, per-option comment note). */
export function OptionRow({
  option, index: _index, multi, focused, checked, comment, allowComment, onPick, onOpenComment,
}: OptionRowProps) {
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onPick}
      className={cn(
        'group flex cursor-pointer items-start gap-3 rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-accent',
        focused && 'border-ring bg-accent/60',
      )}
    >
      {multi && (
        <Checkbox checked={checked} className="mt-0.5" tabIndex={-1} onClick={(e) => e.stopPropagation()} onCheckedChange={onPick} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {option.shortcut !== undefined && (
            <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              {option.shortcut}
            </kbd>
          )}
          <span className={cn('text-sm', (checked || (!multi && checked)) && 'font-medium')}>{option.label}</span>
        </div>
        {option.description !== undefined && option.description.length > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">{option.description}</p>
        )}
        {comment !== undefined && comment.length > 0 && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">✎ {comment}</p>
        )}
      </div>
      {allowComment && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 opacity-0 group-hover:opacity-100"
          title="Comment on this option (c)"
          onClick={(e) => {
            e.stopPropagation();
            onOpenComment();
          }}
        >
          <MessageSquarePlus className="size-4" />
        </Button>
      )}
    </div>
  );
}
