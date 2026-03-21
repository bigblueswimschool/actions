import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { CLICKUP_TOKEN, GH_TOKEN, TARGET_REPO, PARENT_TASK_ID, ALERTS_FILE, OUTPUT_FILE } = process.env;

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

const PRIORITY_MAP = { critical: 1, high: 2, medium: 3, low: 4 };

// Embeds alert number + package into the subtask description for dedup and PR-closing
function alertSentinel(number, packageName) {
  return `<!-- dependabot-alert-number: ${number} dependabot-package: ${packageName} -->`;
}

function buildSubtaskDescription(alert) {
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
 * Resolve a custom task ID (e.g. "DEV-20415") to the internal ClickUp UUID.
 * Raw numeric/alphanumeric IDs are returned as-is.
 */
async function resolveTaskId(idOrCustomId) {
  // Custom IDs look like "PREFIX-NUMBER" (e.g. DEV-20415)
  if (/^[A-Z]+-\d+$/i.test(idOrCustomId)) {
    const { teams } = await clickupRequest('/team');
    if (!teams?.length) throw new Error('No teams found — cannot resolve custom task ID');
    const teamId = teams[0].id;
    const task = await clickupRequest(
      `/task/${encodeURIComponent(idOrCustomId)}?custom_task_ids=true&team_id=${teamId}`,
    );
    log(`Resolved ${idOrCustomId} → ${task.id}`);
    return task.id;
  }
  return idOrCustomId;
}

/**
 * Fetch all existing subtasks of the parent task and return a map of
 * alertNumber → { taskId, package } for deduplication.
 */
async function buildDedupMap(parentId) {
  const map = new Map();

  const task = await clickupRequest(`/task/${parentId}?include_subtasks=true`);
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
  const alerts = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
  log(`Loaded ${alerts.length} alerts from ${ALERTS_FILE}`);

  log(`Resolving parent task ID: ${PARENT_TASK_ID}`);
  const parentId = await resolveTaskId(PARENT_TASK_ID);

  log('Fetching existing subtasks for dedup...');
  const dedupMap = await buildDedupMap(parentId);
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
    log(`Creating subtask: ${subtaskName}`);

    const subtask = await clickupRequest(`/list/${CLICKUP_LIST_ID}/task`, 'POST', {
      name: subtaskName,
      description: buildSubtaskDescription(alert),
      priority: PRIORITY_MAP[alert.severity] ?? 3,
      parent: parentId,
      tags: ['dependabot', 'auto-triage', alert.ecosystem],
    });

    log(`Created subtask ${subtask.id} for alert #${alert.number}`);
    taskMap[alert.number] = subtask.id;
    newAlertNumbers.push(alert.number);
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
