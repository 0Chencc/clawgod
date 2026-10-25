import { parse } from './acorn.mjs';

export const AST_PATCH_IDS = [
  'user-type-ant', 'bun-standalone-executable', 'growthbook-env-overrides-graph',
  'computer-use-default', 'ultraplan', 'voice-mode',
  'geo-stego-date', 'remote-settings-off', 'wiggly-dove',
  'tool-result-pairing-recovery',
];

const anchors = ['external', 'isStandaloneExecutable', 'environmentOverridesParsed',
  'pixelValidation', 'ultraplan', 'tengu_amber_quartz_disabled', 's date is ',
  'Remote settings:', 'remote-settings.json', 'tengu_wiggly_dove',
  '[Tool result missing due to internal error]'];
const gate = id => `globalThis.__clawgodPatches?.[${JSON.stringify(id)}]!==!1`;
const literal = (node, value) => node?.type === 'Literal' && node.value === value;
const propertyName = node => node.computed
  ? (node.key?.type === 'Literal' ? node.key.value : undefined)
  : (node.key?.name ?? node.key?.value);
const member = (node, name) => node?.type === 'MemberExpression' &&
  (node.computed ? literal(node.property, name) : node.property.name === name);
const thisMember = (node, name) => member(node, name) && node.object.type === 'ThisExpression';
const boolean = (node, value) => literal(node, value) ||
  (node?.type === 'UnaryExpression' && node.operator === '!' && literal(node.argument, value ? 0 : 1));
const isUndefined = node => node?.type === 'UnaryExpression' && node.operator === 'void' &&
  literal(node.argument, 0);

export const parsePatchSource = code => parse(code, {
  ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true,
  allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
});

// Iterative traversal avoids adding a second call stack limit to large bundles.
function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    for (const value of Object.values(node)) {
      if (value?.type) pending.push(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (child?.type) pending.push(child);
      }
    }
  }
}
// Iterative traversal bounded to the current function scope.
// Stops descending at nested function boundaries to prevent outer scopes from
// claiming inner statements or creating overlapping edits.
function walkScope(root, visit) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    for (const value of Object.values(node)) {
      if (!value) continue;
      if (value.type) {
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(value.type)) {
          visit(value);
        } else {
          pending.push(value);
        }
      } else if (Array.isArray(value)) {
        for (const child of value) {
          if (!child?.type) continue;
          if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(child.type)) {
            visit(child);
          } else {
            pending.push(child);
          }
        }
      }
    }
  }
}

function pairingScopeResolver(tree, sentinel) {
  const scopes = new WeakMap(), writes = [];
  const names = pattern => {
    const pending = [pattern], result = [];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.type === 'Identifier') result.push(node.name);
      if (node.type === 'RestElement') pending.push(node.argument);
      if (node.type === 'AssignmentPattern') pending.push(node.left);
      if (node.type === 'ArrayPattern') pending.push(...node.elements);
      if (node.type === 'ObjectPattern') pending.push(...node.properties.map(p => p.type === 'RestElement' ? p.argument : p.value));
    }
    return result;
  };
  const declare = (scope, pattern, value) => {
    for (const name of names(pattern)) {
      if (!scope.bindings.has(name)) scope.bindings.set(name, []);
      if (value !== null) scope.bindings.get(name).push(value);
    }
  };
  const resolve = (scope, name) => {
    for (; scope; scope = scope.parent) {
      if (scope.bindings.has(name)) return scope.bindings.get(name);
    }
  };
  const pending = [{ node: tree, scope: null }];
  while (pending.length) {
    let { node, scope } = pending.pop();
    const fn = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
    const cls = node.type === 'ClassDeclaration' || node.type === 'ClassExpression';
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') declare(scope, node.id);
    if (fn || cls || ['Program', 'BlockStatement', 'StaticBlock', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'].includes(node.type)) {
      scope = { parent: scope, bindings: new Map(), vars: scope?.vars };
      if (fn || node.type === 'Program' || node.type === 'StaticBlock') scope.vars = scope;
      scopes.set(node, scope);
    }
    if (fn) {
      if (node.id) declare(scope, node.id);
      for (const param of node.params) declare(scope, param);
    }
    if (cls && node.id) declare(scope, node.id);
    if (node.type === 'CatchClause') declare(scope, node.param);
    if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) declare(scope, specifier.local);
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        // Destructuring does not bind the whole initializer to each name.
        const value = declaration.id.type === 'Identifier' ? declaration.init : undefined;
        declare(node.kind === 'var' ? scope.vars : scope, declaration.id, value);
      }
    }
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      writes.push({ scope, pattern: node.left ?? node.argument,
        value: node.operator === '=' && node.left.type === 'Identifier' ? node.right : undefined });
    }
    if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const patterns = node.left.type === 'VariableDeclaration' ? node.left.declarations.map(d => d.id) : [node.left];
      for (const pattern of patterns) writes.push({ scope, pattern, value: undefined });
    }
    for (const value of Object.values(node)) {
      if (value?.type) pending.push({ node: value, scope });
      else if (Array.isArray(value)) for (const child of value) if (child?.type) pending.push({ node: child, scope });
    }
  }
  // Resolve writes after declarations so hoisting and later declarations shadow correctly.
  for (const { scope, pattern, value } of writes) {
    for (const name of names(pattern)) resolve(scope, name)?.push(value);
  }
  return (expr, callback, owner) => {
    const history = owner.params[0].name;
    if (resolve(scopes.get(callback).parent, history) !== scopes.get(owner).bindings.get(history)) return false;
    if (literal(expr, sentinel)) return true;
    if (expr?.type !== 'Identifier') return false;
    const values = resolve(scopes.get(callback.body) ?? scopes.get(callback), expr.name);
    return !!values?.length && values.every(value => literal(value, sentinel));
  };
}


