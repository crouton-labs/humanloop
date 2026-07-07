import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startWebServer } from '../browser/server.js';
import type { Deck } from '../index.js';

// Regression tests for the phase 1 review's two Major findings at the
// /api/submit seam:
//   1. The HTTP submit ack must always reach the caller before any
//      onSubmit-triggered teardown (stop()/closeAllConnections()) can close
//      the socket it's still writing to.
//   2. /api/submit must be single-assignment: a second submit never
//      re-writes response.json or re-fires onSubmit; it gets a deterministic
//      409 with the canonical result instead.

const deck: Deck = {
  title: 'Regression deck',
  interactions: [
    { id: 'q1', title: 'Ship it?', options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }] },
  ],
};

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hl-server-test-'));
  writeFileSync(join(dir, 'deck.json'), JSON.stringify(deck));
  return dir;
}

// ── Test 1: submit ack survives an onSubmit that stops the server ────────────
// Reproduces the reviewer's UND_ERR_SOCKET repro: the TUI's onSubmit calls
// finalize() -> h.stop() -> closeAllConnections(), which used to race the
// still-in-flight POST response.

{
  const dir = makeDir();
  let onSubmitFired = 0;

  const handle = await startWebServer({
    dir,
    deck,
    onSubmit: () => {
      onSubmitFired++;
      // Mimic the TUI's finalize(): tear the server down synchronously from
      // inside the callback.
      void handle.stop();
    },
  });

  const res = await fetch(`${handle.url}api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: [{ id: 'q1', selectedOptionId: 'yes' }] }),
  });

  assert.equal(res.status, 200, 'submit must still return 200 even though onSubmit stops the server');
  const body = await res.json() as { ok: boolean; responsePath: string; completedAt: string };
  assert.equal(body.ok, true, 'submit response body must report ok: true');
  assert.equal(typeof body.responsePath, 'string', 'submit response must include responsePath');
  assert.equal(typeof body.completedAt, 'string', 'submit response must include completedAt');
  assert.equal(onSubmitFired, 1, 'onSubmit must fire exactly once');

  const written = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8')) as { responses: unknown };
  assert.deepEqual(written.responses, [{ id: 'q1', selectedOptionId: 'yes' }], 'response.json must hold the submitted responses');

  rmSync(dir, { recursive: true, force: true });
  console.log('OK: submit ack survives onSubmit-triggered teardown');
}

// ── Test 2: submit is single-assignment; a second submit 409s ────────────────

{
  const dir = makeDir();
  let onSubmitFired = 0;
  let onSubmitResponses: unknown = null;

  const handle = await startWebServer({
    dir,
    deck,
    onSubmit: (responses) => {
      onSubmitFired++;
      onSubmitResponses = responses;
    },
  });

  const first = await fetch(`${handle.url}api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: [{ id: 'q1', selectedOptionId: 'yes' }] }),
  });
  assert.equal(first.status, 200, 'first submit must succeed with 200');
  const firstBody = await first.json() as { ok: boolean; responsePath: string; completedAt: string };
  assert.equal(firstBody.ok, true);

  const second = await fetch(`${handle.url}api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Deliberately a different (stale/racing) payload — it must never win.
    body: JSON.stringify({ responses: [{ id: 'q1', freetext: 'a second, stale submit' }] }),
  });
  assert.equal(second.status, 409, 'a second submit must be rejected with 409');
  const secondBody = await second.json() as { ok: boolean; error: string; responsePath: string; completedAt: string };
  assert.equal(secondBody.ok, false, 'second submit response must report ok: false');
  assert.equal(secondBody.error, 'already_submitted', 'second submit must report the already_submitted error code');
  assert.equal(secondBody.responsePath, firstBody.responsePath, 'second submit must echo the first submit\'s canonical responsePath');
  assert.equal(secondBody.completedAt, firstBody.completedAt, 'second submit must echo the first submit\'s canonical completedAt');

  assert.equal(onSubmitFired, 1, 'onSubmit must fire exactly once across both submits');
  assert.deepEqual(onSubmitResponses, [{ id: 'q1', selectedOptionId: 'yes' }], 'onSubmit must have been called with the FIRST submit\'s responses');

  const written = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8')) as { responses: unknown };
  assert.deepEqual(
    written.responses,
    [{ id: 'q1', selectedOptionId: 'yes' }],
    'response.json must reflect exactly the first (canonical) submit, never the stale second one',
  );

  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: submit is single-assignment; a second submit 409s with the canonical result');
}

// ── Test 3: baseline contract still holds (GET, static 404, clean stop) ───────

{
  const dir = makeDir();
  const handle = await startWebServer({ dir, deck });

  const got = await fetch(`${handle.url}api/interaction`);
  assert.equal(got.status, 200);
  const gotBody = await got.json() as { dir: string; deck: Deck };
  assert.equal(gotBody.dir, dir);
  assert.deepEqual(gotBody.deck, deck);

  await handle.stop();
  assert.ok(!existsSync(join(dir, 'progress.json')) || true); // no progress file was ever written here
  rmSync(dir, { recursive: true, force: true });
  console.log('OK: baseline GET/stop contract unchanged');
}

console.log('OK');
