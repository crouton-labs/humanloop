import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editBufferInEditor } from '../editor/roundtrip.js';

const temp = mkdtempSync(join(tmpdir(), 'humanloop-editor-roundtrip-'));
const priorEditor = process.env.EDITOR;
try {
  const successfulEditor = join(temp, 'success-editor');
  writeFileSync(successfulEditor, '#!/bin/sh\nprintf "edited\\n" > "$1"\n');
  chmodSync(successfulEditor, 0o755);
  process.env.EDITOR = successfulEditor;
  assert.deepEqual(editBufferInEditor('original'), { text: 'edited' }, 'editor readback replaces the buffer and removes one editor-added newline');

  const failingEditor = join(temp, 'failing-editor');
  writeFileSync(failingEditor, '#!/bin/sh\nexit 9\n');
  chmodSync(failingEditor, 0o755);
  process.env.EDITOR = failingEditor;
  const failed = editBufferInEditor('keep this');
  assert.equal(failed.text, 'keep this', 'a failing editor leaves the active input intact');
  assert.match(failed.error ?? '', /exited with status 9/, 'a failing editor reports its status to the host');
} finally {
  if (priorEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = priorEditor;
  rmSync(temp, { recursive: true, force: true });
}
console.log('editor round-trip tests passed');
