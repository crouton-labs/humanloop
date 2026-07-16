---
kind: knowledge
when-and-why-to-read: When writing, changing, selecting, or running Humanloop tests, read this because the repository intentionally limits what earns a test and how long tests may occupy local and publish feedback loops.
short-form: Humanloop tests only durable regressions and load-bearing invariants; run changed test files locally, reserve the comprehensive bounded suite for publish, and require approval for timeout exceptions.
system-prompt-visibility: preview
file-read-visibility: none
---

# Humanloop testing stance

Humanloop adds a test only for a real failure (the smallest regression that would have caught it) or a permanent load-bearing invariant such as protocol compatibility, concurrency, persistence ownership, or lifecycle behavior. Do not add speculative unit tests or automate exploratory behavior whose shape may still change.

During development, run only test scripts covering the changed area with `npm test -- <test-file> [more-test-files]`; keep this targeted feedback under 10 seconds. Bare `npm test` remains the comprehensive selection and belongs at the publish gate after `npm run build`, as configured in the existing publish workflow.

The runner enforces a 10-second limit for each test-script process and a 45-second limit for the comprehensive serial suite. These bounds are based on the current runner's macOS timings: ordinary scripts complete within 4.5 seconds and the comprehensive chain in 22.1 seconds, leaving bounded CI variance without turning hangs into long stalls.

`src/__tests__/inbox-popup.test.ts` is the sole approved 20-second exception because it drives real nested tmux servers and readiness polling across subprocess boundaries; its observed local duration is about 4.4 seconds, but its existing readiness contract permits a 12-second poll. The exception is declared beside that script in `scripts/run-tests.mjs`, not available as a general override.

When a test exceeds its bound, fix or split the test rather than raising the timeout. Any new exception or increase to a script or suite limit requires explicit repository-owner approval and a narrow rationale recorded beside the runner entry; never add a silent environment-variable bypass.
