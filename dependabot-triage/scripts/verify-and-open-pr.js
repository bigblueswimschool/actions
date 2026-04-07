import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { log } from './utils/logger.js';
import { githubRequest } from './utils/github.js';

const {
  GH_TOKEN,
  TARGET_REPO,
  TARGET_BRANCH,
  PROPOSALS_FILE,
  CLICKUP_TASKS_FILE,
  CLICKUP_TOKEN,
} = process.env;

const [owner, repo] = TARGET_REPO.split('/');

function branchName(packageName, alertNumber) {
  const safePkg = packageName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `dependabot-triage/${safePkg}-${alertNumber}`;
}

async function getBaseSha() {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${TARGET_BRANCH}`);
  return data.object.sha;
}

async function createBranch(branch, sha) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/git/refs`, 'POST', {
      ref: `refs/heads/${branch}`,
      sha,
    });
    log(`  Created branch ${branch}`);
    return true;
  } catch (err) {
    if (err.message.includes('422')) {
      log(`  Branch ${branch} already exists — skipping`);
      return false;
    }
    throw err;
  }
}

async function getFileOnBranch(filePath, branch) {
  try {
    const data = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`,
    );
    return {
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      sha: data.sha,
    };
  } catch (err) {
    if (err.message.includes('404')) return { content: '', sha: null };
    throw err;
  }
}

async function commitFileToGitHub(filePath, content, sha, message, branch) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, 'PUT', body);
  log(`  Committed ${filePath} to ${branch}`);
}

function detectLockfile(ecosystem) {
  if (ecosystem !== 'npm') return null;
  if (existsSync('yarn.lock')) return 'yarn.lock';
  if (existsSync('package-lock.json')) return 'package-lock.json';
  return null;
}

function runCommand(cmd, label) {
  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    log(`  ${label}: OK`);
    return { success: true, output };
  } catch (err) {
    const output = (err.stdout ?? '') + (err.stderr ?? '');
    log(`  ${label}: FAILED\n${output.slice(0, 500)}`);
    return { success: false, output };
  }
}

async function openDraftPR(branch, proposal, verificationSummary) {
  const footer = [
    '',
    '---',
    `*Created automatically by the [dependabot-triage](https://github.com/bigblueswimschool/actions) action.*`,
    `*Confidence: **${proposal.confidence}**${verificationSummary.allPassed ? '' : ' (downgraded due to verification failures)'}*`,
    '',
    `**Verification results:**`,
    `- \`yarn install\`: ${verificationSummary.install ? '✅ passed' : '❌ failed'}`,
    `- \`yarn build\`: ${verificationSummary.build ? '✅ passed' : '❌ failed'}`,
    `- \`yarn test\`: ${verificationSummary.test ? '✅ passed' : '❌ failed'}`,
    '',
    '> ⚠️ This is a draft PR. Review carefully before merging.',
  ].join('\n');

  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls`, 'POST', {
    title: proposal.prTitle,
    body: proposal.prBody + footer,
    head: branch,
    base: TARGET_BRANCH,
    draft: true,
  });

  log(`  Opened draft PR #${pr.number}: ${pr.html_url}`);
  return pr;
}

async function commentOnClickUpTask(taskId, pr, alertNumber) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: {
      Authorization: CLICKUP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      comment_text: `Draft PR opened by dependabot-triage action:\n\n**PR #${pr.number}:** [${pr.title}](${pr.html_url})\n\nLinked Dependabot alert: #${alertNumber}`,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log(`  Warning: could not comment on ClickUp task ${taskId}: ${res.status} ${text}`);
  } else {
    log(`  Commented PR link on ClickUp task ${taskId}`);
  }
}

