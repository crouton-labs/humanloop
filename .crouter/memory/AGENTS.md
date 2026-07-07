---
kind: knowledge
when-and-why-to-read: When working in humanloop, this knowledge should be read
  because it is the project's operating guide.
short-form: Constraints
system-prompt-visibility: content
file-read-visibility: content
---

## Constraints
- All relative imports must use `.js` extensions (e.g. `import foo from './foo.js'`), even in `.ts` source files. `"module": "Node16"` + `"type": "module"` requires this — omitting the extension compiles silently but fails at runtime.

## Consumer convention (sisyphus, crouter, downstream)
- Committed `package.json` deps for `@crouton-kit/humanloop` say `"latest"` — npm install always pulls the newest publish. The `minimumReleaseAgeExclude` entry in the consumer's `pnpm-workspace.yaml` bypasses pnpm's 24h release-age filter so fresh CI publishes resolve immediately.
- For local iteration against an unpublished humanloop, use **`yalc link`, not `yalc add`**. `cd humanloop && yalc publish`, then `cd <consumer> && yalc link @crouton-kit/humanloop`. `yalc link` symlinks the package into `node_modules/` without touching `package.json` — so the committed `"latest"` reference stays clean and you never need to remove/re-add. Switch back with `yalc remove` (drops the symlink, npm-installed version resurfaces).
- `.yalc/` directory and `yalc.lock` belong in every consumer's `.gitignore`. If `file:.yalc/...` ever appears in a committed `package.json`, that's `yalc add` being used by mistake — switch the workflow to `yalc link` and `git rm -r .yalc yalc.lock` from the consumer.
