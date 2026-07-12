import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationReadError, readConversationText, readPiConversationText } from '../conversation/reader.js';
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
writeFileSync(join(sessions, 'corrupt', 'unrelated.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'corrupt-session', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/corrupt' })}\n${JSON.stringify({ type: 'message', id: 'corrupt-user', parentId: null, timestamp: '2026-07-12T00:00:01.000Z', message: { role: 'user', content: 'usable context must not be used', timestamp: 1 } })}\n{not json}\n`);
mkdirSync(join(sessions, 'incomplete-tail'), { recursive: true });
writeFileSync(join(sessions, 'incomplete-tail', 'unrelated.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'incomplete-tail-session', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/tail' })}\n${JSON.stringify({ type: 'message', id: 'tail-user', parentId: null, timestamp: '2026-07-12T00:00:01.000Z', message: { role: 'user', content: 'complete context', timestamp: 1 } })}\n{"type":"message"`);
mkdirSync(join(sessions, 'malformed-tail'), { recursive: true });
writeFileSync(join(sessions, 'malformed-tail', 'unrelated.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'malformed-tail-session', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/malformed-tail' })}\n${JSON.stringify({ type: 'message', id: 'malformed-tail-user', parentId: null, timestamp: '2026-07-12T00:00:01.000Z', message: { role: 'user', content: 'usable context', timestamp: 1 } })}\ngarbage`);

const claudeDbPath = join(root, 'claude-store.db');
execFileSync('sqlite3', [claudeDbPath, `
  CREATE TABLE base_messages (uuid TEXT PRIMARY KEY, session_id TEXT, message_type TEXT, timestamp INTEGER);
  CREATE TABLE user_messages (uuid TEXT PRIMARY KEY, message TEXT);
  CREATE TABLE assistant_messages (uuid TEXT PRIMARY KEY, message TEXT);
  INSERT INTO base_messages VALUES ('claude-user', 'claude-session-exact-42', 'user', 1);
  INSERT INTO user_messages VALUES ('claude-user', 'Restore the legacy Claude visual path.');
  INSERT INTO base_messages VALUES ('claude-assistant', 'claude-session-exact-42', 'assistant', 2);
  INSERT INTO assistant_messages VALUES ('claude-assistant', 'I will resolve provider membership exactly.');
`]);

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
await assert.rejects(readPiConversationText('corrupt-session'), (error: unknown) => error instanceof ConversationReadError && error.code === 'session_unreadable');
assert.match(await readPiConversationText('incomplete-tail-session'), /user: complete context/);
await assert.rejects(readPiConversationText('malformed-tail-session'), (error: unknown) => error instanceof ConversationReadError && error.code === 'session_unreadable');

const claudeContext = await readConversationText('claude-session-exact-42', { claudeDbPath });
assert.match(claudeContext, /user: Restore the legacy Claude visual path\./);
assert.match(claudeContext, /assistant: I will resolve provider membership exactly\./);

let generated = false;
const unavailable = visualGeneratorForConversationSession('corrupt-session', async () => {
  generated = true;
  return { ok: true, ansi: 'should not render', markdown: 'should not render' };
});
const result = await unavailable({ id: 'ask', title: 'Ask', options: [] }, 80);
assert.deepEqual(result, { ok: false, error: 'visual context unavailable' });
assert.equal(generated, false, 'a malformed complete record never invokes the visual model, even with usable messages');

let claudeVisualContext = '';
const claudeVisual = visualGeneratorForConversationSession(
  'claude-session-exact-42',
  async (_interaction, context) => {
    claudeVisualContext = context;
    return { ok: true, ansi: 'claude visual', markdown: 'claude visual' };
  },
  (sessionId) => readConversationText(sessionId, { claudeDbPath }),
);
assert.deepEqual(await claudeVisual({ id: 'ask', title: 'Ask', options: [] }, 80), { ok: true, ansi: 'claude visual', markdown: 'claude visual' });
assert.match(claudeVisualContext, /Restore the legacy Claude visual path\./);

mkdirSync(join(sessions, 'cross-store'), { recursive: true });
writeFileSync(join(sessions, 'cross-store', 'unrelated.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'claude-session-exact-42', timestamp: '2026-07-12T00:00:00.000Z', cwd: '/cross-store' })}\n${JSON.stringify({ type: 'message', id: 'cross-store-user', parentId: null, timestamp: '2026-07-12T00:00:01.000Z', message: { role: 'user', content: 'ambiguous', timestamp: 1 } })}\n`);
await assert.rejects(readConversationText('claude-session-exact-42', { claudeDbPath }), (error: unknown) => error instanceof ConversationReadError && error.code === 'session_ambiguous');

rmSync(root, { recursive: true, force: true });
console.log('pi conversation reader tests passed');
