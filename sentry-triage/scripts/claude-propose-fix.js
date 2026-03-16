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

First, determine whether this is a **performance issue** (N+1 queries, slow/inefficient queries, missing indexes, excessive DB round-trips, large payload serialisation, etc.) or a **non-performance issue** (crashes, exceptions, incorrect behaviour, etc.).

Set "kind" to either "performance" or "test" based on this determination.

### If "kind" is "performance":
Propose a concrete code fix. Include:
- A "fix" object with a description and patches (oldCode/newCode replacements).
- A "prTitle" starting with "perf:" or "fix:".

### If "kind" is "test":
Write a Jest test file that reproduces the issue. The test should:
1. Import the relevant modules from the source files above.
2. Set up minimal mocks/fixtures that replicate the conditions leading to the error.
3. Call the function(s) identified in the stack trace with inputs that trigger the exact exception.
4. Assert that the error is thrown (e.g. expect(...).rejects.toThrow() or expect(() => ...).toThrow()).
5. Include a descriptive test name referencing the Sentry issue ID.
6. Be self-contained — a developer should be able to run it immediately to see the failure.

Respond ONLY with valid JSON matching this exact schema — no preamble, no markdown fences:
{
  "kind": "performance | test",
  "rootCause": "one sentence",
  "confidence": "high | medium | low",
  "affectedFiles": ["relative/path of files involved"],
  "fix": {
    "description": "what the fix does and why (omit if kind=test)",
    "patches": [
      {
        "file": "relative/path",
        "oldCode": "exact string to replace (empty string for new file)",
        "newCode": "replacement string"
      }
    ]
  },
  "test": {
    "file": "relative/path for the test file (omit if kind=performance)",
    "content": "full test file content as a string"
  },
  "prTitle": "concise title under 72 chars",
  "prBody": "markdown PR description with root cause analysis"
}

Include only the "fix" or "test" field that matches the chosen kind — omit the other.`;
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
      max_tokens: 4000,
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
  log(`${issues.length} new issue(s) to generate tests for (${allIssues.length - issues.length} already processed — skipping)`);

  const proposals = [];

  for (const issue of issues) {
    log(`Generating test for ${issue.shortId}: ${issue.title}`);

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
        kind: 'test',
        rootCause: 'Unable to determine — Claude response parse error',
        confidence: 'low',
        affectedFiles: [],
        test: { file: '', content: '' },
        prTitle: `test: investigate ${issue.shortId}`,
        prBody: `Automated analysis failed for [${issue.shortId}](${issue.permalink}).\n\nManual investigation required.`,
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
