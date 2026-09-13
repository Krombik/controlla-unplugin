# controlla-unplugin

Turns [controlla](https://github.com/Krombik/controlla)'s proxy-backed control scopes into direct method calls at build time.

```ts
$user.contact.name         // →  $user.a('contact').a('name')
$user.tags[i]              // →  $user.a('tags').a('' + i)
const { name } = $contact  // →  const name = $contact.a('name')
const { name } = getUser() // →  const _c0 = getUser(), name = _c0.a('name')
;({ name } = $contact)     // →  name = $contact.a('name')
({ name }) => name         // →  (_c0) => { const name = _c0.a('name'); return name; }
```

A control scope is a `Proxy`, and a proxy trap costs far more than a call — enough to matter on Hermes. With every access rewritten, controlla drops the proxy and hands out plain objects instead.

**TypeScript only.** Which member accesses walk a control is answered by the compiler, not by a naming convention, so a file the checker can't type is left alone.

## Install

```bash
npm i -D controlla-unplugin
```

## Vite

```ts
import controllaPlugin from 'controlla-unplugin/vite';

export default defineConfig({
  plugins: [controllaPlugin()],
});
```

Production builds only — dev keeps the proxy, so nothing the rewrite missed can break while you work.

## Metro (React Native)

```js
// metro.config.js
module.exports = {
  transformer: {
    babelTransformerPath: require.resolve('controlla-unplugin/metro'),
  },
};
```

It wraps your existing React Native babel transformer, so nothing else changes.

## rolldown / webpack / rspack / esbuild / rollup

```ts
import controllaPlugin from 'controlla-unplugin/rolldown';
```

All five are the same call. Rollup has no `define` of its own — add `@rollup/plugin-replace` with `__CONTROLLA_PROXYLESS__: 'true'`; the others set it for you.

## Options

| option     | default                        |                                            |
| ---------- | ------------------------------ | ------------------------------------------ |
| `tsconfig` | nearest above the project root | which one the program is built from        |
| `include`  | `/\.[cm]?tsx?$/`               | files to rewrite                           |
| `exclude`  | `node_modules`, `.d.ts`        | files to skip                              |
| `warn`     | `true`                         | report accesses the checker couldn't prove |

## What it won't rewrite

Warnings, not silent skips:

- **A pattern assigned mid-expression** — `f(({ name } = $user))`. As an expression it answers with the right side; the bindings it would become don't. Give it a statement of its own.
- **An `any`-typed `$` name** — nothing to check against.

Everything else is skipped quietly, because the checker proved it isn't a control.

## Not using the plugin?

controlla ships both scope implementations, so the proxyless half costs about 70 gzipped bytes in a build that never rewrites anything. To drop those too, define the flag `false`:

```ts
define: {
  __CONTROLLA_PROXYLESS__: 'false';
}
```

Left undefined it stays the proxy either way — this is only about size.

## License

MIT
