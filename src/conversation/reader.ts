import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FileEntry, SessionEntry, SessionInfo } from '@earendil-works/pi-coding-agent';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ConversationReadErrorCode = 'session_not_found' | 'session_ambiguous' | 'session_unreadable' | 'session_id_mismatch' | 'conversation_empty';

export class ConversationReadError extends Error {
  constructor(readonly code: ConversationReadErrorCode) {
    super(code);
    this.name = 'ConversationReadError';
  }
}

const CLAUDE_DB_PATH = join(homedir(), '.claude', '__store.db');
const MAX_SESSION_ID_LENGTH = 256;
const piSessionIndex = new Map<string, Map<string, string[]>>();

export interface ConversationReaderOptions {
  /** Claude SQLite path override for a real-store fixture; production uses Claude's standard store. */
  claudeDbPath?: string;
}

/** Read messages from Claude's local conversation store. */
export function readConversation(sessionId: string, options: ConversationReaderOptions = {}): ConversationMessage[] {
  const claudeDbPath = options.claudeDbPath ?? CLAUDE_DB_PATH;
  if (!existsSync(claudeDbPath)) throw new Error('Claude conversation store unavailable');

  const query = `
    SELECT bm.message_type,
           COALESCE(um.message, am.message) AS content
    FROM base_messages bm
    LEFT JOIN user_messages um ON bm.uuid = um.uuid
    LEFT JOIN assistant_messages am ON bm.uuid = am.uuid
    WHERE bm.session_id = '${escapeSqlString(sessionId)}'
    ORDER BY bm.timestamp ASC;
  `;

  const raw = runSqlite(claudeDbPath, query);
  if (!raw.trim()) return [];
  const rows = JSON.parse(raw) as Array<{ message_type: string; content: string | null }>;
  return rows.flatMap((row) => row.content && (row.message_type === 'user' || row.message_type === 'assistant')
    ? [{ role: row.message_type, content: row.content }]
    : []);
}

/** Resolve a pi session by exact header id and return its active useful context. */
export async function readPiConversationText(sessionId: string): Promise<string> {
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) throw new ConversationReadError('session_not_found');

  const pi = await import('@earendil-works/pi-coding-agent').catch(() => {
    throw new ConversationReadError('session_unreadable');
  });
  const paths = await resolvePiSessionPaths(pi.SessionManager, sessionId);
  if (paths.length === 0) throw new ConversationReadError('session_not_found');
  if (paths.length !== 1) throw new ConversationReadError('session_ambiguous');

  let entries: FileEntry[];
  try {
    // parseSessionEntries is the package-root parser. Reading only the SDK-discovered
    // path keeps an untrusted deck id from becoming a filesystem locator.
    const raw = readFileSync(paths[0]!, 'utf8');
    rejectMalformedCompleteJsonlRecords(raw);
    entries = pi.parseSessionEntries(raw);
  } catch {
    throw new ConversationReadError('session_unreadable');
  }

  const header = entries[0];
  if (!isMatchingHeader(header, sessionId)) throw new ConversationReadError('session_id_mismatch');
  if (entries.length < 2) throw new ConversationReadError('conversation_empty');

  try {
    pi.migrateSessionEntries(entries);
    const sessionEntries = entries.slice(1).filter((entry): entry is SessionEntry => entry.type !== 'session');
    const context = pi.buildSessionContext(sessionEntries);
    const text = context.messages.map(serializePiMessage).filter((part): part is string => part !== '').join('\n\n').trim();
    if (text === '') throw new ConversationReadError('conversation_empty');
    return text;
  } catch (error) {
    if (error instanceof ConversationReadError) throw error;
    throw new ConversationReadError('session_unreadable');
  }
}

async function resolvePiSessionPaths(SessionManager: typeof import('@earendil-works/pi-coding-agent').SessionManager, sessionId: string): Promise<string[]> {
  const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  let index = piSessionIndex.get(root);
  if (index === undefined) {
    index = await buildPiSessionIndex(SessionManager);
    piSessionIndex.set(root, index);
  }
  let paths = index.get(sessionId) ?? [];
  // A popup can outlive session creation. Refresh once on a miss, then keep the
  // process-local cache for subsequent visuals instead of rescanning every transcript.
  if (paths.length === 0) {
    index = await buildPiSessionIndex(SessionManager);
    piSessionIndex.set(root, index);
    paths = index.get(sessionId) ?? [];
  }
  return paths;
}

