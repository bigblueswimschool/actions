import { writeFileSync } from 'fs';
import { log } from './utils/logger.js';

const { SENTRY_TOKEN, SENTRY_ORG, SENTRY_PROJECT, SENTRY_ENVIRONMENT, OUTPUT_FILE } = process.env;

async function sentryRequest(path) {
  const res = await fetch(`https://sentry.io/api/0${path}`, {
    headers: {
      Authorization: `Bearer ${SENTRY_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sentry GET ${path} → ${res.status}: ${text}`);
  }

  return res.json();
}

async function fetchLatestEvent(issueId) {
  try {
    return await sentryRequest(`/issues/${issueId}/events/latest/`);
  } catch (err) {
    log(`Warning: could not fetch latest event for issue ${issueId}: ${err.message}`);
    return null;
  }
}

function extractInAppFrames(event) {
  const exceptions = event?.exception?.values ?? [];
  const frames = [];

  for (const exc of exceptions) {
    const stackFrames = exc?.stacktrace?.frames ?? [];
    for (const frame of stackFrames) {
      if (frame.inApp) {
        frames.push({
          filename: frame.filename ?? frame.absPath ?? '',
          function: frame.function ?? '',
          lineNo: frame.lineNo ?? null,
          context: frame.context ?? [],
        });
      }
    }
  }

  return frames.slice(-10);
}

async function main() {
  const envLabel = SENTRY_ENVIRONMENT ?? 'all environments';
  log(`Fetching unresolved issues for ${SENTRY_ORG}/${SENTRY_PROJECT} (${envLabel})`);

  const envParam = SENTRY_ENVIRONMENT ? `&environment=${encodeURIComponent(SENTRY_ENVIRONMENT)}` : '';
  const issues = await sentryRequest(
    `/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=is:unresolved&limit=25&expand=owners${envParam}`,
  );

  log(`Found ${issues.length} unresolved issues`);

  const enriched = [];

  for (const issue of issues) {
    log(`Processing issue ${issue.shortId}: ${issue.title}`);

    const latestEvent = await fetchLatestEvent(issue.id);
    const frames = latestEvent ? extractInAppFrames(latestEvent) : [];

    enriched.push({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit ?? '',
      permalink: issue.permalink ?? `https://sentry.io/organizations/${SENTRY_ORG}/issues/${issue.id}/`,
      count: parseInt(issue.count ?? '0', 10),
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      level: issue.level ?? 'error',
      exception: latestEvent?.exception ?? null,
      frames,
      tags: issue.tags ?? [],
    });
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(enriched, null, 2));
  log(`Wrote ${enriched.length} issues to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
