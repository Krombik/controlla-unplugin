import ts from 'typescript';
import MagicString from 'magic-string';

/**
 * What every control type carries, leaf and scope alike - a `unique symbol`
 * property, so the test is nominal rather than a guess at the mapped type's
 * shape.
 */
const BRAND = '__@CONTROL_BRAND@';

/** The flag `createScope` reads, and what it has to be for `a` to exist. */
export const FLAG = '__CONTROLLA_PROXYLESS__';

/**
 * A route is a control too - of whether it's matched - but the routes under it
 * are plain properties of the tree, put there one by one. Nothing below one was
 * ever a proxy, so nothing below one is a call.
 */
const PAGE_BRAND = '__@IS_PAGE_BRAND@';

/** The method a proxyless scope answers property access with. */
const METHOD = 'a';

export type Warning = {
  message: string;
  line: number;
  column: number;
};

export type Warn = (node: ts.Node, message: string) => void;

const isBranded = (type: ts.Type) => {
  const properties = type.getProperties();

  let branded = false;

  for (let i = 0; i < properties.length; i++) {
    const name = properties[i].escapedName as string;

    if (name.startsWith(PAGE_BRAND)) {
      return false;
    }

    branded ||= name.startsWith(BRAND);
  }

  return branded;
};

/**
 * Whether reading a property off {@link node} walks a control. `optional` drops
 * the nullish half first: `$a?.b` reads the control the union's other half is.
 */
const isControl = (
  checker: ts.TypeChecker,
  node: ts.Node,
  optional?: boolean
) => {
  let type = checker.getTypeAtLocation(node);

  if (optional) {
    type = checker.getNonNullableType(type);
  }

  type = checker.getApparentType(type);

  const parts = type.isUnion() ? type.types : [type];

  for (let i = 0; i < parts.length; i++) {
    if (!isBranded(parts[i])) {
      return false;
    }
  }

  return parts.length > 0;
};

/**
 * Whether the access sits in an optional chain at all - every link of one is
 * typed `| undefined`, not just the link that spells `?.`. Only an optional
 * control reaches this: a scope's own fields are all there.
 */
const inChain = (node: ts.Node) => !!(node.flags & ts.NodeFlags.OptionalChain);

/** Anything that would bind looser than the `+` it is about to sit under. */
const needsParens = (node: ts.Expression) =>
  ts.isBinaryExpression(node) ||
  ts.isConditionalExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isYieldExpression(node);

/**
 * The key as the runtime wants it - a string, since that is what the children
 * are mapped by. `'' + x` rather than `String(x)`: shorter, and no lookup.
 */
const keyOf = (node: ts.Expression) => {
  if (ts.isStringLiteralLike(node)) {
    return node.getText();
  }

  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);

    if (Number.isFinite(value)) {
      return `'${value}'`;
    }
  }

  const text = node.getText();

  return `'' + ${needsParens(node) ? `(${text})` : text}`;
};

/**
 * {@link node} as a expression that can be written more than once - an
 * identifier or a walk down from one, nothing that calls anything. `null` where
 * repeating it would repeat a side effect.
 */
const pathOf = (
  checker: ts.TypeChecker,
  node: ts.Expression
): string | null => {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) {
    return node.getText();
  }

  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return pathOf(checker, node.expression);
  }

  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const base = pathOf(checker, node.expression);

    if (base === null) {
      return null;
    }

    const dot = node.questionDotToken ? '?.' : '.';

    return isControl(checker, node.expression, inChain(node))
      ? `${base}${dot}${METHOD}('${node.name.text}')`
      : `${base}${dot}${node.name.text}`;
  }

  if (ts.isElementAccessExpression(node)) {
    const base = pathOf(checker, node.expression);

    if (base === null) {
      return null;
    }

    const argument = node.argumentExpression;

    return isControl(checker, node.expression, inChain(node))
      ? `${base}${node.questionDotToken ? '?.' : '.'}${METHOD}(${keyOf(argument)})`
      : `${base}${node.questionDotToken ? '?.' : ''}[${argument.getText()}]`;
  }

  return null;
};

const REST =
  'a rest element needs every key up front, and only the proxy knew them';

/** What the assignment is a part of, parens aside. */
const statementOf = (node: ts.Node) => {
  let parent = node.parent;

  while (parent && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }

  return parent;
};

/**
 * Flattens a binding pattern into `name = <path>` pairs. `false` where the
 * pattern asks for something no path can answer, having said which.
 */
