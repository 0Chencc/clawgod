import { parse } from './acorn.mjs';

export const AST_PATCH_IDS = [
  'user-type-ant', 'bun-standalone-executable', 'growthbook-env-overrides-graph',
  'computer-use-default', 'ultraplan', 'voice-mode',
  'geo-stego-date',
];

const anchors = ['external', 'isStandaloneExecutable', 'environmentOverridesParsed',
  'pixelValidation', 'ultraplan', 'tengu_amber_quartz_disabled', 's date is '];
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

function hasGate(node, id) {
  let found = false;
  walk(node, child => {
    if (member(child, id) && member(child.object, '__clawgodPatches') &&
        child.object.object.name === 'globalThis') found = true;
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

  walk(tree, node => {
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