async function buildPiSessionIndex(SessionManager: typeof import('@earendil-works/pi-coding-agent').SessionManager): Promise<Map<string, string[]>> {
  let sessions: SessionInfo[];
  try {
    sessions = await SessionManager.listAll();
  } catch {
    throw new ConversationReadError('session_unreadable');
  }
  const index = new Map<string, string[]>();
  for (const session of sessions) {
    const paths = index.get(session.id);
    if (paths === undefined) index.set(session.id, [session.path]);
    else paths.push(session.path);
  }
  return index;
}

/** Resolve by exact membership across provider stores, never by session-id shape. */
export async function readConversationText(sessionId: string, options: ConversationReaderOptions = {}): Promise<string> {
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) throw new ConversationReadError('session_not_found');

  const claudeDbPath = options.claudeDbPath ?? CLAUDE_DB_PATH;
  const pi = await import('@earendil-works/pi-coding-agent').catch(() => {
    throw new ConversationReadError('session_unreadable');
  });
  const piPaths = await resolvePiSessionPaths(pi.SessionManager, sessionId);
  const claudeMatches = findClaudeSessionMembership(sessionId, claudeDbPath);
  const matches = (piPaths.length === 1 ? 1 : 0) + (claudeMatches ? 1 : 0);

  if (piPaths.length > 1 || matches > 1) throw new ConversationReadError('session_ambiguous');
  if (matches === 0) throw new ConversationReadError('session_not_found');
  if (claudeMatches) {
    try {
      const text = readConversation(sessionId, { claudeDbPath }).map((message) => `${message.role}: ${message.content}`).join('\n\n').trim();
      if (text === '') throw new ConversationReadError('conversation_empty');
      return text;
    } catch (error) {
      if (error instanceof ConversationReadError) throw error;
      throw new ConversationReadError('session_unreadable');
    }
  }
  return readPiConversationText(sessionId);
}

function findClaudeSessionMembership(sessionId: string, claudeDbPath: string): boolean {
  if (!existsSync(claudeDbPath)) return false;
  try {
    return runSqlite(claudeDbPath, `SELECT 1 AS found FROM base_messages WHERE session_id = '${escapeSqlString(sessionId)}' LIMIT 1;`).trim() !== '';
  } catch {
    throw new ConversationReadError('session_unreadable');
  }
}

