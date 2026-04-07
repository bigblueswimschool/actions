import { readFileSync, writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const {
  ANTHROPIC_API_KEY,
  ALERTS_FILE,
  CLICKUP_TASKS_FILE,
  OUTPUT_FILE,
} = process.env;

const MANIFEST_MAX_BYTES = 30 * 1024; // 30KB — enough for any manifest file


function buildPrompt(alert) {
  const manifestContent = alert.manifestContent
    ? alert.manifestContent.slice(0, MANIFEST_MAX_BYTES)
    : '(manifest content unavailable)';
  const truncated = alert.manifestContent && alert.manifestContent.length > MANIFEST_MAX_BYTES;

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

## Manifest File (${alert.manifestPath})${truncated ? ' — truncated to 30KB' : ''}
\`\`\`
${manifestContent}
\`\`\`

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

async function main() {
  const allAlerts = JSON.parse(readFileSync(ALERTS_FILE, 'utf8'));
  const { newAlertNumbers } = JSON.parse(readFileSync(CLICKUP_TASKS_FILE, 'utf8'));
  const newNumbers = new Set(newAlertNumbers);

  const alerts = allAlerts.filter((a) => newNumbers.has(a.number));
  log(
    `${alerts.length} new alert(s) to propose fixes for (${allAlerts.length - alerts.length} already processed — skipping)`,
  );

  const proposals = [];

  for (const alert of alerts) {
    log(`Proposing fix for alert #${alert.number}: ${alert.package} (${alert.severity})`);

    const prompt = buildPrompt(alert);

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
