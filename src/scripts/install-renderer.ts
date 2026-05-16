#!/usr/bin/env node
import { ensureRenderer, isRendererReady } from '../render/termrender.js';

// postinstall hook. Best-effort: provision the pinned termrender venv now so
// the first render is fast. NEVER fail — a renderer hiccup must not brick a
// consumer's `npm install`. The lazy ensureRenderer() on first render covers
// the `npm ci --ignore-scripts` case.
try {
  ensureRenderer();
  if (!isRendererReady()) {
    process.stderr.write('[hl] termrender not provisioned at install time; will retry lazily on first render.\n');
  }
} catch (err) {
  process.stderr.write(`[hl] termrender postinstall skipped: ${err instanceof Error ? err.message : String(err)}\n`);
}
process.exit(0);
