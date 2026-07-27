import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { formatReviewMarkdown } from './accessory-format.js';
import { accessoryDraftPath, clearAccessoryDraft, readAccessoryDraft } from './accessory-draft.js';
import { runTerminalReviewSession } from './terminal-review.js';
import { checkReviewableFile } from './visible-paths.js';
import type { AccessoryOutcome } from './accessory-outcome.js';

export type { AccessoryOutcome } from './accessory-outcome.js';

export interface AccessoryReviewOptions {
  /** Resolved absolute path of the file under review. */
  file: string;
  /** Surface cwd — relativizes the header path and resolves typed relative paths. */
  cwd: string;
  /** True when this review was opened from inside another review. */
  nested?: boolean;
}

export async function reviewFileAsAccessory(opts: AccessoryReviewOptions): Promise<AccessoryOutcome> {
  const abs = resolve(opts.file);
  const check = checkReviewableFile(abs);
  if (!check.ok) throw new Error(check.reason);

  const outPath = accessoryDraftPath(abs);
  readAccessoryDraft(abs);
  const content = readFileSync(abs, 'utf8');
  const outcome = await runTerminalReviewSession(
    abs,
    content,
    outPath,
    basename(abs),
    { output: outPath },
    { doc: 'plain', keys: 'accessory', nested: opts.nested === true },
  );

  if (outcome.type !== 'accessory') return { kind: 'cancel' };
  const text = formatReviewMarkdown(abs, opts.cwd, outcome.comments, content.split('\n').length);
  if (text === '') return { kind: 'cancel' };

  clearAccessoryDraft(abs);
  return { kind: outcome.disposition, text };
}
