import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { CLICKUP_TOKEN, ISSUES_FILE, OUTPUT_FILE } = process.env;

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

function sentinel(sentryId) {
  return `<!-- sentry-issue-id: ${sentryId} -->`;
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

${sentinel(issue.id)}`;
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
      const match = desc.match(/<!-- sentry-issue-id: ([^>]+) -->/);
      if (match) {
        map.set(match[1], task.id);
      }
    }

    hasMore = data.last_page === false && tasks.length > 0;
    page++;
  }

  return map;
}

async function closeResolvedTasks(dedupMap, unresolvedIds) {
  for (const [sentryId, taskId] of dedupMap) {
    if (!unresolvedIds.has(sentryId)) {
      log(`Sentry issue ${sentryId} is resolved — closing ClickUp task ${taskId}`);
      try {
        await clickupRequest(`/task/${taskId}`, 'PUT', { status: 'closed' });
      } catch (err) {
        log(`  Warning: could not close task ${taskId}: ${err.message}`);
      }
    }
  }
}

async function main() {
  const issues = JSON.parse(readFileSync(ISSUES_FILE, 'utf8'));
  log(`Loaded ${issues.length} issues from ${ISSUES_FILE}`);

  log('Building dedup map from existing ClickUp tasks...');
  const dedupMap = await buildDedupMap();
  log(`Found ${dedupMap.size} existing sentry-linked tasks`);

  const unresolvedIds = new Set(issues.map((i) => i.id));
  await closeResolvedTasks(dedupMap, unresolvedIds);

  const taskMap = {};

  for (const issue of issues) {
    if (dedupMap.has(issue.id)) {
      const existingId = dedupMap.get(issue.id);
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
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(taskMap, null, 2));
  log(`Wrote task map to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
