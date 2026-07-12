import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run $EDITOR against a temporary buffer. Terminal ownership stays with the host. */
export function editBufferInEditor(buffer: string): { text: string; error?: string } {
  const tmpFile = join(tmpdir(), `hl-input-${randomUUID()}.txt`);
  const editor = process.env.EDITOR || 'vi';
  try {
    writeFileSync(tmpFile, buffer);
    // $EDITOR may be a shell fragment such as "code --wait".
    const result = spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', tmpFile], { stdio: 'inherit' });
    if (result.error) return { text: buffer, error: `$EDITOR ("${editor}") failed to launch: ${result.error.message}` };
    if (result.signal !== null) return { text: buffer, error: `$EDITOR ("${editor}") was killed by signal ${result.signal}` };
    if (result.status === 127 || result.status === 126) return { text: buffer, error: `$EDITOR ("${editor}") failed to launch (shell exit ${result.status})` };
    if (result.status !== 0) return { text: buffer, error: `$EDITOR ("${editor}") exited with status ${result.status}` };
    let text = readFileSync(tmpFile, 'utf8');
    if (text.endsWith('\n') && !buffer.endsWith('\n')) text = text.slice(0, -1);
    return { text };
  } catch (error) {
    return { text: buffer, error: `$EDITOR round-trip failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
}
