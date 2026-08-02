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

# humanloop

`@crouton-kit/humanloop` (`hl`) — the human-in-the-loop decision TUI: agents write questions, humans answer. TypeScript, ESM-only, npm; a root package plus a `web` workspace. It is also the sole org-wide termrender binding: it pins the PyPI release in `src/render/version.ts` and provisions that exact version in its managed venv — downstream packages must not install or pin termrender independently.

## Common commands

```bash
npm run build          # root tsc + web workspace build
npm run dev -- <args>
npm test               # full scripted suite
```

## Non-default rules

- Relative imports need `.js` extensions even in `.ts` sources (`"module": "Node16"` + `"type": "module"`) — omitting compiles silently but fails at runtime.
- Consumers iterate against an unpublished build with `yalc publish` here then `yalc link @crouton-kit/humanloop` in the consumer — never `yalc add`; a committed `file:.yalc/...` dependency must be removed before publishing.

## Renderer release chain

A published termrender fix is not delivered until humanloop bumps `TERMRENDER_VERSION`, verifies the managed-renderer path, and publishes a new `@crouton-kit/humanloop` release. Then update consumers per their actual dependency contract:

- **crouter** pins `@crouton-kit/humanloop` to an exact version in both `package.json` and `package-lock.json` — bump both.
- **sisyphus** declares `latest` but its `pnpm-lock.yaml` still pins the installed resolution — refresh the lock.
- **Northlight** consumes humanloop only transitively, through the crouter package baked into `apps/crouter-guest`: publish crouter with the new pin, bump `CRTR_VERSION` in `apps/crouter-guest/build.env`, and rebuild/roll the guest image (local-docker and Blaxel stay on the same image). Do not claim Northlight consumes humanloop directly.

## Done

Build green, `npm test` green, conventional commit. CI publishes on push to `main`.

## Pointers

- What earns test coverage and how long local feedback may take → [[testing]]
- Terminal editor vs surrounding-surface keyboard behavior → [[insights/text-input-scroll-controls]]
