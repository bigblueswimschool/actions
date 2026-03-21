import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { CLICKUP_TOKEN, GH_TOKEN, TARGET_REPO, ALERTS_FILE, OUTPUT_FILE } = process.env;

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

function sentinel(number, packageName, ecosystem) {
  return `<!-- dependabot-alert-number: ${number} dependabot-package: ${packageName} dependabot-ecosystem: ${ecosystem} -->`;
}

function buildDescription(alert) {
  return `## [Dependabot Alert #${alert.number}](${alert.permalink})

**Package:** ${alert.package}
**Ecosystem:** ${alert.ecosystem}
**CVE ID:** ${alert.cveId ?? 'N/A'}
**Severity:** ${alert.severity}
**CVSS Score:** ${alert.cvss ?? 'N/A'}
**Vulnerable Range:** ${alert.vulnerableRange ?? 'N/A'}
**Patched Version:** ${alert.patchedVersion ?? 'N/A'}
**Manifest Path:** ${alert.manifestPath ?? 'N/A'}

### Summary
${alert.summary}

${sentinel(alert.number, alert.package, alert.ecosystem)}`;
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
      const match = desc.match(
        /<!-- dependabot-alert-number: (\d+) dependabot-package: (\S+) dependabot-ecosystem: (\S+) -->/,
      );
      if (match) {
        map.set(Number(match[1]), {
          taskId: task.id,
          package: match[2],
          ecosystem: match[3],
        });
      }
    }

    hasMore = data.last_page === false && tasks.length > 0;
    page++;
  }

  return map;
}

async function closePR(alertNumber, packageName) {
  if (!GH_TOKEN || !TARGET_REPO) return;
  const [owner, repo] = TARGET_REPO.split('/');
  const branch = `dependabot-triage/${packageName.toLowerCase().replace(/\//g, '-')}-${alertNumber}`;

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

async function closeResolvedTasks(dedupMap, openAlertNumbers) {
  for (const [alertNumber, { taskId, package: pkg }] of dedupMap) {
    if (!openAlertNumbers.has(alertNumber)) {
      log(`Alert #${alertNumber} is resolved — closing ClickUp task and PR`);
      try {
        await clickupRequest(`/task/${taskId}`, 'PUT', { status: 'closed' });
      } catch (err) {
        log(`  Warning: could not close task ${taskId}: ${err.message}`);
      }
      await closePR(alertNumber, pkg);
    }
  }
}

async function main() {
  const alerts = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
  log(`Loaded ${alerts.length} alerts from ${ALERTS_FILE}`);

  log('Building dedup map from existing ClickUp tasks...');
  const dedupMap = await buildDedupMap();
  log(`Found ${dedupMap.size} existing dependabot-linked tasks`);

  const openAlertNumbers = new Set(alerts.map((a) => a.number));
  await closeResolvedTasks(dedupMap, openAlertNumbers);

  const taskMap = {};
  const newAlertNumbers = [];

  for (const alert of alerts) {
    if (dedupMap.has(alert.number)) {
      const { taskId: existingId } = dedupMap.get(alert.number);
      log(`Alert #${alert.number} (${alert.package}) already has ClickUp task ${existingId} — skipping`);
      taskMap[alert.number] = existingId;
      continue;
    }

    const taskName = `[Dependabot] ${alert.package} — ${alert.severity} vulnerability${alert.cveId ? ` (${alert.cveId})` : ''}`;
    log(`Creating ClickUp task: ${taskName}`);

    const task = await clickupRequest(`/list/${CLICKUP_LIST_ID}/task`, 'POST', {
      name: taskName,
      description: buildDescription(alert),
      priority: PRIORITY_MAP[alert.severity] ?? 3,
      tags: ['dependabot', 'auto-triage', alert.ecosystem],
    });

    log(`Created task ${task.id} for alert #${alert.number}`);
    taskMap[alert.number] = task.id;
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
