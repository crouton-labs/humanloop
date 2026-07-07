import { Button } from '@/components/ui/button';
import type { FeedbackComment } from '@/types';
import { cn } from '@/lib/utils';
import { reviewRangeLabel } from '@/lib/sourceMap';

export function CommentList({
  comments,
  activeIndex,
  readOnly,
  onEdit,
  onDelete,
  onClose,
}: {
  comments: FeedbackComment[];
  activeIndex: number;
  readOnly: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="rounded-lg border bg-card p-4" aria-label="Review comments">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Comments ({comments.length})</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {comments.map((comment, index) => {
            const range = reviewRangeLabel(comment);
            return (
              <li
                key={comment.id}
                className={cn(
                  'rounded-md border p-3 text-sm',
                  index === activeIndex ? 'border-ring bg-accent/60' : 'bg-background',
                )}
              >
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs text-muted-foreground">{range}</div>
                    <p className="whitespace-pre-wrap">{comment.comment}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEdit(comment.id)}
                      disabled={readOnly}
                      aria-label={`Edit comment on ${range}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(comment.id)}
                      disabled={readOnly}
                      aria-label={`Delete comment on ${range}`}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {comment.quote !== undefined && (
                  <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs text-muted-foreground">{comment.quote}</pre>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-3 text-xs text-muted-foreground">In the list: j/k move, e/enter edit, dd delete, q close.</p>
    </aside>
  );
}
