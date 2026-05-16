## Constraints
- All relative imports must use `.js` extensions (e.g. `import foo from './foo.js'`), even in `.ts` source files. `"module": "Node16"` + `"type": "module"` requires this — omitting the extension compiles silently but fails at runtime.
