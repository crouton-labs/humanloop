import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FeedbackComment, FeedbackResult } from '../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Column validity is only meaningful WITHIN a single line: `colEnd > colStart`
// compares two byte offsets into the SAME line. For a multi-line range,
// `colStart` is relative to the START line and `colEnd` is relative to the
// (different) END line, so a numeric `colEnd > colStart` comparison is
// meaningless and can reject a perfectly valid range (e.g. a short last line
// legitimately has a smaller colEnd than the start line's colStart). Mirrors
// web/src/lib/sourceMap.ts's `hasValidRangeColumns` — src/ can't import from
// web/, so this is the local equivalent.
function hasValidRangeColumns(line: number, endLine: number, colStart?: number, colEnd?: number): boolean {
  if (colStart === undefined || colEnd === undefined) return false;
  if (line === endLine) return colEnd > colStart;
  return true;
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
    const validCols = hasValidRangeColumns(line, endLine, colStart, colEnd);
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `c${out.length}`,
      line,
      endLine,
      colStart: validCols ? colStart : undefined,
      colEnd: validCols ? colEnd : undefined,
      quote: typeof r.quote === 'string' && r.quote ? r.quote : undefined,
      lineText: typeof r.lineText === 'string' ? r.lineText : '',
      comment,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowIso(),
    });
  }
  return out;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// Strict, per-item validator for the browser-write API (PUT /api/review/draft,
// POST /api/review/submit) — malformed anchors are rejected with a 400
// instead of being silently normalized/dropped. `sanitizeFeedbackComments`
// stays the separate, deliberately permissive path for loading legacy on-disk
// drafts (readStoredFeedbackResult/readStoredDraftFeedbackResult), which must
// keep tolerating old/hand-edited files.
export function parseFeedbackComments(raw: unknown): { ok: true; comments: FeedbackComment[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'comments must be an array.' };
  }
  const comments: FeedbackComment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) return { ok: false, message: `comments[${i}] must be an object.` };
    const { id, comment, line, endLine, lineText, createdAt, colStart, colEnd, quote } = item;
    if (!isNonEmptyString(id)) return { ok: false, message: `comments[${i}].id must be a non-empty string.` };
    if (!isNonEmptyString(comment)) return { ok: false, message: `comments[${i}].comment must be a non-empty string.` };
    if (!isPositiveInteger(line)) return { ok: false, message: `comments[${i}].line must be a positive integer.` };
    if (!isPositiveInteger(endLine)) return { ok: false, message: `comments[${i}].endLine must be a positive integer.` };
    if (endLine < line) return { ok: false, message: `comments[${i}].endLine must be >= line.` };
    if (typeof lineText !== 'string') return { ok: false, message: `comments[${i}].lineText must be a string.` };
    if (!isNonEmptyString(createdAt)) return { ok: false, message: `comments[${i}].createdAt must be a non-empty string.` };
    const hasColStart = colStart !== undefined;
    const hasColEnd = colEnd !== undefined;
    if (hasColStart !== hasColEnd) return { ok: false, message: `comments[${i}].colStart/colEnd must be provided together.` };
    let outColStart: number | undefined;
    let outColEnd: number | undefined;
    if (hasColStart && hasColEnd) {
      if (!isNonNegativeInteger(colStart) || !isNonNegativeInteger(colEnd)) {
        return { ok: false, message: `comments[${i}].colStart/colEnd must be non-negative integers.` };
      }
      if (line === endLine && colEnd <= colStart) {
        return { ok: false, message: `comments[${i}].colEnd must be greater than colStart on a single-line range.` };
      }
      outColStart = colStart;
      outColEnd = colEnd;
    }
    if (quote !== undefined && typeof quote !== 'string') {
      return { ok: false, message: `comments[${i}].quote must be a string when present.` };
    }
    comments.push({
      id, line, endLine,
      colStart: outColStart, colEnd: outColEnd,
      quote: typeof quote === 'string' && quote.length > 0 ? quote : undefined,
      lineText, comment: comment.trim(), createdAt,
    });
  }
  return { ok: true, comments };
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
