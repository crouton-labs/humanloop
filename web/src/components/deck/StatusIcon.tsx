import { Check, Circle, Diamond } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AnswerStatus = 'answered' | 'pre-answered' | 'unanswered';

/** Small answered/pre-answered/unanswered glyph — mirrors the terminal's
 *  ✓ / ◆ / ○ overview + summary icons (`render.ts`'s `renderOverview` /
 *  `renderFinal`). */
export function StatusIcon({ status, className }: { status: AnswerStatus; className?: string }) {
  if (status === 'answered') {
    return <Check className={cn('size-4 text-emerald-600 dark:text-emerald-400', className)} />;
  }
  if (status === 'pre-answered') {
    return <Diamond className={cn('size-3.5 fill-muted-foreground/40 text-muted-foreground', className)} />;
  }
  return <Circle className={cn('size-3.5 text-muted-foreground/50', className)} />;
}
