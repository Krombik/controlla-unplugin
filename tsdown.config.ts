import { defineConfig } from 'tsdown';
import fs from 'fs/promises';

const _outDir = 'build';

const _filesToCopy = ['LICENSE', 'README.md'];

/** One re-export each, and one subpath export each. */
const _adapters = [
  'vite',
  'rollup',
  'rolldown',
  'webpack',
  'rspack',
  'esbuild',
];

/** Carried over from the root package.json as-is, version included. */
const _inheritedFields = [
  'version',
  'description',
  'author',
  'keywords',
  'repository',
  'license',
  'bugs',
  'homepage',
  'type',
  'engines',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];

const _pickFrom = (obj: Record<string, any>, keys: string[]) =>
  keys.reduce<Record<string, any>>(
    (acc, key) => (obj[key] != null ? { ...acc, [key]: obj[key] } : acc),
    {}
  );

const _getModule = (name: string, ext: 'mts' | 'cts') => ({
  types: `./${name}.d.${ext}`,
  default: `./${name}.${ext === 'mts' ? 'mjs' : 'cjs'}`,
});

/**
 * Generated rather than checked in: the published package sits at the build
 * root, so every path in it is one segment shorter than the source's.
 */
const _writePackageJson = async () => {
  const root = JSON.parse((await fs.readFile('package.json')).toString());

  const exports: Record<string, any> = {
    '.': _getModule('index', 'mts'),
  };

  for (let i = 0; i < _adapters.length; i++) {
    exports[`./${_adapters[i]}`] = _getModule(_adapters[i], 'mts');
  }

  await fs.writeFile(
    `${_outDir}/package.json`,
    JSON.stringify(
      {
        ..._pickFrom(root, ['name', ..._inheritedFields]),
        exports: {
          ...exports,
          // Metro asks for its transformer with `require`
          './metro': _getModule('metro', 'cts'),
          './package.json': './package.json',
        },
        main: './index.mjs',
        types: './index.d.mts',
        publishConfig: { access: 'public' },
        sideEffects: false,
      },
      undefined,
      2
    )
  );

  for (let i = 0; i < _filesToCopy.length; i++) {
    await fs.copyFile(_filesToCopy[i], `${_outDir}/${_filesToCopy[i]}`);
  }
};

const _shared = {
  outDir: _outDir,
  platform: 'node' as const,
  target: 'node18',
  dts: true,
  sourcemap: true,
  // we generate package.json (and its exports) ourselves in build:done
  exports: false,
};

export default defineConfig([
  {
    ..._shared,
    entry: _adapters.reduce<Record<string, string>>(
      (entry, name) => ({ ...entry, [name]: `src/${name}.ts` }),
      { index: 'src/index.ts' }
    ),
    format: ['esm'],
    clean: true,
  },
  {
    ..._shared,
    entry: { metro: 'src/metro.ts' },
    format: ['cjs'],
    clean: false,
    hooks: { 'build:done': _writePackageJson },
  },
]);
