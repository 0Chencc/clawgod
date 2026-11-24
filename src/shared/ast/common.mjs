// Syntax helpers shared by migrated patch modules and the module engine.
export const literal = (node, value) => node?.type === 'Literal' && node.value === value;

// Iterative traversal avoids adding a second call stack limit to large bundles.
export function walk(root, visit) {
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
