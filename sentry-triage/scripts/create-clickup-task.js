import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { CLICKUP_TOKEN, SENTRY_TOKEN, SENTRY_ORG, GH_TOKEN, TARGET_REPO, ISSUES_FILE, OUTPUT_FILE } = process.env;

// Accept either the bare numeric ID ("381197225") or the ClickUp view format ("6-381197225-1")
const CLICKUP_LIST_ID = (process.env.CLICKUP_LIST_ID ?? '').replace(/^\d+-(\d+)-\d+$/, '$1');

async function clickupRequest(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, {
    method,
    headers: {
      Authorization: CLICKUP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ClickUp ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json();
}

const PRIORITY_MAP = { fatal: 1, error: 2, warning: 3, info: 4 };

function sentinel(sentryId, shortId) {
  return `<!-- sentry-issue-id: ${sentryId} sentry-short-id: ${shortId} -->`;
}

function buildDescription(issue) {
  const topFrames = issue.frames.slice(0, 3);
  const frameBlock = topFrames
    .map((f) => `  ${f.filename}:${f.lineNo} — ${f.function}`)
    .join('\n');

  return `## [${issue.shortId}](${issue.permalink})

**Level:** ${issue.level}
**First seen:** ${issue.firstSeen}
**Last seen:** ${issue.lastSeen}
**Event count:** ${issue.count}
**Culprit:** ${issue.culprit}

### Top Stack Frames
\`\`\`
${frameBlock || '  (no in-app frames)'}
\`\`\`

${sentinel(issue.id, issue.shortId)}`;
}

async function sentryRequest(path, method = 'GET', body = null) {
  const res = await fetch(`https://sentry.io/api/0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SENTRY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sentry ${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json();
}

async function fetchClickUpIntegrationId() {
  const integrations = await sentryRequest(
    `/organizations/${SENTRY_ORG}/integrations/?provider_key=clickup`,
  );
  const integration = integrations?.[0];
  if (!integration) throw new Error(`No ClickUp integration found for org ${SENTRY_ORG}`);
  log(`Found ClickUp integration: ${integration.id} (${integration.name})`);
  return integration.id;
}

async function linkSentryIssue(issueId, integrationId, clickupTaskId, clickupTaskUrl) {
  try {
    await sentryRequest(`/issues/${issueId}/external-issues/`, 'POST', {
      integration_id: integrationId,
      external_issue_key: clickupTaskId,
      external_url: clickupTaskUrl,
    });
    log(`  Linked Sentry issue ${issueId} → ClickUp task ${clickupTaskId}`);
  } catch (err) {
    log(`  Warning: could not link Sentry issue ${issueId}: ${err.message}`);
  }
}

async function buildDedupMap() {
  const map = new Map();

  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupRequest(
      `/list/${CLICKUP_LIST_ID}/task?page=${page}&include_closed=false`,
    );

    const tasks = data.tasks ?? [];
    for (const task of tasks) {
      const desc = task.description ?? '';
      const match = desc.match(/<!-- sentry-issue-id: (\S+) sentry-short-id: (\S+) -->/);
      if (match) {
        map.set(match[1], { taskId: task.id, shortId: match[2] });
      }
    }

    hasMore = data.last_page === false && tasks.length > 0;
    page++;
  }

  return map;
}

async function closePR(shortId) {
  if (!GH_TOKEN || !TARGET_REPO) return;
  const [owner, repo] = TARGET_REPO.split('/');
  const branch = `sentry-triage/${shortId.toLowerCase()}`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const prs = await res.json();
    if (!prs.length) return;

    const pr = prs[0];
    await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: 'closed' }),
    });
    log(`  Closed PR #${pr.number} for branch ${branch}`);
  } catch (err) {
    log(`  Warning: could not close PR for ${shortId}: ${err.message}`);
  }
}

async function closeResolvedTasks(dedupMap, unresolvedIds) {
  for (const [sentryId, { taskId, shortId }] of dedupMap) {
    if (!unresolvedIds.has(sentryId)) {
      log(`Sentry issue ${sentryId} (${shortId}) is resolved — closing ClickUp task and PR`);
      try {
        await clickupRequest(`/task/${taskId}`, 'PUT', { status: 'closed' });
      } catch (err) {
        log(`  Warning: could not close task ${taskId}: ${err.message}`);
      }
      await closePR(shortId);
    }
  }
}

async function main() {
  const issues = JSON.parse(readFileSync(ISSUES_FILE, 'utf8'));
  log(`Loaded ${issues.length} issues from ${ISSUES_FILE}`);

  const integrationId = await fetchClickUpIntegrationId();

  log('Building dedup map from existing ClickUp tasks...');
  const dedupMap = await buildDedupMap();
  log(`Found ${dedupMap.size} existing sentry-linked tasks`);

  const unresolvedIds = new Set(issues.map((i) => i.id));
  await closeResolvedTasks(dedupMap, unresolvedIds);

  const taskMap = {};
  const newSentryIds = [];

  for (const issue of issues) {
    if (dedupMap.has(issue.id)) {
      const { taskId: existingId } = dedupMap.get(issue.id);
      log(`Issue ${issue.shortId} already has ClickUp task ${existingId} — skipping`);
      taskMap[issue.id] = existingId;
      continue;
    }

    log(`Creating ClickUp task for ${issue.shortId}: ${issue.title}`);

    const task = await clickupRequest(`/list/${CLICKUP_LIST_ID}/task`, 'POST', {
      name: `[Sentry] ${issue.title}`,
      description: buildDescription(issue),
      priority: PRIORITY_MAP[issue.level] ?? 2,
      tags: ['sentry', 'auto-triage'],
    });

    log(`Created task ${task.id} for issue ${issue.shortId}`);
    taskMap[issue.id] = task.id;
    newSentryIds.push(issue.id);

    await linkSentryIssue(issue.id, integrationId, task.id, `https://app.clickup.com/t/${task.id}`);
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify({ taskMap, newSentryIds }, null, 2));
  log(`Wrote task map to ${OUTPUT_FILE} (${newSentryIds.length} new, ${issues.length - newSentryIds.length} existing)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
