---
kind: knowledge
when-and-why-to-read: When writing, changing, selecting, or running Humanloop tests, read this because the repository intentionally limits what earns a test and how long tests may occupy local and publish feedback loops.
short-form: Humanloop adds a test only after the user reports broken behavior; use the smallest regression, run changed files locally, and reserve the comprehensive bounded suite for publish.
system-prompt-visibility: preview
file-read-visibility: none
---

# Humanloop testing stance

Humanloop adds a test only after the user reports that behavior does not work. Write the smallest regression that proves that reported failure, then iterate until it passes. Do not add proactive coverage for new features or load-bearing invariants; verify new behavior directly instead.

During development, run only existing test scripts covering the changed area with `npm test -- <test-file> [more-test-files]`; keep this targeted feedback under 10 seconds. Bare `npm test` remains the comprehensive selection and belongs at the publish gate after `npm run build`, as configured in the existing publish workflow.

The runner enforces a 10-second limit for each test-script process and a 45-second limit for the comprehensive suite, running up to three process-isolated scripts concurrently.

`src/__tests__/inbox-popup.test.ts` is the sole approved 20-second exception because it drives real nested tmux servers and readiness polling across subprocess boundaries. The exception is declared beside that script in `scripts/run-tests.mjs`, not available as a general override.

When a test exceeds its bound, fix or split it rather than raising the timeout. Any new exception or increase to a script or suite limit requires explicit repository-owner approval and a narrow rationale recorded beside the runner entry; never add a silent environment-variable bypass.
