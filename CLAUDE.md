## Commands
```bash
npm run build   # tsc → dist/
npm run dev     # tsx src/cli.ts (no build needed)
npm test        # runs src/__tests__/mount-panel.test.ts directly via tsx
```

## Constraints
- All relative imports must use `.js` extensions (e.g. `import foo from './foo.js'`), even in `.ts` source files. `"module": "Node16"` + `"type": "module"` requires this — omitting the extension compiles silently but fails at runtime.
- Test files are excluded from `tsc` compilation (`src/__tests__/**` in tsconfig exclude). Run tests via `npm test`, not from `dist/`.