const collect = (
  pattern: ts.BindingPattern,
  base: string,
  out: string[],
  warn: Warn
) => {
  const array = ts.isArrayBindingPattern(pattern);

  const elements = pattern.elements;

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];

    if (ts.isOmittedExpression(element)) {
      continue;
    }

    if (element.dotDotDotToken) {
      warn(element, REST);

      return false;
    }

    let key: string;

    if (array) {
      key = `'${i}'`;
    } else {
      const name = element.propertyName || element.name;

      if (ts.isComputedPropertyName(name)) {
        key = keyOf(name.expression);
      } else if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        key = `'${name.text}'`;
      } else if (ts.isNumericLiteral(name)) {
        key = `'${Number(name.text)}'`;
      } else {
        warn(element, 'unsupported key in a control pattern');

        return false;
      }
    }

    const path = `${base}.${METHOD}(${key})`;

    if (ts.isIdentifier(element.name)) {
      out.push(`${element.name.text} = ${path}`);
    } else if (!collect(element.name, path, out, warn)) {
      return false;
    }
  }

  return true;
};

/**
 * A `$`-named object the checker knows nothing about. The rewrite skips it, and
 * without the proxy there is nothing behind the property it reads - so say so
 * here rather than let it turn up as `undefined` in a production build.
 */
const warnUntyped = (
  checker: ts.TypeChecker,
  node: ts.Expression,
  warn: Warn
) => {
  const text = node.getText();

  if (!text.startsWith('$') && !text.includes('.$')) {
    return;
  }

  const type = checker.getTypeAtLocation(node);

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    warn(
      node,
      `${text} is ${checker.typeToString(type)} here, so nothing under it is rewritten - give it a type`
    );
  }
};

/**
 * One target of an assignment pattern: a name, somewhere to put it, or another
 * pattern. A default is dropped - every path of a control is there.
 */
const assignmentTarget = (
  node: ts.Expression,
  base: string,
  out: string[],
  warn: Warn
): boolean => {
  const target =
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? node.left
      : node;

  if (
    ts.isObjectLiteralExpression(target) ||
    ts.isArrayLiteralExpression(target)
  ) {
    return collectAssignment(target, base, out, warn);
  }

  if (
    ts.isIdentifier(target) ||
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    out.push(`${target.getText()} = ${base}`);

    return true;
  }

  warn(target, 'nothing a control path can be assigned to');

  return false;
};

/**
 * The same flattening {@link collect} does, over the object literal TypeScript
 * parses the left of an assignment as - `({ name } = $user)` is a pattern only
 * by position, and carries none of a binding's nodes.
 */
const collectAssignment = (
  pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  base: string,
  out: string[],
  warn: Warn
): boolean => {
  if (ts.isArrayLiteralExpression(pattern)) {
    const elements = pattern.elements;

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];

      if (ts.isOmittedExpression(element)) {
        continue;
      }

      if (ts.isSpreadElement(element)) {
        warn(element, REST);

        return false;
      }

      if (!assignmentTarget(element, `${base}.${METHOD}('${i}')`, out, warn)) {
        return false;
      }
    }

    return true;
  }

  const properties = pattern.properties;

  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];

    if (ts.isShorthandPropertyAssignment(property)) {
      const name = property.name.text;

      out.push(`${name} = ${base}.${METHOD}('${name}')`);

      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      warn(
        property,
        ts.isSpreadAssignment(property)
          ? REST
          : 'unsupported entry in a control pattern'
      );

      return false;
    }

    const name = property.name;

    let key: string;

    if (ts.isComputedPropertyName(name)) {
      key = keyOf(name.expression);
    } else if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      key = `'${name.text}'`;
    } else if (ts.isNumericLiteral(name)) {
      key = `'${Number(name.text)}'`;
    } else {
      warn(property, 'unsupported key in a control pattern');

      return false;
    }

    if (
      !assignmentTarget(
        property.initializer,
        `${base}.${METHOD}(${key})`,
        out,
        warn
      )
    ) {
      return false;
    }
  }

  return true;
};

/** Every `name = <path>` a pattern asks for, or `null` if it asks for a rest. */
const flatten = (pattern: ts.BindingPattern, base: string, warn: Warn) => {
  const out: string[] = [];

  return collect(pattern, base, out, warn) && out.length ? out : null;
};

/**
 * Every property access that walks a control, as a call - and every pattern
 * that destructures one, as the bindings it stands for. Returns the edited
 * source, or `null` where the file had neither.
 */
