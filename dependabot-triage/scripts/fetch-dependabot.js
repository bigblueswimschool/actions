import { writeFileSync } from 'fs';
import { log } from './utils/logger.js';
import { githubRequest } from './utils/github.js';

const { TARGET_REPO, SEVERITY_THRESHOLD = 'medium', OUTPUT_FILE } = process.env;

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function meetsThreshold(severity) {
  const alertLevel = SEVERITY_ORDER.indexOf(severity?.toLowerCase());
  const threshold = SEVERITY_ORDER.indexOf(SEVERITY_THRESHOLD.toLowerCase());
  return alertLevel !== -1 && threshold !== -1 && alertLevel >= threshold;
}

async function fetchManifestContent(owner, repo, manifestPath) {
  try {
    const data = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(manifestPath)}`,
    );
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    log(`Warning: could not fetch manifest ${manifestPath}: ${err.message}`);
    return null;
  }
}

async function main() {
  const [owner, repo] = TARGET_REPO.split('/');
  log(`Fetching open Dependabot alerts for ${TARGET_REPO} (threshold: ${SEVERITY_THRESHOLD})`);

  const alerts = await githubRequest(
    `/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=50`,
  );

  log(`Found ${alerts.length} open alerts total`);

  const filtered = alerts.filter((a) =>
    meetsThreshold(a.security_advisory?.severity),
  );

  log(`${filtered.length} alert(s) meet the ${SEVERITY_THRESHOLD} threshold`);

  const enriched = [];

  for (const alert of filtered) {
    const advisory = alert.security_advisory ?? {};
    const vulnerability = alert.security_vulnerability ?? {};
    const dep = alert.dependency ?? {};
    const pkg = dep.package ?? {};
    const manifestPath = dep.manifest_path ?? '';

    const severity = advisory.severity ?? 'unknown';
    const packageName = pkg.name ?? 'unknown';
    const ecosystem = pkg.ecosystem ?? 'unknown';

    log(`Processing alert #${alert.number}: ${packageName} (${severity})`);

    const manifestContent = manifestPath
      ? await fetchManifestContent(owner, repo, manifestPath)
      : null;

    // Extract CVSS score — prefer v3.1, fall back to v3, then v2
    const cvss =
      advisory.cvss_severities?.cvss_v3?.score ??
      advisory.cvss?.score ??
      null;

    // Extract CVE ID from identifiers array
    const cveId =
      (advisory.identifiers ?? []).find((id) => id.type === 'CVE')?.value ??
      advisory.cve_id ??
      null;

    enriched.push({
      number: alert.number,
      package: packageName,
      ecosystem,
      manifestPath,
      manifestContent,
      currentVersion: vulnerability.vulnerable_version_range ?? null,
      vulnerableRange: vulnerability.vulnerable_version_range ?? null,
      patchedVersion: vulnerability.first_patched_version?.identifier ?? null,
      severity,
      cvss,
      summary: advisory.summary ?? advisory.description ?? '',
      cveId,
      permalink: alert.html_url ?? `https://github.com/${TARGET_REPO}/security/dependabot/${alert.number}`,
    });
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(enriched, null, 2));
  log(`Wrote ${enriched.length} alerts to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
