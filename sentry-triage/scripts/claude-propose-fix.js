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

/**
 * Derive candidate source files from the Sentry culprit string.
 * e.g. "location.getOne" → look for location.service.ts, location.controller.ts
 */
function resolveFilesFromCulprit(culprit, repoPath) {
  if (!culprit) return [];

  const [module] = culprit.split('.');
  if (!module) return [];

  const candidates = [
    `src/modules/${module}/${module}.service.ts`,
    `src/modules/${module}/${module}.controller.ts`,
    `src/modules/${module}/${module}.entity.ts`,
    `src/${module}/${module}.service.ts`,
    `src/${module}/${module}.controller.ts`,
    `src/${module}/${module}.entity.ts`,
  ];

  const results = [];
  for (const candidate of candidates) {
    const resolved = join(repoPath, candidate);
    if (existsSync(resolved)) {
      results.push({ relative: candidate, absolute: resolved });
    }
  }

  return results;
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
    : '(no source files resolved)';

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

## Critical Rules

1. **ONLY reference files, classes, methods, columns, and relations that appear in the source files above.** If no source files were resolved, you MUST set confidence to "low" and describe what files you WOULD need to see rather than guessing at code that might exist.

2. **Never fabricate entity fields, relation names, or repository references.** If the source code for an entity or service is not provided above, do not guess its schema. Instead, state what information is missing.

3. **Patches must target files that exist in the "Relevant Source Files" section above.** Do not create patches for files you have not seen. If the culprit points to a method but no source was provided, set confidence to "low" and explain what file needs to be examined.

4. **The "oldCode" in patches must be an EXACT substring** of the source file content shown above. Copy it character-for-character. If you cannot identify the exact code to replace, do not propose a patch — instead describe the fix in the PR body and set confidence to "low".

5. **For performance issues**: look for N+1 queries, missing SELECT column restrictions, unnecessary JOIN/eager-loading, missing indexes, or large payload serialisation in the provided source. Match the existing code patterns in the file (e.g., if the codebase uses raw SQL via dataSource.query(), propose raw SQL — not query builder).

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
        const content = readFileSync(resolved, 'utf8').slice(0, 8000);
        sourceFiles.push({ filename: frame.filename, content });
        log(`  Resolved ${frame.filename} → ${resolved}`);
      } else {
        log(`  Could not resolve ${frame.filename}`);
      }
    }

    // Fallback: resolve source files from the culprit string (e.g. "location.getOne")
    // This is critical for performance issues that often have no in-app stack frames
    const culpritFiles = resolveFilesFromCulprit(issue.culprit, TARGET_REPO_PATH);
    for (const { relative, absolute } of culpritFiles) {
      if (seen.has(relative)) continue;
      seen.add(relative);
      const content = readFileSync(absolute, 'utf8').slice(0, 8000);
      sourceFiles.push({ filename: relative, content });
      log(`  Resolved from culprit: ${relative}`);
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
