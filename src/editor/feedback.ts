import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FeedbackComment, FeedbackResult } from '../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeFeedbackComments(raw: unknown): FeedbackComment[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackComment[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const comment = typeof r.comment === 'string' ? r.comment.trim() : '';
    if (!comment) continue;
    const line = Number(r.line) || 1;
    const endLine = Number(r.endLine) || line;
    const colStart = Number.isInteger(r.colStart) ? (r.colStart as number) : undefined;
    const colEnd = Number.isInteger(r.colEnd) ? (r.colEnd as number) : undefined;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `c${out.length}`,
      line,
      endLine,
      colStart: colStart !== undefined && colEnd !== undefined && colEnd > colStart ? colStart : undefined,
      colEnd: colStart !== undefined && colEnd !== undefined && colEnd > colStart ? colEnd : undefined,
      quote: typeof r.quote === 'string' && r.quote ? r.quote : undefined,
      lineText: typeof r.lineText === 'string' ? r.lineText : '',
      comment,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowIso(),
    });
  }
  return out;
}

export function parseFeedbackComments(raw: unknown): { ok: true; comments: FeedbackComment[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'comments must be an array.' };
  }
  for (const item of raw) {
    if (!isRecord(item)) {
      return { ok: false, message: 'comments must contain objects.' };
    }
    if (typeof item.comment !== 'string') {
      return { ok: false, message: 'each comment must include a string comment.' };
    }
  }
  return { ok: true, comments: sanitizeFeedbackComments(raw) };
}

export function buildDraftFeedbackResult(file: string, comments: FeedbackComment[], savedAt = nowIso()): FeedbackResult {
  return {
    file: resolve(file),
    submitted: false,
    approved: false,
    comments: sanitizeFeedbackComments(comments),
    savedAt,
  };
}

export function buildFinalFeedbackResult(
  file: string,
  comments: FeedbackComment[],
  timestamp = nowIso(),
): FeedbackResult {
  const sanitized = sanitizeFeedbackComments(comments);
  return {
    file: resolve(file),
    submitted: true,
    approved: sanitized.length === 0,
    comments: sanitized,
    submittedAt: timestamp,
    savedAt: timestamp,
  };
}

export function readStoredFeedbackResult(path: string, expectedFile?: string): FeedbackResult | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.file !== 'string') return null;
  if (expectedFile !== undefined && raw.file !== expectedFile) return null;
  const comments = sanitizeFeedbackComments(raw.comments);
  if (raw.submitted === true) {
    const submittedAt = typeof raw.submittedAt === 'string' ? raw.submittedAt : nowIso();
    const savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : submittedAt;
    return {
      file: raw.file,
      submitted: true,
      approved: comments.length === 0,
      comments,
      submittedAt,
      savedAt,
    };
  }
  const savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : nowIso();
  return {
    file: raw.file,
    submitted: false,
    approved: false,
    comments,
    savedAt,
  };
}

export function readStoredDraftFeedbackResult(path: string, expectedFile: string): FeedbackResult | null {
  const result = readStoredFeedbackResult(path, resolve(expectedFile));
  return result !== null && !result.submitted ? result : null;
}

export function serializeFeedbackResult(result: FeedbackResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}

export function writeFeedbackResult(path: string, result: FeedbackResult): string {
  const payload = serializeFeedbackResult(result);
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
  return path;
}

export function writeDraftFeedbackResult(
  path: string,
  file: string,
  comments: FeedbackComment[],
  savedAt = nowIso(),
): FeedbackResult {
  const result = buildDraftFeedbackResult(file, comments, savedAt);
  writeFeedbackResult(path, result);
  return result;
}

export function writeFinalFeedbackResult(
  path: string,
  file: string,
  comments: FeedbackComment[],
  timestamp = nowIso(),
): FeedbackResult {
  const result = buildFinalFeedbackResult(file, comments, timestamp);
  writeFeedbackResult(path, result);
  return result;
}

export function writeSubmitFlag(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}