async function main() {
  const proposals = JSON.parse(readFileSync(PROPOSALS_FILE, 'utf8'));
  const { taskMap } = JSON.parse(readFileSync(CLICKUP_TASKS_FILE, 'utf8'));

  log(`Loaded ${proposals.length} proposals`);

  const baseSha = await getBaseSha();
  log(`Base SHA for ${TARGET_BRANCH}: ${baseSha}`);

  for (const proposal of proposals) {
    log(`Processing proposal for alert #${proposal.alertNumber}: ${proposal.package}`);

    const branch = branchName(proposal.package, proposal.alertNumber);

    const created = await createBranch(branch, baseSha);
    if (!created) {
      log(`  Skipping — branch already exists`);
      continue;
    }

    const patches = proposal.fix?.patches ?? [];
    if (!patches.length) {
      log(`  No patches to apply — skipping PR creation`);
      continue;
    }

    // Apply manifest patch locally for yarn install/build/test verification
    const manifestPatch = patches[0];
    const localManifest = manifestPatch.file;
    let verificationSummary = { install: false, build: false, test: false, allPassed: false };
    let verificationFailureDetails = '';

    if (existsSync(localManifest)) {
      const originalContent = readFileSync(localManifest, 'utf8');

      let patchedContent;
      if (!manifestPatch.oldCode) {
        patchedContent = manifestPatch.newCode;
      } else if (originalContent.includes(manifestPatch.oldCode)) {
        patchedContent = originalContent.replace(manifestPatch.oldCode, manifestPatch.newCode);
      } else {
        log(`  oldCode not found in ${localManifest} — skipping local verification`);
        patchedContent = null;
      }

      if (patchedContent !== null) {
        writeFileSync(localManifest, patchedContent, 'utf8');
        log(`  Applied patch to ${localManifest} locally`);

        const installResult = runCommand('yarn install --frozen-lockfile false', 'yarn install');
        verificationSummary.install = installResult.success;
        if (!installResult.success) {
          verificationFailureDetails += `\n### yarn install failure\n\`\`\`\n${installResult.output.slice(0, 1000)}\n\`\`\``;
          proposal.confidence = 'low';
        }

        const buildResult = runCommand('yarn build', 'yarn build');
        verificationSummary.build = buildResult.success;
        if (!buildResult.success) {
          verificationFailureDetails += `\n### yarn build failure\n\`\`\`\n${buildResult.output.slice(0, 1000)}\n\`\`\``;
          proposal.confidence = 'low';
        }

        const testResult = runCommand('yarn test --passWithNoTests', 'yarn test');
        verificationSummary.test = testResult.success;
        if (!testResult.success) {
          verificationFailureDetails += `\n### yarn test failure\n\`\`\`\n${testResult.output.slice(0, 1000)}\n\`\`\``;
          proposal.confidence = 'low';
        }

        verificationSummary.allPassed =
          verificationSummary.install &&
          verificationSummary.build &&
          verificationSummary.test;

        if (verificationFailureDetails) {
          proposal.prBody += `\n\n## Verification Failures\n${verificationFailureDetails}`;
        }
      }
    } else {
      log(`  Local manifest ${localManifest} not found — skipping verification`);
    }

    // Commit manifest patch to GitHub branch
    for (const patch of patches) {
      const { content: current, sha } = await getFileOnBranch(patch.file, branch);
      let updated;
      if (!patch.oldCode) {
        updated = patch.newCode;
      } else if (current.includes(patch.oldCode)) {
        updated = current.replace(patch.oldCode, patch.newCode);
      } else {
        log(`  oldCode not found in ${patch.file} on branch — skipping patch`);
        continue;
      }
      const commitMsg = `fix(deps): bump ${proposal.package} (Dependabot alert #${proposal.alertNumber})`;
      await commitFileToGitHub(patch.file, updated, sha, commitMsg, branch);
    }

    // Commit lockfile if present (npm only)
    const lockfileName = detectLockfile(proposal.ecosystem);
    if (lockfileName && existsSync(lockfileName)) {
      const lockfileContent = readFileSync(lockfileName, 'utf8');
      const { sha: lockfileSha } = await getFileOnBranch(lockfileName, branch);
      const lockfileCommitMsg = `chore: update ${lockfileName} after bumping ${proposal.package}`;
      await commitFileToGitHub(lockfileName, lockfileContent, lockfileSha, lockfileCommitMsg, branch);
    }

    let pr;
    try {
      pr = await openDraftPR(branch, proposal, verificationSummary);
    } catch (err) {
      if (err.message.includes('422')) {
        log(`  PR already exists for branch ${branch} — skipping`);
        continue;
      }
      throw err;
    }

    const clickupTaskId = taskMap[proposal.alertNumber];
    if (clickupTaskId && pr) {
      await commentOnClickUpTask(clickupTaskId, pr, proposal.alertNumber);
    }
  }

  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
