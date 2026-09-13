import assert from 'node:assert';
import test from 'node:test';
import ts from 'typescript';
import { rewrite, type Warn } from '../src/core.ts';

/**
 * The shape of controlla's own types, down to the `unique symbol` the rewrite
 * matches on - what a scope is made of is the contract here, not the package.
 */
const STUB = `
declare const CONTROL_BRAND: unique symbol;

type Control<V> = { [CONTROL_BRAND]: V };

export type Scope<V> = Control<V> &
  (V extends object ? { readonly [K in keyof V]-?: Scope<V[K]> } : {});

export type User = {
  contact: { name: string; email: string };
  tags: string[];
  counts: Record<string, number>;
};

export declare const $user: Scope<User>;
/** what an optional prop is - the scope's own fields are all there */
export declare const $maybe: Scope<User> | undefined;
export declare const plain: User;
export declare const anything: any;
export declare const $anything: any;
export declare const index: number;
export declare function getUser(): Scope<User>;
export declare const form: { values: Scope<User> };
export declare const controls: Scope<User>[];
export declare function use(value: unknown): void;
`;

const HEAD =
  `import { $user, $maybe, plain, anything, $anything, index, getUser, form, controls, use } from './stub';\n` +
  `import type { Scope, User } from './stub';\n`;

const base = ts.createCompilerHost({});

const run = (source: string) => {
  const files: Record<string, string> = {
    '/stub.ts': STUB,
    '/main.ts': HEAD + source,
  };

  const program = ts.createProgram(
    ['/main.ts'],
    {
      strict: true,
      target: ts.ScriptTarget.ES2021,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      skipLibCheck: true,
      noEmit: true,
    },
    {
      ...base,
      getSourceFile: (name, languageVersion) =>
        files[name] !== undefined
          ? ts.createSourceFile(name, files[name], languageVersion, true)
          : base.getSourceFile(name, languageVersion),
      fileExists: (name) => files[name] !== undefined || base.fileExists(name),
      readFile: (name) => files[name] ?? base.readFile(name),
    }
  );

  const file = program.getSourceFile('/main.ts')!;

  const warnings: string[] = [];

  const warn: Warn = (_node, message) => {
    warnings.push(message);
  };

  const magic = rewrite(file, program.getTypeChecker(), warn);

  const code = (magic ? magic.toString() : file.getFullText()).slice(
    HEAD.length
  );

  return { code, warnings };
};

const equal = (source: string, expected: string) => {
  const { code } = run(source);

  assert.equal(code.trim(), expected.trim());
};

test('a property walk becomes calls', () => {
  equal(
    `const $name = $user.contact.name;`,
    `const $name = $user.a('contact').a('name');`
  );
});

test('nothing on a plain object is touched', () => {
  equal(`const name = plain.contact.name;`, `const name = plain.contact.name;`);
});

test('a control reached through a plain object still walks', () => {
  equal(
    `const $name = form.values.contact.name;`,
    `const $name = form.values.a('contact').a('name');`
  );
});

test("an index becomes '' + it, a literal one a string", () => {
  equal(`const $tag = $user.tags[0];`, `const $tag = $user.a('tags').a('0');`);
  equal(
    `const $tag = $user.tags[index];`,
    `const $tag = $user.a('tags').a('' + index);`
  );
  equal(
    `const $tag = $user.tags[index + 1];`,
    `const $tag = $user.a('tags').a('' + (index + 1));`
  );
  equal(
    `const $count = $user.counts['a'];`,
    `const $count = $user.a('counts').a('a');`
  );
});

test('an optional walk stays optional', () => {
  equal(
    `const $name = $maybe?.contact.name;`,
    `const $name = $maybe?.a('contact').a('name');`
  );
});

test('destructuring flattens into the same calls', () => {
  equal(
    `const { contact, tags } = $user;`,
    `const contact = $user.a('contact'), tags = $user.a('tags');`
  );
  equal(`const { contact: c } = $user;`, `const c = $user.a('contact');`);
  equal(
    `const { contact: { name, email } } = $user;`,
    `const name = $user.a('contact').a('name'), email = $user.a('contact').a('email');`
  );
  equal(`let { tags } = form.values;`, `let tags = form.values.a('tags');`);
  equal(
    `const [, second] = $user.tags;`,
    `const second = $user.a('tags').a('1');`
  );
});

test('a rest element is left alone, with a reason', () => {
  const { code, warnings } = run(`const { contact, ...rest } = $user;`);

  assert.equal(code.trim(), `const { contact, ...rest } = $user;`);
  assert.match(warnings[0], /rest element/);
});

test('a right-hand side that runs once is named once', () => {
  equal(
    `const { contact } = getUser();`,
    `const _c0 = getUser(), contact = _c0.a('contact');`
  );
});

test('a rename and a nested pattern read the same as the walk', () => {
  equal(
    `const { name: $name } = $user.contact;`,
    `const $name = $user.a('contact').a('name');`
  );
  equal(
    `const { contact: { name: $name } } = $user;`,
    `const $name = $user.a('contact').a('name');`
  );
});

test('a default is dropped - every path of a control is there', () => {
  equal(
    `const { contact = $user.contact } = $user;`,
    `const contact = $user.a('contact');`
  );
});

test('a destructured parameter binds at the top of the body', () => {
  equal(
    `const f = ({ contact }: Scope<User>) => contact;`,
    `const f = (_c0: Scope<User>) => { const contact = _c0.a('contact'); return contact; };`
  );
  equal(
    `function f({ contact }: Scope<User>) { use(contact); }`,
    `function f(_c0: Scope<User>) { const contact = _c0.a('contact'); use(contact); }`
  );
});

test('a loop variable binds inside the loop', () => {
  equal(
    `for (const { contact } of controls) use(contact);`,
    `for (const _c0 of controls) { const contact = _c0.a('contact'); use(contact); }`
  );
});

test('assigning into a pattern is left alone, with a reason', () => {
  const { code, warnings } = run(`let contact; ({ contact } = $user);`);

  assert.match(code, /\(\{ contact \} = \$user\)/);
  assert.match(warnings[0], /destructure it with const/);
});

test('an any-typed $ name is reported rather than rewritten', () => {
  const { code, warnings } = run(`const name = $anything.contact.name;`);

  assert.equal(code.trim(), `const name = $anything.contact.name;`);
  assert.match(warnings[0], /give it a type/);
});

test('an untyped name with no $ says nothing', () => {
  const { warnings } = run(`const name = anything.contact.name;`);

  assert.deepEqual(warnings, []);
});

test('a file with no control access is left untouched', () => {
  const { code } = run(`const name = plain.contact.name;`);

  assert.equal(code.trim(), `const name = plain.contact.name;`);
});
