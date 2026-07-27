import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const MAX_CANDIDATES = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_LINES = 5000;
const PATH_TOKEN = /[A-Za-z0-9._~@\-/]+(?::\d+(?::\d+)?)?/g;
const EXTENSION_END = /\.[A-Za-z][A-Za-z0-9]{0,15}$/;

function normalizeCandidate(raw: string): string {
  let candidate = raw
    .replace(/^[`'"(]+/, '')
    .replace(/[`'".,;:)\]}]+$/, '');
  candidate = candidate.replace(/:\d+(?::\d+)?$/, '');
  return candidate.replace(/[`'".,;:)\]}]+$/, '');
}

function candidatePath(raw: string, cwd: string): string | null {
  let candidate = normalizeCandidate(raw);
  if (!candidate || (!candidate.includes('/') && !EXTENSION_END.test(candidate))) return null;
  if (candidate.startsWith('~/')) candidate = resolve(homedir(), candidate.slice(2));
  return resolve(isAbsolute(candidate) ? candidate : resolve(cwd, candidate));
}

/** Extract existing file paths from surface text, preserving newest-first occurrence order. */
export function extractFilePaths(texts: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    for (const match of text.matchAll(PATH_TOKEN)) {
      const abs = candidatePath(match[0], cwd);
      if (abs === null || seen.has(abs)) continue;
      try {
        if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(abs);
      found.push(abs);
      if (found.length === MAX_CANDIDATES) return found;
    }
  }

  return found;
}

/** Check whether a local file fits the accessory review surface's v1 limits. */
export function checkReviewableFile(abs: string): { ok: true } | { ok: false; reason: string } {
  let size: number;
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { ok: false, reason: 'not a file' };
    size = stat.size;
  } catch {
    return { ok: false, reason: 'not a file' };
  }

  if (size > MAX_FILE_BYTES) {
    return { ok: false, reason: 'file is too large to review (2 MB limit)' };
  }

  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, reason: 'not a file' };
  }
  if (content.includes('\uFFFD') || content.includes('\0')) {
    return { ok: false, reason: 'file is not UTF-8 text' };
  }
  if (content.split('\n').length > MAX_FILE_LINES) {
    return { ok: false, reason: 'file is too long to review (5,000 line limit)' };
  }

  return { ok: true };
}