function hasGate(node, id) {
  let found = false;
  walk(node, child => {
    if (member(child, id) && member(child.object, '__clawgodPatches') &&
        child.object.object.name === 'globalThis') found = true;
  });
  return found;
}

function hasRemoteSettingsContext(node) {
  let found = false;
  walk(node, child => {
    const strings = child.type === 'Literal' && typeof child.value === 'string' ? [child.value]
      : child.type === 'TemplateLiteral' ? child.quasis.map(quasi => quasi.value.cooked ?? '') : [];
    if (strings.some(value => value.includes('Remote settings:') || value.includes('remote-settings.json'))) found = true;
  });
  return found;
}

// One parse per candidate file, shared by every semantic patch. Keep only edit
// ranges; the large AST can be collected before the next graph chunk is parsed.
export function scanAstPatches(code) {
  const results = Object.fromEntries(AST_PATCH_IDS.map(id => [id, { matches: [], present: false, patched: false }]));
  if (!anchors.some(anchor => code.includes(anchor))) return results;
  const tree = parsePatchSource(code);
  const edit = (id, node, replacement) => {
    results[id].matches.push({ start: node.start, end: node.end, replacement });
  };
  const injectReturn = (id, fn, value) => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(fn?.type) || fn.async || fn.generator) return;
    if (hasGate(fn, id)) return;
    const body = fn.body;
    const original = code.slice(body.start, body.end);
    if (body.type !== 'BlockStatement') {
      edit(id, body, `(${gate(id)}?${value}:(${original}))`);
      return;
    }
    let insertion = body.start + 1;
    for (const statement of body.body) {
      if (!statement.directive) break;
      insertion = statement.end;
    }
    const offset = insertion - body.start;
    edit(id, body, `${original.slice(0, offset)};if(${gate(id)})return ${value};${original.slice(offset)}`);
  };

  // Remote settings are identified by the eligibility helper's diagnostics,
  // not a minified name or the common cache/`{eligible}` prefix. Keep this
  // local to one chunk: cross-chunk imports are not a stable contract.
  const functions = new Map();
  const wigglyLiterals = new Set(), wigglyHandled = new Set();
  let pairingHandled = false;
  const MISSING_SENTINEL = '[Tool result missing due to internal error]';
  const resolvesToMissingSentinel = code.includes(MISSING_SENTINEL) ? pairingScopeResolver(tree, MISSING_SENTINEL) : () => false;
  walk(tree, node => {
    if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
      functions.set(node.id.name, node);
    }
  });
  walk(tree, node => {
    if (literal(node, 'tengu_wiggly_dove')) wigglyLiterals.add(node.start);
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      const flags = node.body.filter(s => s.type === 'VariableDeclaration')
        .flatMap(s => s.declarations).filter(d => literal(d.init, 'tengu_wiggly_dove'));
      for (const flag of flags) {
        const id = 'wiggly-dove';
        const candidates = node.body.filter(fn => {
          if (fn.type !== 'FunctionDeclaration' || fn.params.length || fn.async || fn.generator) return false;
          // Only the boolean eligibility helper, never a collector or a
          // nested function with a shadowed flag binding.
          const statements = fn.body.body.filter(s => !s.directive && s.type !== 'EmptyStatement');
          const guards = statements.slice(0, -1);
          const last = statements.at(-1);
          if (!guards.length || !guards.every(s => s.type === 'IfStatement' && !s.alternate &&
              s.consequent.type === 'ReturnStatement' && boolean(s.consequent.argument, false)) ||
              last?.type !== 'ReturnStatement' || last.argument?.type !== 'CallExpression') return false;
          return flag.id.type === 'Identifier' && guards.some(s => {
            const call = s.test.type === 'UnaryExpression' && s.test.operator === '!' ? s.test.argument : null;
            return call?.type === 'CallExpression' && call.arguments.length === 2 &&
              call.arguments[0].type === 'Identifier' && call.arguments[0].name === flag.id.name &&
              boolean(call.arguments[1], false);
          });
        });
        if (candidates.length !== 1) continue;
        wigglyHandled.add(flag.init.start);
        if (hasGate(candidates[0], id)) results[id].patched = true;
        else injectReturn(id, candidates[0], '!1');
      }
    }

    if (node.type === 'ObjectExpression') {
      // Spreads, accessors and duplicate keys can change which value is used.
      const props = node.properties;
      const named = name => props.filter(p => p.type === 'Property' && propertyName(p) === name);
      const names = named('name');
      if (names.some(p => literal(p.value, 'ultraplan'))) {
        const enabled = named('isEnabled');
        const patched = enabled.length === 1 && hasGate(enabled[0].value, 'ultraplan');
        if (patched) results.ultraplan.patched = true;
        else results.ultraplan.present = true;
        if (names.length === 1 && enabled.length === 1 && enabled[0].kind === 'init' &&
            !props.some(p => p.type === 'SpreadElement' || (p.computed && p.key.type !== 'Literal'))) {
          injectReturn('ultraplan', enabled[0].value, '!0');
        }
      }
      const enabled = named('enabled');
      if (named('pixelValidation').length === 1 && enabled.length === 1 &&
          enabled[0].kind === 'init' && boolean(enabled[0].value, false) &&
          !props.some(p => p.type === 'SpreadElement' || (p.computed && p.key.type !== 'Literal'))) {
        edit('computer-use-default', enabled[0].value,
          `(${gate('computer-use-default')}?!0:(${code.slice(enabled[0].value.start, enabled[0].value.end)}))`);
      }
    }

    if (node.type === 'FunctionDeclaration' && node.params.length === 1 &&
        node.params[0].type === 'Identifier' && !node.async && !node.generator) {
      const date = node.body.body.find(s => s.type === 'ReturnStatement')?.argument;
      const quasis = date?.type === 'TemplateLiteral' ? date.quasis.map(q => q.value.cooked) : [];
      if (quasis.length === 3 && quasis[0] === 'Today' && quasis[1] === 's date is ' && quasis[2] === '.') {
        const id = 'geo-stego-date';
        if (hasGate(node, id)) results[id].patched = true;
        else {
          results[id].present = true;
          const bindings = new Map(node.body.body.filter(s => s.type === 'VariableDeclaration')
            .flatMap(s => s.declarations).filter(d => d.id.type === 'Identifier').map(d => [d.id.name, d.init]));
          const formatted = bindings.get(date.expressions[1]?.name);
          const call = formatted?.type === 'ConditionalExpression' ? formatted.consequent : null;
          const param = node.params[0].name;
          if (call?.type === 'CallExpression' && member(call.callee, 'replaceAll') &&
              call.callee.object.name === param && call.arguments.length === 2 &&
              literal(call.arguments[0], '-') && literal(call.arguments[1], '/') && formatted.alternate.name === param) {
            injectReturn(id, node, `\`Today's date is \${${param}}.\``);
          }
        }
      }
    }

    if (node.type === 'FunctionDeclaration' && node.params.length === 0 &&
        !node.async && !node.generator && node.body.body.length === 1 &&
        node.body.body[0].type === 'ReturnStatement') {
      const value = node.body.body[0].argument;
      if (literal(value, 'external')) edit('user-type-ant', value, '"ant"');
      const standalone = expr => expr?.type === 'BinaryExpression' && expr.operator === '===' &&
        member(expr.left, 'isStandaloneExecutable') && expr.left.object.name === 'Bun' && boolean(expr.right, true);
      const typeofBun = expr => expr?.type === 'BinaryExpression' && expr.operator === '<' &&
        expr.left.type === 'UnaryExpression' && expr.left.operator === 'typeof' &&
        expr.left.argument.name === 'Bun' && literal(expr.right, 'u');
      if (standalone(value) || (value?.type === 'LogicalExpression' && value.operator === '&&' &&
          typeofBun(value.left) && standalone(value.right))) edit('bun-standalone-executable', value, '!0');
      if (value?.type === 'UnaryExpression' && value.operator === '!' &&
          value.argument.type === 'CallExpression' && value.argument.callee.type === 'Identifier' &&
          value.argument.arguments.length === 2 && literal(value.argument.arguments[0], 'tengu_amber_quartz_disabled') &&
          boolean(value.argument.arguments[1], false)) {
        edit('voice-mode', value, `(${gate('voice-mode')}?!0:(${code.slice(value.start, value.end)}))`);
      }
    }

    if (node.type === 'FunctionDeclaration' && node.params.length === 0 &&
        !node.async && !node.generator) {
      const statements = node.body.body;
      const cached = statements.find(statement => statement.type === 'VariableDeclaration' &&
        statement.declarations.length === 1 && statement.declarations[0].id.type === 'Identifier' &&
        statement.declarations[0].init?.type === 'CallExpression');
      const cachedName = cached?.declarations[0].id.name;
      const cachedReturn = cachedName && statements.find(statement =>
        statement.type === 'IfStatement' && statement.test.type === 'BinaryExpression' &&
        statement.test.operator === '!==' && statement.test.left.type === 'Identifier' &&
        statement.test.left.name === cachedName && isUndefined(statement.test.right) &&
        statement.consequent.type === 'ReturnStatement' && statement.consequent.argument?.type === 'Identifier' &&
        statement.consequent.argument.name === cachedName);
      const eligibility = statements.find(statement => statement.type === 'VariableDeclaration' &&
        statement.declarations.length === 1 && statement.declarations[0].id.type === 'ObjectPattern' &&
        statement.declarations[0].init?.type === 'CallExpression' &&
        statement.declarations[0].init.callee.type === 'Identifier' &&
        statement.declarations[0].id.properties.some(property => property.type === 'Property' &&
          propertyName(property) === 'eligible'));
      const helper = eligibility && functions.get(eligibility.declarations[0].init.callee.name);
      if (helper && hasRemoteSettingsContext(helper)) {
        const id = 'remote-settings-off';
        if (!cachedReturn) results[id].present = true;
        else {
          results[id].present = false;
          if (hasGate(node, id)) results[id].patched = true;
          else injectReturn(id, node, '!1');
        }
      }
    }

    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) &&
        node.params.length > 0 && node.params[0].type === 'Identifier') {
      const historyParam = node.params[0].name;
      let isHistoryArray = false;
      walkScope(node.body, inner => {
        if (inner.type === 'MemberExpression' && inner.object?.type === 'Identifier' && inner.object.name === historyParam) {
          if (inner.property?.name === 'length' || inner.computed) isHistoryArray = true;
        }
      });
      if (isHistoryArray) {
        const id = 'tool-result-pairing-recovery';
        if (hasGate(node, id)) {
          results[id].patched = true;
          pairingHandled = true;
        } else {
          walkScope(node.body, inner => {
            if (inner.type === 'CallExpression' && inner.callee?.type === 'MemberExpression' &&
                inner.callee.property?.name === 'map' && inner.arguments.length >= 1) {
              const cb = inner.arguments[0];
              if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(cb?.type) || cb.async || cb.generator) return;
              const idParam = cb.params[0];
              if (cb.params.length !== 1 || idParam?.type !== 'Identifier') return;
              const returnObj = cb.body.type === 'ObjectExpression' ? cb.body
                : cb.body.type === 'BlockStatement' && cb.body.body.length === 1 && cb.body.body[0].type === 'ReturnStatement' ? cb.body.body[0].argument
                : null;
              if (returnObj?.type !== 'ObjectExpression') return;
              const props = returnObj.properties.filter(p => p.type === 'Property');
              if (props.length !== 4 || returnObj.properties.length !== 4 ||
                  props.some(p => p.kind !== 'init' || p.method || (p.computed && p.key.type !== 'Literal')) ||
                  new Set(props.map(propertyName)).size !== 4) return;
              const hasType = props.some(p => propertyName(p) === 'type' && literal(p.value, 'tool_result'));
              const hasToolUseId = props.some(p => propertyName(p) === 'tool_use_id' && p.value?.type === 'Identifier' && p.value.name === idParam.name);
              const hasIsError = props.some(p => propertyName(p) === 'is_error' && boolean(p.value, true));
              const contentProp = props.find(p => propertyName(p) === 'content');
              if (hasType && hasToolUseId && hasIsError && contentProp && resolvesToMissingSentinel(contentProp.value, cb, node)) {
                // Collect all identifiers across the entire function tree to guarantee no variable shadowing or collisions
                const usedNames = new Set();
                walk(node, n => {
                  if (n.type === 'Identifier') usedNames.add(n.name);
                });
                const freshId = base => {
                  let name = base;
                  let counter = 1;
                  while (usedNames.has(name)) {
                    name = `${base}${counter++}`;
                  }
                  usedNames.add(name);
                  return name;
                };
                const pVar = freshId('_p');
                const mVar = freshId('_m');
                const bVar = freshId('_b');
                const idVar = freshId('_id');
                const mapTarget = code.slice(inner.callee.object.start, inner.callee.object.end);
                const contentExpr = code.slice(contentProp.value.start, contentProp.value.end);
                const replacement =
                  `${mapTarget}.map((${idVar})=>{` +
                  `let ${pVar};` +
                  `if(${gate(id)}){` +
                  `for(let ${mVar} of ${historyParam}){` +
                  `if(${mVar}?.message?.content&&Array.isArray(${mVar}.message.content)){` +
                  `for(let ${bVar} of ${mVar}.message.content){` +
                  `if(${bVar}?.type==="tool_result"&&${bVar}.tool_use_id===${idVar}&&${bVar}.content!==${contentExpr}){` +
                  `${pVar}=${bVar};break;` +
                  `}` +
                  `}` +
                  `}` +
                  `if(${pVar})break;` +
                  `}` +
                  `}` +
                  `return ${pVar}?{...${pVar}}:{type:"tool_result",tool_use_id:${idVar},content:${contentExpr},is_error:!0}` +
                  `})`;
                edit(id, inner, replacement);
                pairingHandled = true;
              }
            }
          });
        }
      }
    }

    if ((node.type === 'MethodDefinition' || node.type === 'Property') &&
        propertyName(node) === 'getEnvironmentOverrides' && node.value?.body?.type === 'BlockStatement') {
      const statements = node.value.body.body;
      // Fix only the dead return that precedes the actual override reader.
      for (let i = 0; i < statements.length - 1; i++) {
        const statement = statements[i];
        const values = statement.argument?.expressions;
        const next = statements[i + 1];
        if (statement.type !== 'ReturnStatement' || values?.length !== 2) continue;
        const [assignment, result] = values;
        if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '=' ||
            !thisMember(assignment.left, 'environmentOverridesParsed') || !boolean(assignment.right, true) ||
            !thisMember(result, 'environmentOverrides') || next.type !== 'VariableDeclaration') continue;
        const readsOverrides = next.declarations.some(d => d.init?.type === 'CallExpression' &&
          member(d.init.callee, 'readEnvironmentOverrides') && thisMember(d.init.callee.object, 'deps'));
        if (readsOverrides) edit('growthbook-env-overrides-graph', statement,
          `${code.slice(assignment.start, assignment.end)};`);
      }
    }
  });
  if ([...wigglyLiterals].some(start => !wigglyHandled.has(start))) {
    results['wiggly-dove'].present = true;
    results['wiggly-dove'].matches = [];
  }
  if (code.includes('[Tool result missing due to internal error]') && !pairingHandled) {
    results['tool-result-pairing-recovery'].present = true;
    results['tool-result-pairing-recovery'].matches = [];
  }
  return results;
}

export function applyAstEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) throw new Error('Overlapping AST patch edits');
    parts.push(code.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(code.slice(cursor));
  return parts.join('');
}
