import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { CLICKUP_TOKEN, GH_TOKEN, TARGET_REPO, PARENT_TASK_ID, ALERTS_FILE, OUTPUT_FILE } = process.env;

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

const PRIORITY_MAP = { critical: 1, high: 2, medium: 3, low: 4 };

// Identifies the per-repo task within the parent
function repoSentinel(repo) {
  return `<!-- dependabot-triage-repo: ${repo} -->`;
}

// Identifies each alert subtask within the repo task
function alertSentinel(number, packageName) {
  return `<!-- dependabot-alert-number: ${number} dependabot-package: ${packageName} -->`;
}

function buildRepoTaskDescription(repo) {
  return `Dependabot security alerts for **${repo}**. Each open alert is tracked as a subtask below.

${repoSentinel(repo)}`;
}

function buildAlertSubtaskDescription(alert) {
  return `## [Dependabot Alert #${alert.number}](${alert.permalink})

| Field | Value |
|---|---|
| **Ecosystem** | ${alert.ecosystem} |
| **CVE ID** | ${alert.cveId ?? 'N/A'} |
| **CVSS Score** | ${alert.cvss ?? 'N/A'} |
| **Vulnerable Range** | ${alert.vulnerableRange ?? 'N/A'} |
| **Patched Version** | ${alert.patchedVersion ?? 'N/A'} |
| **Manifest** | \`${alert.manifestPath ?? 'N/A'}\` |

${alert.summary}

${alertSentinel(alert.number, alert.package)}`;
}

/**
 * Resolve a custom task ID (e.g. "DEV-20415") to the internal ClickUp UUID
 * and return the task's list ID so subtasks can be created in the same list.
 */
async function resolveParentTask(idOrCustomId) {
  let task;
  if (/^[A-Z]+-\d+$/i.test(idOrCustomId)) {
    const { teams } = await clickupRequest('/team');
    if (!teams?.length) throw new Error('No teams found — cannot resolve custom task ID');
    const teamId = teams[0].id;
    task = await clickupRequest(
      `/task/${encodeURIComponent(idOrCustomId)}?custom_task_ids=true&team_id=${teamId}`,
    );
    log(`Resolved ${idOrCustomId} → ${task.id}`);
  } else {
    task = await clickupRequest(`/task/${idOrCustomId}`);
  }
  return { id: task.id, listId: task.list?.id };
}

/**
 * Find the existing repo-level task under the parent, or create it.
 * Returns the repo task ID.
 */
async function findOrCreateRepoTask(parentId, listId, repo) {
  const parent = await clickupRequest(`/task/${parentId}?include_subtasks=true`);
  const subtasks = parent.subtasks ?? [];

  for (const subtask of subtasks) {
    if ((subtask.description ?? '').includes(repoSentinel(repo))) {
      log(`Found existing repo task ${subtask.id} for ${repo}`);
      return subtask.id;
    }
  }

  log(`Creating repo task for ${repo}`);
  const task = await clickupRequest(`/list/${listId}/task`, 'POST', {
    name: `[Dependabot] ${repo}`,
    description: buildRepoTaskDescription(repo),
    parent: parentId,
    tags: ['dependabot', 'auto-triage'],
  });
  log(`Created repo task ${task.id}`);
  return task.id;
}

/**
 * Fetch subtasks of the repo task and return a map of
 * alertNumber → { taskId, package } for deduplication.
 */
async function buildDedupMap(repoTaskId) {
  const map = new Map();

  const task = await clickupRequest(`/task/${repoTaskId}?include_subtasks=true`);
  const subtasks = task.subtasks ?? [];

  for (const subtask of subtasks) {
    const desc = subtask.description ?? '';
    const match = desc.match(
      /<!-- dependabot-alert-number: (\d+) dependabot-package: (\S+) -->/,
    );
    if (match) {
      map.set(Number(match[1]), { taskId: subtask.id, package: match[2] });
    }
  }

  return map;
}

async function closePR(alertNumber, packageName) {
  if (!GH_TOKEN || !TARGET_REPO) return;
  const [owner, repo] = TARGET_REPO.split('/');
  const branch = `dependabot-triage/${packageName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${alertNumber}`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
      {
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
      },
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
    log(`  Warning: could not close PR for alert #${alertNumber}: ${err.message}`);
  }
}

async function closeResolvedSubtasks(dedupMap, openAlertNumbers) {
  for (const [alertNumber, { taskId, package: pkg }] of dedupMap) {
    if (!openAlertNumbers.has(alertNumber)) {
      log(`Alert #${alertNumber} is resolved — closing subtask ${taskId} and its PR`);
      try {
        await clickupRequest(`/task/${taskId}`, 'PUT', { status: 'closed' });
      } catch (err) {
        log(`  Warning: could not close subtask ${taskId}: ${err.message}`);
      }
      await closePR(alertNumber, pkg);
    }
  }
}

async function main() {
  if (!PARENT_TASK_ID) {
    throw new Error(
      'PARENT_TASK_ID is not set. Add parent_task_id to your workflow inputs (e.g. vars.CLICKUP_DEPENDABOT_TASK_ID).',
    );
  }

  const alerts = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
  log(`Loaded ${alerts.length} alerts from ${ALERTS_FILE}`);

  log(`Resolving parent task ID: ${PARENT_TASK_ID}`);
  const { id: parentId, listId } = await resolveParentTask(PARENT_TASK_ID);

  log(`Finding or creating repo task for ${TARGET_REPO} under ${parentId}`);
  const repoTaskId = await findOrCreateRepoTask(parentId, listId, TARGET_REPO);

  log('Fetching existing alert subtasks for dedup...');
  const dedupMap = await buildDedupMap(repoTaskId);
  log(`Found ${dedupMap.size} existing alert subtask(s)`);

  const openAlertNumbers = new Set(alerts.map((a) => a.number));
  await closeResolvedSubtasks(dedupMap, openAlertNumbers);

  const taskMap = {};
  const newAlertNumbers = [];

  for (const alert of alerts) {
    if (dedupMap.has(alert.number)) {
      const { taskId: existingId } = dedupMap.get(alert.number);
      log(`Alert #${alert.number} (${alert.package}) already has subtask ${existingId} — skipping`);
      taskMap[alert.number] = existingId;
      continue;
    }

    const subtaskName = `[Alert #${alert.number}] ${alert.package} — ${alert.severity}${alert.cveId ? ` (${alert.cveId})` : ''}`;
    log(`Creating alert subtask: ${subtaskName}`);

    const subtask = await clickupRequest(`/list/${listId}/task`, 'POST', {
      name: subtaskName,
      description: buildAlertSubtaskDescription(alert),
      priority: PRIORITY_MAP[alert.severity] ?? 3,
      parent: repoTaskId,
      tags: ['dependabot', 'auto-triage', alert.ecosystem],
    });

    log(`Created subtask ${subtask.id} for alert #${alert.number}`);
    taskMap[alert.number] = subtask.id;
    newAlertNumbers.push(alert.number);
  }

  // Close the repo task itself if all alerts are resolved
  if (alerts.length === 0 && dedupMap.size > 0) {
    log(`All alerts resolved — closing repo task ${repoTaskId}`);
    try {
      await clickupRequest(`/task/${repoTaskId}`, 'PUT', { status: 'closed' });
    } catch (err) {
      log(`  Warning: could not close repo task ${repoTaskId}: ${err.message}`);
    }
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify({ taskMap, newAlertNumbers }, null, 2));
  log(
    `Wrote task map to ${OUTPUT_FILE} (${newAlertNumbers.length} new, ${alerts.length - newAlertNumbers.length} existing)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
