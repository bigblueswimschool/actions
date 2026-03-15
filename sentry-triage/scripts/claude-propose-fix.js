import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { log } from './utils/logger.js';

const { ANTHROPIC_API_KEY, ISSUES_FILE, CLICKUP_TASKS_FILE, TARGET_REPO_PATH, OUTPUT_FILE } = process.env;

const STRIP_PREFIXES = ['', '/app/', '/home/user/project/', '/'];

function resolveFile(filename, repoPath) {
  const normalized = filename.replace(/^\//, '');

  for (const prefix of STRIP_PREFIXES) {
    const candidate = join(repoPath, normalized.replace(new RegExp(`^${prefix.replace('/', '\\/')}`), ''));
    if (existsSync(candidate)) return candidate;
  }

  // Try stripping any leading path segments that look like container mounts
  const segments = normalized.split('/');
  for (let i = 1; i < segments.length; i++) {
    const candidate = join(repoPath, segments.slice(i).join('/'));
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to src/{basename}
  const fallback = join(repoPath, 'src', basename(filename));
  if (existsSync(fallback)) return fallback;

  return null;
}

function buildPrompt(issue, sourceFiles) {
  const frameLines = issue.frames
    .map((f) => `  ${f.filename}:${f.lineNo} — ${f.function}`)
    .join('\n');

  const exceptionBlock = (() => {
    const values = issue.exception?.values ?? [];
    if (!values.length) return '(no exception data)';
    return values
      .map((v) => `${v.type ?? 'Error'}: ${v.value ?? ''}`)
      .join('\n');
  })();

  const sourceBlock = sourceFiles.length
    ? sourceFiles
        .map((sf) => `### ${sf.filename}\n\`\`\`typescript\n${sf.content}\n\`\`\``)
        .join('\n\n')
    : '(no source files resolved — stack-trace-only analysis)';

  return `You are a senior NestJS/TypeScript engineer performing automated bug triage.

## Sentry Issue
- **ID:** ${issue.shortId}
- **Title:** ${issue.title}
- **Culprit:** ${issue.culprit}
- **Level:** ${issue.level}
- **Event count:** ${issue.count}
- **Last seen:** ${issue.lastSeen}

## Exception
${exceptionBlock}

## Stack Frames (in-app only)
${frameLines || '  (none)'}

## Relevant Source Files
${sourceBlock}

---
Respond ONLY with valid JSON matching this exact schema — no preamble, no markdown fences:
{
  "rootCause": "one sentence",
  "confidence": "high | medium | low",
  "affectedFiles": ["relative/path"],
  "fix": {
    "description": "what the fix does and why",
    "patches": [
      {
        "file": "relative/path",
        "oldCode": "exact string to replace (empty string for new file)",
        "newCode": "replacement string"
      }
    ]
  },
  "prTitle": "fix: concise title under 72 chars",
  "prBody": "markdown PR description with root cause, fix summary, testing notes",
  "suggestedTests": ["test case descriptions"]
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
      model: 'claude-sonnet-4-20250514',
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
  const allIssues = JSON.parse(readFileSync(ISSUES_FILE, 'utf8'));
  const { newSentryIds } = JSON.parse(readFileSync(CLICKUP_TASKS_FILE, 'utf8'));
  const newIds = new Set(newSentryIds);

  const issues = allIssues.filter((i) => newIds.has(i.id));
  log(`${issues.length} new issue(s) to analyse (${allIssues.length - issues.length} already have proposals — skipping)`);

  const proposals = [];

  for (const issue of issues) {
    log(`Proposing fix for ${issue.shortId}: ${issue.title}`);

    // Resolve source files from frames
    const seen = new Set();
    const sourceFiles = [];

    for (const frame of issue.frames) {
      if (!frame.filename || seen.has(frame.filename)) continue;
      seen.add(frame.filename);

      const resolved = resolveFile(frame.filename, TARGET_REPO_PATH);
      if (resolved) {
        const content = readFileSync(resolved, 'utf8').slice(0, 3000);
        sourceFiles.push({ filename: frame.filename, content });
        log(`  Resolved ${frame.filename} → ${resolved}`);
      } else {
        log(`  Could not resolve ${frame.filename}`);
      }
    }

    const prompt = buildPrompt(issue, sourceFiles);

    let parsed;
    try {
      const raw = await callClaude(prompt);
      parsed = parseResponse(raw);
    } catch (err) {
      log(`  Error getting/parsing Claude response for ${issue.shortId}: ${err.message}`);
      parsed = {
        rootCause: 'Unable to determine — Claude response parse error',
        confidence: 'low',
        affectedFiles: [],
        fix: { description: '', patches: [] },
        prTitle: `fix: investigate ${issue.shortId}`,
        prBody: `Automated analysis failed for [${issue.shortId}](${issue.permalink}).\n\nManual investigation required.`,
        suggestedTests: [],
      };
    }

    proposals.push({
      sentryId: issue.id,
      shortId: issue.shortId,
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
