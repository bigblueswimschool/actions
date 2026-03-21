import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { CLICKUP_TOKEN, GH_TOKEN, TARGET_REPO, ALERTS_FILE, OUTPUT_FILE } = process.env;

// Accept either the bare numeric ID ("381197225") or the ClickUp view format ("6-381197225-1")
const CLICKUP_LIST_ID = (process.env.CLICKUP_LIST_ID ?? '').replace(/^\d+-(\d+)-\d+$/, '$1');

// Identifies the single omnibus task for this repo's Dependabot alerts
const OMNIBUS_SENTINEL = '<!-- dependabot-triage-omnibus -->';

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
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function highestPriority(alerts) {
  let max = 4;
  for (const alert of alerts) {
    const p = PRIORITY_MAP[alert.severity] ?? 3;
    if (p < max) max = p;
  }
  return max;
}

// Embeds alert number + package so we can reconstruct branch names for PR closing
function alertSentinel(number, packageName) {
  return `<!-- dependabot-alert-number: ${number} dependabot-package: ${packageName} -->`;
}

function buildAlertEntry(alert) {
  return `### [Alert #${alert.number}](${alert.permalink}): \`${alert.package}\` — ${alert.severity}${alert.cveId ? ` (${alert.cveId})` : ''}

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

function buildInitialDescription(alerts) {
  const entries = alerts.map(buildAlertEntry).join('\n\n---\n\n');
  return `## Open Dependabot Security Alerts

This task tracks all open Dependabot security alerts. New alerts are automatically appended when the workflow runs.

---

${entries}

${OMNIBUS_SENTINEL}`;
}

/** Parse all alert numbers already listed in the task description. */
function parseListedAlerts(description) {
  const map = new Map(); // number → packageName
  for (const match of description.matchAll(
    /<!-- dependabot-alert-number: (\d+) dependabot-package: (\S+) -->/g,
  )) {
    map.set(Number(match[1]), match[2]);
  }
  return map;
}

/** Find the existing omnibus task (open tasks only). */
async function findOmnibusTask() {
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupRequest(
      `/list/${CLICKUP_LIST_ID}/task?page=${page}&include_closed=false`,
    );
    const tasks = data.tasks ?? [];

    for (const task of tasks) {
      if ((task.description ?? '').includes(OMNIBUS_SENTINEL)) {
        return task;
      }
    }

    hasMore = data.last_page === false && tasks.length > 0;
    page++;
  }

  return null;
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

async function main() {
  const alerts = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
  log(`Loaded ${alerts.length} alerts from ${ALERTS_FILE}`);

  log('Looking for existing omnibus Dependabot task...');
  const existingTask = await findOmnibusTask();

  const openAlertNumbers = new Set(alerts.map((a) => a.number));

  // No open alerts — close the omnibus task if it exists
  if (alerts.length === 0) {
    if (existingTask) {
      log('No open alerts — closing omnibus task');
      await clickupRequest(`/task/${existingTask.id}`, 'PUT', { status: 'closed' });
    } else {
      log('No open alerts and no existing task — nothing to do');
    }
    writeFileSync(OUTPUT_FILE, JSON.stringify({ taskMap: {}, newAlertNumbers: [] }, null, 2));
    return;
  }

  let taskId;
  let newAlertNumbers;

  if (!existingTask) {
    // Create brand-new omnibus task with all current alerts
    log(`Creating omnibus task for ${alerts.length} alert(s)`);
    const task = await clickupRequest(`/list/${CLICKUP_LIST_ID}/task`, 'POST', {
      name: '[Dependabot] Security Alerts',
      description: buildInitialDescription(alerts),
      priority: highestPriority(alerts),
      tags: ['dependabot', 'auto-triage'],
    });
    log(`Created task ${task.id}`);
    taskId = task.id;
    newAlertNumbers = alerts.map((a) => a.number);
  } else {
    taskId = existingTask.id;
    log(`Found existing omnibus task ${taskId}`);

    const listedAlerts = parseListedAlerts(existingTask.description ?? '');
    log(`Task already lists ${listedAlerts.size} alert(s)`);

    // Close PRs for alerts that are no longer open
    for (const [number, packageName] of listedAlerts) {
      if (!openAlertNumbers.has(number)) {
        log(`Alert #${number} is resolved — closing its PR`);
        await closePR(number, packageName);
      }
    }

    // Append entries for alerts not yet in the description
    const newAlerts = alerts.filter((a) => !listedAlerts.has(a.number));
    newAlertNumbers = newAlerts.map((a) => a.number);

    if (newAlerts.length > 0) {
      log(`Appending ${newAlerts.length} new alert(s) to task ${taskId}`);
      const appendedEntries = newAlerts.map(buildAlertEntry).join('\n\n---\n\n');
      // Insert new entries just before the omnibus sentinel
      const updatedDescription = (existingTask.description ?? '').replace(
        OMNIBUS_SENTINEL,
        `---\n\n${appendedEntries}\n\n${OMNIBUS_SENTINEL}`,
      );
      await clickupRequest(`/task/${taskId}`, 'PUT', {
        description: updatedDescription,
        priority: highestPriority(alerts),
      });
      log(`Updated task ${taskId}`);
    } else {
      log('No new alerts to append');
    }
  }

  // All alerts share the single omnibus task ID
  const taskMap = Object.fromEntries(alerts.map((a) => [a.number, taskId]));

  writeFileSync(OUTPUT_FILE, JSON.stringify({ taskMap, newAlertNumbers }, null, 2));
  log(
    `Wrote task map to ${OUTPUT_FILE} (${newAlertNumbers.length} new, ${alerts.length - newAlertNumbers.length} existing)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
