import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installSh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');

assert.match(installSh, /Auto-mode unlock for third-party API \(legacy provider gate\)/);
assert.match(installSh, /Auto-mode unlock for third-party API \(env gate\)/);
assert.match(installSh, /Auto-mode unlock for third-party API \(model gate\)/);

const legacyProviderGate =
  'function wuH(H){let $=R7(H),q=Wq();if(q!=="firstParty"&&q!=="anthropicAws")return!1;if($.includes("claude-3-")||$.includes("sonnet"))return!0;return!1}';

const v2158AutoMode =
  'function iH6(H){if(H==="firstParty"||H==="anthropicAws")return!0;return bH(process.env.CLAUDE_CODE_ENABLE_AUTO_MODE)}function lgH(H){{let _=$7(H),q=Wq();if(!iH6(q))return!1;if(_.includes("claude-3-")||_==="claude-opus-4-0"||_==="claude-opus-4-1"||_==="claude-opus-4-5"||_==="claude-sonnet-4-0"||_==="claude-sonnet-4-5"||_==="claude-haiku-4-5")return!1;if(q!=="firstParty"&&q!=="anthropicAws"&&(_==="claude-opus-4-6"||_.includes("sonnet")||_.includes("haiku")))return!1;return!0}return!1}';

const legacyProviderPattern = /if\(([\w$]+)!=="firstParty"&&\1!=="anthropicAws"\)return!1;/g;
const envGatePattern = /if\(![\w$]+\(([\w$]+)\)\)return!1;/g;
const modelGatePattern = /if\(([\w$]+)!=="firstParty"&&\1!=="anthropicAws"&&\([\s\S]{1,180}?\)\)return!1;/g;

assert.equal([...legacyProviderGate.matchAll(legacyProviderPattern)].length, 1);
assert.equal([...v2158AutoMode.matchAll(envGatePattern)].length, 1);
assert.equal([...v2158AutoMode.matchAll(modelGatePattern)].length, 1);
