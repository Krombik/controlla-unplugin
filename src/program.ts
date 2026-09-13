import ts from 'typescript';
import { dirname } from 'node:path';

/**
 * One program for the whole build, made the first time a file is handed over.
 * A `LanguageService` would answer edits incrementally - this runs in
 * production builds, where nothing is edited.
 */
export const makeProgram = (root: string, tsconfig?: string) => {
  const path = tsconfig || ts.findConfigFile(root, ts.sys.fileExists);

  if (path === undefined) {
    throw new Error(`controlla-unplugin: no tsconfig.json at or above ${root}`);
  }

  const read = ts.readConfigFile(path, ts.sys.readFile);

  if (read.error) {
    throw new Error(
      `controlla-unplugin: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(path)
  );

  return ts.createProgram(parsed.fileNames, parsed.options);
};

/** Every spelling of a path the bundler and the program might disagree over. */
export const findSourceFile = (program: ts.Program, id: string) => {
  const path = id.split('?')[0];

  return (
    program.getSourceFile(path) ||
    program.getSourceFile(path.split('\\').join('/')) ||
    undefined
  );
};
