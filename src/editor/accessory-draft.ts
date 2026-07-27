import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readReviewDraft, type ReviewDraft } from './feedback.js';

const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stateHome(): string {
  return process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
}

export function accessoryDraftPath(absFile: string): string {
  const key = createHash('sha256').update(absFile).digest('hex');
  return join(stateHome(), 'humanloop', 'accessory-reviews', `${key}.json`);
}

export function readAccessoryDraft(absFile: string): ReviewDraft | null {
  const path = accessoryDraftPath(absFile);
  const draft = readReviewDraft(path);
  if (draft !== null && Date.now() - Date.parse(draft.savedAt) > MAX_DRAFT_AGE_MS) {
    try { unlinkSync(path); } catch { /* best-effort stale-draft cleanup */ }
    return null;
  }
  return draft;
}

export function clearAccessoryDraft(absFile: string): void {
  try { unlinkSync(accessoryDraftPath(absFile)); } catch { /* already absent or not removable */ }
}
