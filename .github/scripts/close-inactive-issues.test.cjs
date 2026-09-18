'use strict';
const assert = require('node:assert/strict');
const closeIssues = require('./close-inactive-issues.cjs');
const now = Date.parse('2026-09-18T12:00:00Z');
const daysAgo = (days) => new Date(now - days * 86400000).toISOString();
const issue = (number, age, replyAge) => ({ number, title: `Issue ${number}`, closed: false,
  createdAt: daysAgo(age), comments: { nodes: replyAge === undefined ? [] : [{ createdAt: daysAgo(replyAge) }] } });
const cutoff = now - 30 * 86400000;
assert.equal(closeIssues.inactive(issue(1, 30), cutoff), true, 'exactly 30 days qualifies');
assert.equal(closeIssues.inactive(issue(1, 29.99), cutoff), false);
assert.equal(closeIssues.inactive(issue(1, 90, 1), cutoff), false, 'new reply keeps an old issue open');
assert.equal(closeIssues.inactive({ ...issue(1, 90), updatedAt: daysAgo(0) }, cutoff), true, 'labels/edits do not reset reply age');
assert.equal(closeIssues.inactive({ ...issue(1, 90), createdAt: 'bad date' }, cutoff), false);

async function run(dryRun) {
  const changes = [];
  const pages = [
    [issue(1, 30), issue(2, 90, 31), issue(3, 90, 1)],
    [issue(4, 60), issue(5, 10), issue(6, 60, 30)],
  ];
  const fresh = { 1: issue(1, 30), 2: issue(2, 90, 0),
    4: { ...issue(4, 60), closed: true }, 6: issue(6, 60, 30) };
  const github = {
    graphql: async (_query, variables) => variables.number
      ? { repository: { issue: fresh[variables.number] } }
      : { repository: { issues: { nodes: pages[variables.cursor ? 1 : 0],
        pageInfo: { hasNextPage: !variables.cursor, endCursor: 'page2' } } } },
    rest: { issues: { update: async (args) => changes.push(args) } },
  };
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  const result = await closeIssues({ github, context: { repo: { owner: 'test', repo: 'repo' } },
    core: { info() {}, summary }, now, dryRun });
  assert.deepEqual(result.eligible, [1, 6], 'recheck excludes newly replied-to and already closed issues');
  assert.equal(result.closed, dryRun ? 0 : 2);
  assert.deepEqual(changes.map((x) => x.issue_number), dryRun ? [] : [1, 6]);
  for (const change of changes) assert.equal(change.state_reason, 'not_planned');
}
(async () => {
  await run(true);
  await run(false);
  console.log('inactive issue policy: age, replies, pagination, recheck and dry-run passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
