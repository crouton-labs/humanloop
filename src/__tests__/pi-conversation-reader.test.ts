import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationReadError, readPiConversationText } from '../conversation/reader.js';
import { visualGeneratorForConversationSession } from '../visuals/conversation.js';

const root = mkdtempSync(join(tmpdir(), 'humanloop-pi-reader-'));
process.env.PI_CODING_AGENT_DIR = root;
const sessions = join(root, 'sessions');
const fixture = new URL('./fixtures/pi-conversation.jsonl', import.meta.url);
const mainDir = join(sessions, 'arbitrary-project');
mkdirSync(mainDir, { recursive: true });
// The filename intentionally contains no session id: lookup must use the header.
cpSync(fixture, join(mainDir, 'totally-unrelated-name.jsonl'));

const duplicateHeader = JSON.stringify({ type: 'session', version: 3, id: 'duplicate-session', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/one' });
for (const dir of ['duplicate-one', 'duplicate-two']) {
  mkdirSync(join(sessions, dir), { recursive: true });
  writeFileSync(join(sessions, dir, 'unrelated.jsonl'), `${duplicateHeader}\n${JSON.stringify({ type: 'message', id: `${dir}-entry`, parentId: null, timestamp: '2026-07-12T00:00:01.000Z', message: { role: 'user', content: 'duplicate', timestamp: 1 } })}\n`);
}
mkdirSync(join(sessions, 'empty'), { recursive: true });
writeFileSync(join(sessions, 'empty', 'unrelated.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'empty-session', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/empty' })}\n`);
mkdirSync(join(sessions, 'corrupt'), { recursive: true });
writeFileSync(join(sessions, 'corrupt', 'unrelated.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'corrupt-session', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/corrupt' })}\n{not json}\n`);

const context = await readPiConversationText('pi-session-exact-42');
assert.match(context, /user: Investigate the inbox visual context\./);
assert.match(context, /user: Use the active branch instead\./);
assert.match(context, /assistant: I will inspect the ticket adapter\./);
assert.match(context, /tool call read: {"path":"src\/inbox\/deck-adapter.ts"}/);
assert.match(context, /tool result read: DeckAdapter mounts the panel\./);
assert.doesNotMatch(context, /abandoned branch|private reasoning|secret/);

await assert.rejects(readPiConversationText('unknown-session'), (error: unknown) => error instanceof ConversationReadError && error.code === 'session_not_found');
await assert.rejects(readPiConversationText('duplicate-session'), (error: unknown) => error instanceof ConversationReadError && error.code === 'session_ambiguous');
await assert.rejects(readPiConversationText('empty-session'), (error: unknown) => error instanceof ConversationReadError && error.code === 'conversation_empty');
await assert.rejects(readPiConversationText('corrupt-session'), (error: unknown) => error instanceof ConversationReadError && error.code === 'conversation_empty');

let generated = false;
const unavailable = visualGeneratorForConversationSession('unknown-for-visual', async () => {
  generated = true;
  return { ok: true, ansi: 'should not render', markdown: 'should not render' };
});
const result = await unavailable({ id: 'ask', title: 'Ask', options: [] }, 80);
assert.deepEqual(result, { ok: false, error: 'visual context unavailable' });
assert.equal(generated, false, 'reader failures never call the visual model with generic context');

rmSync(root, { recursive: true, force: true });
console.log('pi conversation reader tests passed');
