import { createUnplugin, type UnpluginFactory } from 'unplugin';
import type ts from 'typescript';
import { FLAG, rewrite } from './core.ts';
import { findSourceFile, makePrograms } from './program.ts';

export type Options = {
  /** Defaults to the nearest one above the project root. */
  tsconfig?: string;
  /** Files to rewrite (default: every `.ts`/`.tsx` outside `node_modules`). */
  include?: RegExp;
  exclude?: RegExp;
  /** Whether to report accesses the checker could not prove (default: `true`). */
  warn?: boolean;
};

const DEFAULT_INCLUDE = /\.[cm]?tsx?(\?|$)/;

const DEFAULT_EXCLUDE = /[\\/]node_modules[\\/]|\.d\.[cm]?ts(\?|$)/;

export const unpluginFactory: UnpluginFactory<Options | undefined> = (
  options = {}
) => {
  const include = options.include || DEFAULT_INCLUDE;

  const exclude = options.exclude || DEFAULT_EXCLUDE;

  let programs: ts.Program[] | undefined;

  /** Said once per file, not once per access: a miss is the whole file. */
  const missed = new Set<string>();

  return {
    name: 'controlla-unplugin',
    // ahead of anything that strips the types this reads
    enforce: 'pre',
    transformInclude(id) {
      return include.test(id) && !exclude.test(id);
    },
    // positions come from the program's own copy, so the text does too - this
    // runs at `pre`, before anything else has edited it
    transform(_code, id) {
      const found = findSourceFile(
        (programs ||= makePrograms(process.cwd(), options.tsconfig)),
        id
      );

      // the flag is already defined, so the proxy this file would have leaned
      // on is gone - staying quiet here is how a scope reads `undefined`
      if (found === undefined) {
        if (!missed.has(id)) {
          missed.add(id);

          this.warn(
            `${id} is in no project of the tsconfig, so nothing in it was rewritten - add it, or exclude it from this plugin`
          );
        }

        return null;
      }

      const file = found.file;

      const magic = rewrite(file, found.checker, (node, message) => {
        if (options.warn === false) {
          return;
        }

        const { line, character } = file.getLineAndCharacterOfPosition(
          node.getStart(file)
        );

        this.warn(`${file.fileName}:${line + 1}:${character + 1} ${message}`);
      });

      return (
        magic && {
          code: magic.toString(),
          map: magic.generateMap({ hires: true }),
        }
      );
    },
    vite: {
      // dev keeps the proxy: nothing rewrites, so nothing can be missed
      apply: 'build',
      config: () => ({ define: { [FLAG]: 'true' } }),
    },
    esbuild: {
      config(esbuildOptions) {
        esbuildOptions.define = { ...esbuildOptions.define, [FLAG]: 'true' };
      },
    },
    rolldown: {
      // `any` because the rolldown types unplugin hands over here are rollup's
      options(inputOptions: any) {
        const transform = (inputOptions.transform ||= {});

        transform.define = { ...transform.define, [FLAG]: 'true' };
      },
    },
    webpack(compiler) {
      compiler.options.plugins.push(
        new compiler.webpack.DefinePlugin({ [FLAG]: 'true' })
      );
    },
    rspack(compiler) {
      compiler.options.plugins.push(
        new compiler.rspack.DefinePlugin({ [FLAG]: 'true' })
      );
    },
  };
};

export { FLAG };

const controllaPlugin = createUnplugin(unpluginFactory);

export default controllaPlugin;