function runSqlite(dbPath: string, query: string): string {
  return execFileSync('sqlite3', ['-json', dbPath, query], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

function escapeSqlString(value: string): string { return value.replace(/'/g, "''"); }

/** Reject corrupt records while allowing only an unterminated JSON-object prefix being concurrently written. */
function rejectMalformedCompleteJsonlRecords(raw: string): void {
  const lines = raw.split('\n');
  for (const line of lines.slice(0, -1)) {
    if (line.trim() === '') continue;
    JSON.parse(line);
  }
  const tail = lines.at(-1)!;
  if (!raw.endsWith('\n') && tail !== '' && !isIncompleteJsonObjectPrefix(tail)) JSON.parse(tail);
}

function isIncompleteJsonObjectPrefix(source: string): boolean {
  let offset = 0;
  type Result = 'complete' | 'incomplete' | 'malformed';
  const whitespace = () => { while (/\s/.test(source[offset] ?? '')) offset += 1; };
  const string = (): Result => {
    if (source[offset++] !== '"') return 'malformed';
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return 'complete';
      if (character < ' ') return 'malformed';
      if (character === '\\') {
        if (offset === source.length) return 'incomplete';
        const escape = source[offset++]!;
        if (!'"\\/bfnrtu'.includes(escape)) return 'malformed';
        if (escape === 'u') {
          for (let count = 0; count < 4; count += 1) {
            if (offset === source.length) return 'incomplete';
            if (!/[0-9a-f]/i.test(source[offset++]!)) return 'malformed';
          }
        }
      }
    }
    return 'incomplete';
  };
  const value = (): Result => {
    whitespace();
    const character = source[offset];
    if (character === undefined) return 'incomplete';
    if (character === '"') return string();
    if (character === '{') return object();
    if (character === '[') return array();
    for (const literal of ['true', 'false', 'null']) {
      if (source.slice(offset, offset + literal.length) === literal) { offset += literal.length; return 'complete'; }
      if (literal.startsWith(source.slice(offset))) return 'incomplete';
    }
    if (character === '-' || /[0-9]/.test(character)) {
      const match = source.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match === null) return character === '-' ? 'incomplete' : 'malformed';
      offset += match[0].length;
      return 'complete';
    }
    return 'malformed';
  };
  const object = (): Result => {
    offset += 1;
    whitespace();
    if (source[offset] === '}') { offset += 1; return 'complete'; }
    while (true) {
      if (offset === source.length) return 'incomplete';
      const key = string();
      if (key !== 'complete') return key;
      whitespace();
      if (offset === source.length) return 'incomplete';
      if (source[offset++] !== ':') return 'malformed';
      const item = value();
      if (item !== 'complete') return item;
      whitespace();
      if (offset === source.length) return 'incomplete';
      const separator = source[offset++]!;
      if (separator === '}') return 'complete';
      if (separator !== ',') return 'malformed';
      whitespace();
    }
  };
  const array = (): Result => {
    offset += 1;
    whitespace();
    if (source[offset] === ']') { offset += 1; return 'complete'; }
    while (true) {
      const item = value();
      if (item !== 'complete') return item;
      whitespace();
      if (offset === source.length) return 'incomplete';
      const separator = source[offset++]!;
      if (separator === ']') return 'complete';
      if (separator !== ',') return 'malformed';
      whitespace();
    }
  };
  const result = value();
  whitespace();
  return result === 'incomplete' && offset === source.length && source.trimStart().startsWith('{');
}

function isMatchingHeader(entry: FileEntry | undefined, sessionId: string): boolean {
  return entry?.type === 'session' && entry.id === sessionId;
}

function serializePiMessage(message: { role?: unknown; content?: unknown; summary?: unknown; toolName?: unknown }): string {
  switch (message.role) {
    case 'user': return labeledText('user', message.content);
    case 'assistant': {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks.flatMap((block) => {
        if (!isRecord(block)) return [];
        if (block.type === 'text' && typeof block.text === 'string') return [block.text];
        if (block.type === 'toolCall' && typeof block.name === 'string') return [`tool call ${block.name}: ${safeJson(block.arguments)}`];
        return [];
      }).filter((part) => part.trim() !== '');
      return text.length === 0 ? '' : `assistant: ${text.join('\n')}`;
    }
    case 'toolResult': return labeledText(`tool result${typeof message.toolName === 'string' ? ` ${message.toolName}` : ''}`, message.content);
    case 'compactionSummary': return typeof message.summary === 'string' && message.summary.trim() !== '' ? `compaction summary: ${message.summary}` : '';
    case 'branchSummary': return typeof message.summary === 'string' && message.summary.trim() !== '' ? `branch summary: ${message.summary}` : '';
    default: return '';
  }
}

function labeledText(label: string, content: unknown): string {
  const text = textFromContent(content);
  return text === '' ? '' : `${label}: ${text}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim();
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return '[unserializable arguments]'; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

export function findRecentSessionId(cwd?: string): string | null {
  if (!existsSync(CLAUDE_DB_PATH)) return null;
  const whereClause = cwd ? `WHERE cwd = '${cwd.replace(/'/g, "''")}'` : '';
  const query = `SELECT DISTINCT session_id FROM base_messages ${whereClause} ORDER BY timestamp DESC LIMIT 1;`;
  try {
    const raw = execSync(`sqlite3 -json "${CLAUDE_DB_PATH}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
    if (!raw.trim()) return null;
    return (JSON.parse(raw) as Array<{ session_id: string }>)[0]?.session_id ?? null;
  } catch {
    return null;
  }
}
