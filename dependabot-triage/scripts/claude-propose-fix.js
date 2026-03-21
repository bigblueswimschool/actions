import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';
import { githubRequest } from './utils/github.js';

const {
  ANTHROPIC_API_KEY,
  GH_TOKEN,
  TARGET_REPO,
  ALERTS_FILE,
  CLICKUP_TASKS_FILE,
  OUTPUT_FILE,
} = process.env;

const LOCKFILE_MAX_BYTES = 50 * 1024; // 50KB

async function fetchFileContent(owner, repo, filePath) {
  try {
    const data = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
    );
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return content;
  } catch (err) {
    if (err.message.includes('404')) return null;
    log(`  Warning: could not fetch ${filePath}: ${err.message}`);
    return null;
  }
}

function buildPrompt(alert, lockfileContent) {
  const lockfileSection = lockfileContent
    ? `\n## Lockfile (truncated if > 50KB)\n\`\`\`\n${lockfileContent.slice(0, LOCKFILE_MAX_BYTES)}\n\`\`\``
    : '';

  return `You are a security engineer performing automated dependency triage.

## Dependabot Alert #${alert.number}
- **Package:** ${alert.package}
- **Ecosystem:** ${alert.ecosystem}
- **CVE ID:** ${alert.cveId ?? 'N/A'}
- **Severity:** ${alert.severity}
- **CVSS Score:** ${alert.cvss ?? 'N/A'}
- **Vulnerable Range:** ${alert.vulnerableRange ?? 'unknown'}
- **Patched Version:** ${alert.patchedVersion ?? 'unknown'}
- **Manifest Path:** ${alert.manifestPath}
- **Summary:** ${alert.summary}

## Manifest File (${alert.manifestPath})
\`\`\`
${alert.manifestContent ?? '(manifest content unavailable)'}
\`\`\`
${lockfileSection}

---

## Critical Rules

1. **Only modify the manifest file provided** — never invent new files or propose changes to files not shown above.
2. **Only bump the specific vulnerable package** (${alert.package}) to \`${alert.patchedVersion ?? 'the minimum safe version'}\` or a semver-compatible minimum safe version. Do not change any other dependencies.
3. **The "oldCode" in patches must be an EXACT substring** of the manifest content shown above. Copy it character-for-character, including surrounding quotes and version specifiers.
4. **Never modify unrelated dependencies** — even if you notice other outdated packages.
5. **If the patched version would break a peer dependency** visible in the manifest, set confidence to "low" and explain in the prBody.
6. **If the manifest content is unavailable**, set confidence to "low" and explain what you would need.

Respond ONLY with valid JSON matching this exact schema — no preamble, no markdown fences:
{
  "rootCause": "one sentence describing the vulnerability",
  "confidence": "high | medium | low",
  "fix": {
    "description": "what the version bump does and why it is safe",
    "patches": [
      {
        "file": "${alert.manifestPath}",
        "oldCode": "exact string from manifest to replace",
        "newCode": "replacement string"
      }
    ]
  },
  "prTitle": "fix(deps): bump ${alert.package} to safe version (under 72 chars)",
  "prBody": "markdown PR description with vulnerability summary and upgrade rationale"
}`;
}

function parseResponse(text) {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(stripped);
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API → ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

async function fetchLockfile(owner, repo, ecosystem) {
  if (ecosystem !== 'npm') return null;

  const yarnLock = await fetchFileContent(owner, repo, 'yarn.lock');
  if (yarnLock !== null) return yarnLock;

  const packageLock = await fetchFileContent(owner, repo, 'package-lock.json');
  return packageLock;
}

async function main() {
  const allAlerts = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
  const { newAlertNumbers } = JSON.parse(readFileSync(CLICKUP_TASKS_FILE, 'utf8'));
  const newNumbers = new Set(newAlertNumbers);

  const alerts = allAlerts.filter((a) => newNumbers.has(a.number));
  log(
    `${alerts.length} new alert(s) to propose fixes for (${allAlerts.length - alerts.length} already processed — skipping)`,
  );

  const [owner, repo] = TARGET_REPO.split('/');
  const proposals = [];

  for (const alert of alerts) {
    log(`Proposing fix for alert #${alert.number}: ${alert.package} (${alert.severity})`);

    const lockfileContent = await fetchLockfile(owner, repo, alert.ecosystem);
    if (lockfileContent) {
      log(`  Fetched lockfile for ${alert.ecosystem}`);
    }

    const prompt = buildPrompt(alert, lockfileContent);

    let parsed;
    try {
      const raw = await callClaude(prompt);
      parsed = parseResponse(raw);
    } catch (err) {
      log(`  Error getting/parsing Claude response for alert #${alert.number}: ${err.message}`);
      parsed = {
        rootCause: 'Unable to determine — Claude response parse error',
        confidence: 'low',
        fix: { description: 'Manual investigation required', patches: [] },
        prTitle: `fix(deps): bump ${alert.package} (alert #${alert.number})`,
        prBody: `Automated analysis failed for [Dependabot alert #${alert.number}](${alert.permalink}).\n\nManual investigation required.`,
      };
    }

    proposals.push({
      alertNumber: alert.number,
      package: alert.package,
      ecosystem: alert.ecosystem,
      manifestPath: alert.manifestPath,
      severity: alert.severity,
      cveId: alert.cveId,
      permalink: alert.permalink,
      ...parsed,
    });
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(proposals, null, 2));
  log(`Wrote ${proposals.length} proposals to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
