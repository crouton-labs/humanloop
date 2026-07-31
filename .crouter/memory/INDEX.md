---
kind: knowledge
when-and-why-to-read: When working in Humanloop, this knowledge should be read
  because its dependency and release boundaries determine whether renderer and
  SDK fixes actually reach shipped consumers.
short-form: Humanloop constraints and renderer release chain
system-prompt-visibility: none
file-read-visibility: content
applies-to: .
origin:
  created: 2026-07-25T01:17:38.471Z
  cwd: /Users/silasrhyneer/Code/cli/crouter
  node: 3zl47w7d-mrznzuss-0d6c2d50
name: humanloop
---

## Constraints

- All relative imports must use `.js` extensions (for example, `import foo from './foo.js'`), even in `.ts` source files. `"module": "Node16"` plus `"type": "module"` requires this; omitting the extension compiles silently but fails at runtime.

## Renderer ownership and release handoff

- Humanloop is the sole org-wide termrender binding. It pins the PyPI release in `src/render/version.ts` and provisions that exact version in its managed venv; downstream packages must not install or pin termrender independently.
- A published termrender fix is not delivered until Humanloop bumps `TERMRENDER_VERSION`, verifies the managed-renderer path, and publishes a new `@crouton-kit/humanloop` release.
- After Humanloop publishes, update direct consumers according to their actual dependency contract: crouter pins `@crouton-kit/humanloop` to an exact version in both `package.json` and `package-lock.json`; Sisyphus declares `latest` but its `pnpm-lock.yaml` still pins the installed resolution and must be refreshed when shipping the new renderer. Do not claim Northlight consumes Humanloop directly.
- Northlight receives this renderer transitively through the crouter package baked into `apps/crouter-guest`. To ship the fix there, first publish crouter with the new Humanloop pin, then update Northlight's `apps/crouter-guest/build.env` `CRTR_VERSION` and rebuild/roll the guest image. Keep local-docker and Blaxel on the same image.

## Local cross-package development

- Use `yalc link`, never `yalc add`, for an unpublished Humanloop build: run `yalc publish` in Humanloop, then `yalc link @crouton-kit/humanloop` in the consumer. `yalc link` leaves the committed dependency spec clean; remove it with `yalc remove @crouton-kit/humanloop`.
- `.yalc/` and `yalc.lock` belong in consumer `.gitignore` files. A committed `file:.yalc/...` dependency means `yalc add` was used accidentally and must be removed before publishing.

## Further guidance

- When changing Humanloop tests, read `crtr memory read testing` because that document defines what earns coverage and how long local feedback may take.
- When changing terminal editor or surrounding-surface keyboard behavior, read `crtr memory read taste/text-input-scroll-controls` because it carries the settled navigation split.
