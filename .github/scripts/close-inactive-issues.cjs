'use strict';

const DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function lastReplyAt(issue) {
  return Date.parse(issue.comments.nodes.at(-1)?.createdAt ?? issue.createdAt);
}

function inactive(issue, cutoff) {
  const last = lastReplyAt(issue);
  return !issue.closed && Number.isFinite(last) && last <= cutoff;
}

module.exports = async function closeInactiveIssues({ github, context, core, dryRun, now = Date.now() }) {
  const cutoff = now - DAYS * MS_PER_DAY;
  const repo = { owner: context.repo.owner, name: context.repo.repo };
  const candidates = [];
  let cursor = null;
  do {
    // GraphQL's issues connection excludes pull requests. Order by creation
    // so labels, edits, and our own closing actions cannot reshuffle pages.
    const result = await github.graphql(`query($owner:String!, $name:String!, $cursor:String) {
      repository(owner:$owner, name:$name) {
        issues(first:100, after:$cursor, states:OPEN, orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { number title createdAt closed comments(last:1) { nodes { createdAt } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, { ...repo, cursor });
    const page = result.repository.issues;
    candidates.push(...page.nodes.filter((issue) => inactive(issue, cutoff)));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  let closed = 0;
  const confirmed = [];
  for (const candidate of candidates) {
    // A reply may have arrived while we scanned the repository. Re-read the
    // issue immediately before closing; comment edits/labels are not replies.
    const result = await github.graphql(`query($owner:String!, $name:String!, $number:Int!) {
      repository(owner:$owner, name:$name) {
        issue(number:$number) {
          number title createdAt closed comments(last:1) { nodes { createdAt } }
        }
      }
    }`, { ...repo, number: candidate.number });
    const issue = result.repository.issue;
    if (!issue || !inactive(issue, cutoff)) {
      core.info(`Skip #${candidate.number}: closed or received a newer reply`);
      continue;
    }
    core.info(`${dryRun ? 'Would close' : 'Closing'} #${issue.number}: ${issue.title}`);
    confirmed.push(issue.number);
    if (!dryRun) {
      // Inactivity is not evidence that the reported bug has been fixed.
      await github.rest.issues.update({ ...context.repo, issue_number: issue.number,
        state: 'closed', state_reason: 'not_planned' });
      closed++;
    }
  }
  await core.summary.addHeading('Inactive issues')
    .addRaw(`Policy: ${DAYS} days since the last reply, or creation if there are no replies.\n\n`)
    .addRaw(`Cutoff: ${new Date(cutoff).toISOString()}\n\n`)
    .addRaw(`Mode: ${dryRun ? 'dry run' : 'close'}; eligible: ${confirmed.length}; closed: ${closed}.\n\n`)
    .addRaw(confirmed.map((number) => `#${number}`).join(', ') || 'No eligible issues.')
    .write();
  return { eligible: confirmed, closed };
};
module.exports.lastReplyAt = lastReplyAt;
module.exports.inactive = inactive;
