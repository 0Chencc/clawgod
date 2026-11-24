import { literal } from './common.mjs';

export const id = 'user-type-ant';
// The matcher reads a decoded string literal, so the source may spell it with
// escapes; only the full prefilter list keeps the module on the same files as
// the inline branch it replaced.
export { anchors } from './anchors.mjs';

export function scan({ nodes, edit }) {
  for (const fn of nodes('FunctionDeclaration')) {
    if (fn.params.length || fn.async || fn.generator) continue;
    const body = fn.body.body;
    if (body.length !== 1 || body[0].type !== 'ReturnStatement') continue;
    if (literal(body[0].argument, 'external')) edit(body[0].argument, '"ant"');
  }
}
