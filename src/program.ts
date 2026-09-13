import ts from 'typescript';
import { dirname } from 'node:path';

const read = (path: string) => {
  const file = ts.readConfigFile(path, ts.sys.readFile);

  if (file.error) {
    throw new Error(
      `controlla-unplugin: ${ts.flattenDiagnosticMessageText(file.error.messageText, '\n')}`
    );
  }

  return ts.parseJsonConfigFileContent(file.config, ts.sys, dirname(path));
};

/**
 * Every project a config leads to. A solution-style root - `"files": []` with
 * nothing but `references` - names no files of its own, so the projects under
 * it are the ones holding the source.
 */
const collect = (
  path: string,
  seen: Set<string>,
  out: ts.ParsedCommandLine[]
) => {
  if (seen.has(path)) {
    return;
  }

  seen.add(path);

  const parsed = read(path);

  if (parsed.fileNames.length) {
    out.push(parsed);
  }

  const references = parsed.projectReferences;

  if (references) {
    for (let i = 0; i < references.length; i++) {
      const referencePath = ts.resolveProjectReferencePath(references[i]);

      if (referencePath) {
        collect(referencePath, seen, out);
      }
    }
  }
};

/**
 * One program per project rather than one for the lot: a reference carries its
 * own `lib`, `types` and module resolution, and the types this reads are only
 * as good as those.
 */
export const makePrograms = (root: string, tsconfig?: string) => {
  const path = tsconfig || ts.findConfigFile(root, ts.sys.fileExists);

  if (path === undefined) {
    throw new Error(`controlla-unplugin: no tsconfig.json at or above ${root}`);
  }

  const projects: ts.ParsedCommandLine[] = [];

  collect(path, new Set(), projects);

  if (!projects.length) {
    throw new Error(
      `controlla-unplugin: ${path} names no files, and neither does any project it references - nothing could be rewritten, and a build with the proxy already dropped would read \`undefined\` off every scope`
    );
  }

  return projects.map((project) =>
    ts.createProgram(project.fileNames, project.options)
  );
};

/** Every spelling of a path a bundler and a program might disagree over. */
export const findSourceFile = (programs: ts.Program[], id: string) => {
  const path = id.split('?')[0];

  const slashed = path.split('\\').join('/');

  for (let i = 0; i < programs.length; i++) {
    const file =
      programs[i].getSourceFile(path) || programs[i].getSourceFile(slashed);

    if (file !== undefined) {
      return { file, checker: programs[i].getTypeChecker() };
    }
  }

  return undefined;
};