export const rewrite = (
  file: ts.SourceFile,
  checker: ts.TypeChecker,
  warn: Warn
) => {
  const code = file.getFullText();

  let magic: MagicString | undefined;

  const string = () => (magic ||= new MagicString(code));

  /** Patterns already spent, so the walk doesn't edit inside them twice. */
  const spent = new Set<ts.Node>();

  let count = 0;

  /** A name for the value a pattern is read off, when it has to be read once. */
  const name = () => {
    let candidate: string;

    do {
      candidate = `_c${count++}`;
    } while (new RegExp(`\\b${candidate}\\b`).test(code));

    return candidate;
  };

  /**
   * Puts the bindings at the top of a body - opening it up first where it is a
   * lone expression or statement, so there is a top to put them at.
   */
  const bind = (body: ts.Node, parts: string[], expression: boolean) => {
    const statement = `const ${parts.join(', ')};`;

    if (ts.isBlock(body)) {
      string().appendLeft(body.getStart(file) + 1, ` ${statement}`);

      return;
    }

    string().appendLeft(
      body.getStart(file),
      `{ ${statement}${expression ? ' return ' : ' '}`
    );

    string().appendRight(body.end, expression ? '; }' : ' }');
  };

  /** A pattern with nothing to read it off yet: name the value, then bind. */
  const bindPattern = (
    pattern: ts.BindingPattern,
    body: ts.Node,
    expression: boolean
  ) => {
    const read = name();

    const parts = flatten(pattern, read, warn);

    if (parts === null) {
      return;
    }

    string().overwrite(pattern.getStart(file), pattern.end, read);

    spent.add(pattern);

    bind(body, parts, expression);
  };

  const declaration = (node: ts.VariableDeclaration) => {
    const pattern = node.name as ts.BindingPattern;

    const initializer = node.initializer!;

    const base = pathOf(checker, initializer);

    // a path can be written once per binding; anything else is read once into
    // a name of its own, and the walk still rewrites what is inside it
    if (base === null) {
      const read = name();

      const parts = flatten(pattern, read, warn);

      if (parts === null) {
        return false;
      }

      string().overwrite(pattern.getStart(file), pattern.end, read);

      string().appendRight(node.end, `, ${parts.join(', ')}`);

      spent.add(pattern);

      return false;
    }

    const parts = flatten(pattern, base, warn);

    if (parts === null) {
      return false;
    }

    string().overwrite(node.getStart(file), node.end, parts.join(', '));

    return true;
  };

  /** `({ name } = $user)` - only as a statement, where the value is dropped. */
  const assignment = (node: ts.ExpressionStatement) => {
    let expression: ts.Expression = node.expression;

    while (ts.isParenthesizedExpression(expression)) {
      expression = expression.expression;
    }

    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      return false;
    }

    const left = expression.left;

    if (
      (!ts.isObjectLiteralExpression(left) &&
        !ts.isArrayLiteralExpression(left)) ||
      !isControl(checker, expression.right)
    ) {
      return false;
    }

    const base = pathOf(checker, expression.right);

    if (base === null) {
      warn(
        node,
        'assigning into a pattern needs a plain path on the right - name the value first'
      );

      return false;
    }

    const out: string[] = [];

    if (!collectAssignment(left, base, out, warn) || !out.length) {
      return false;
    }

    // the parens go with it: a lone `name = ...` needs none
    string().overwrite(
      node.expression.getStart(file),
      node.expression.end,
      out.join(', ')
    );

    return true;
  };

  const visit = (node: ts.Node) => {
    if (spent.has(node)) {
      return;
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      !ts.isIdentifier(node.name) &&
      isControl(checker, node.initializer)
    ) {
      // the whole declaration went in rewritten, initializer included
      if (declaration(node)) {
        return;
      }
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.length === 1 &&
      !ts.isIdentifier(node.initializer.declarations[0].name) &&
      isControl(checker, node.initializer.declarations[0].name)
    ) {
      bindPattern(
        node.initializer.declarations[0].name as ts.BindingPattern,
        node.statement,
        false
      );
    } else if (
      ts.isFunctionLike(node) &&
      (node as ts.FunctionLikeDeclaration).body
    ) {
      const body = (node as ts.FunctionLikeDeclaration).body!;

      const parameters = node.parameters;

      for (let i = 0; i < parameters.length; i++) {
        const parameter = parameters[i];

        if (
          !ts.isIdentifier(parameter.name) &&
          isControl(checker, parameter.name)
        ) {
          bindPattern(
            parameter.name as ts.BindingPattern,
            body,
            !ts.isBlock(body)
          );
        }
      }
    } else if (ts.isExpressionStatement(node)) {
      if (assignment(node)) {
        return;
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isObjectLiteralExpression(node.left) ||
        ts.isArrayLiteralExpression(node.left)) &&
      isControl(checker, node.right) &&
      !ts.isExpressionStatement(statementOf(node))
    ) {
      // as an expression it answers with the right side, which the bindings
      // this would become do not
      warn(
        node,
        'a pattern assigned mid-expression keeps the value of the right side - give it a statement of its own'
      );
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.name)
    ) {
      if (isControl(checker, node.expression, inChain(node))) {
        string().overwrite(
          node.expression.end,
          node.end,
          `${node.questionDotToken ? '?.' : '.'}${METHOD}('${node.name.text}')`
        );
      } else {
        warnUntyped(checker, node.expression, warn);
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (isControl(checker, node.expression, inChain(node))) {
        string().overwrite(
          node.expression.end,
          node.end,
          `${node.questionDotToken ? '?.' : '.'}${METHOD}(${keyOf(node.argumentExpression)})`
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);

  return magic;
};
