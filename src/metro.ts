import { createRequire } from 'node:module';
import { join } from 'node:path';
import type ts from 'typescript';
import { FLAG, rewrite } from './core.ts';
import { findSourceFile, makeProgram } from './program.ts';

/**
 * Metro has no `define`, and it does run over `node_modules` - so the flag is
 * substituted here rather than asked of the app's babel config.
 */
const GUARD = new RegExp(`typeof ${FLAG} ?!= ?"undefined" ?&& ?${FLAG}`);

const CONTROLLA = /[\\/]node_modules[\\/]controlla(-native)?[\\/]/;

const SOURCE = /\.[cm]?tsx?$/;

/** The app owns the babel transformer this wraps, so resolve it from there. */
const req = createRequire(join(process.cwd(), 'metro.config.js'));

const upstream = (() => {
  const names = [
    '@react-native/metro-babel-transformer',
    'metro-react-native-babel-transformer',
    'metro-babel-transformer',
  ];

  for (let i = 0; i < names.length; i++) {
    try {
      return req(names[i]);
    } catch {
      // the next one, or the throw below
    }
  }

  throw new Error(
    'controlla-unplugin/metro: no react-native babel transformer to delegate to'
  );
})();

let program: ts.Program | undefined;

const rewriteSource = (src: string, filename: string) => {
  const file = findSourceFile(
    (program ||= makeProgram(process.cwd())),
    filename
  );

  if (file === undefined) {
    return src;
  }

  const magic = rewrite(file, program.getTypeChecker(), (node, message) => {
    const { line, character } = file.getLineAndCharacterOfPosition(
      node.getStart(file)
    );

    console.warn(
      `controlla-unplugin ${filename}:${line + 1}:${character + 1} ${message}`
    );
  });

  return magic ? magic.toString() : src;
};

export const transform = (params: {
  src: string;
  filename: string;
  [key: string]: any;
}) => {
  const { src, filename } = params;

  const rewritten = CONTROLLA.test(filename)
    ? src.replace(GUARD, 'true')
    : SOURCE.test(filename) && !CONTROLLA.test(filename)
      ? rewriteSource(src, filename)
      : src;

  return upstream.transform({ ...params, src: rewritten });
};

export const getCacheKey = () =>
  `${upstream.getCacheKey ? upstream.getCacheKey() : ''}controlla-unplugin`;
