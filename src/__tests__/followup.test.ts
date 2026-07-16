import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followupResultPath } from '../inbox/convention.js';
import { cancelFollowUp, readFollowUp, requestFollowUp, submitFollowUpResult } from '../inbox/followup.js';
import { registerInboxRoot } from '../inbox/registry.js';
import { submitDeck } from '../inbox/tickets.js';
import type { Deck } from '../types.js';

const temp = mkdtempSync(join(tmpdir(), 'humanloop-followup-'));
try {
  process.env.XDG_STATE_HOME = join(temp, 'state');
  const root = join(temp, 'tickets');
  const handler = join(temp, 'handler.cjs');
  writeFileSync(handler, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  registerInboxRoot({ root, owner: 'test-owner', followUpHandler: { command: process.execPath, args: [handler] } });
  const deck: Deck = { title: 'Follow-up race', interactions: [{ id: 'answer', title: 'Answer?', options: [{ id: 'yes', label: 'Yes' }] }] };
  const { dir } = submitDeck({ root, id: 'race', deck });
  const rootAlias = join(temp, 'tickets-alias');
  symlinkSync(root, rootAlias, 'dir');
  const aliasedDir = join(rootAlias, 'race');

  const unrelated = join(temp, 'unrelated');
  mkdirSync(unrelated);
  assert.throws(() => requestFollowUp(root, unrelated, { question: 'not a ticket' }), /canonical direct child/);
  assert.throws(() => cancelFollowUp(root, unrelated), /canonical direct child/);

  const first = requestFollowUp(rootAlias, aliasedDir, { question: 'q1' });
  const second = requestFollowUp(root, dir, { question: 'q2' });

  assert.deepEqual(
    submitFollowUpResult(root, dir, { requestId: first.requestId, status: 'ready', markdown: 'stale' }),
    { published: false },
    'a superseded writer cannot publish a stale answer',
  );
  assert.equal(existsSync(followupResultPath(dir)), false, 'the stale answer creates no result file');

  assert.deepEqual(
    submitFollowUpResult(root, dir, { requestId: second.requestId, status: 'ready', markdown: '# answer' }),
    { published: true },
    'the current writer publishes successfully',
  );
  const current = readFollowUp(dir);
  assert.equal(current.result?.requestId, second.requestId);
  assert.equal(current.result?.markdown, '# answer');
  assert.equal(current.request?.state, 'terminal');

  const empty = requestFollowUp(root, dir, { question: 'q3' });
  assert.deepEqual(
    submitFollowUpResult(rootAlias, aliasedDir, { requestId: empty.requestId, status: 'ready', markdown: '  \n' }),
    { published: true },
  );
  const downgraded = readFollowUp(dir);
  assert.equal(downgraded.result?.status, 'error');
  assert.match(downgraded.result?.error ?? '', /non-empty markdown/);
  assert.equal(downgraded.request?.state, 'terminal');
  await new Promise((resolve) => setTimeout(resolve, 100));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('follow-up tests passed');
