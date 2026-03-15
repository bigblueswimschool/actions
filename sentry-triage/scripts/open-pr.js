import { readFileSync } from 'fs';
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

async function getBaseSha() {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${TARGET_BRANCH}`);
  return data.object.sha;
}

async function createBranch(branchName, sha) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/git/refs`, 'POST', {
      ref: `refs/heads/${branchName}`,
      sha,
    });
    log(`  Created branch ${branchName}`);
  } catch (err) {
    if (err.message.includes('422')) {
      log(`  Branch ${branchName} already exists — skipping creation`);
    } else {
      throw err;
    }
  }
}

async function getFileContent(filePath, branch) {
  try {
    const data = await githubRequest(
      `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
    );
    return {
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      sha: data.sha,
    };
  } catch (err) {
    if (err.message.includes('404')) {
      return { content: '', sha: null };
    }
    throw err;
  }
}

async function commitFile(filePath, content, sha, message, branch) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  await githubRequest(`/repos/${owner}/${repo}/contents/${filePath}`, 'PUT', body);
}

async function applyPatch(patch, branch, commitMessage) {
  const { file, oldCode, newCode } = patch;
  const { content: current, sha } = await getFileContent(file, branch);

  let updated;
  if (!oldCode) {
    // New file
    updated = newCode;
  } else if (current.includes(oldCode)) {
    updated = current.replace(oldCode, newCode);
  } else {
    log(`  oldCode not found in ${file} — appending TODO comment`);
    updated = current + `\n// TODO(sentry-triage): ${newCode}\n`;
  }

  await commitFile(file, updated, sha, commitMessage, branch);
  log(`  Committed patch to ${file}`);
}

async function openDraftPR(branchName, proposal) {
  const footer = `\n\n---\n*Created automatically by the [sentry-triage](https://github.com/bigblueswimschool/actions) action. Confidence: **${proposal.confidence}**. Review carefully before merging.*`;

  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls`, 'POST', {
    title: proposal.prTitle,
    body: proposal.prBody + footer,
    head: branchName,
    base: TARGET_BRANCH,
    draft: true,
  });

  log(`  Opened draft PR #${pr.number}: ${pr.html_url}`);
  return pr;
}

async function commentOnClickUpTask(taskId, pr, shortId) {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: {
      Authorization: CLICKUP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      comment_text: `Draft PR opened by sentry-triage action:\n\n**PR #${pr.number}:** [${pr.title}](${pr.html_url})\n\nLinked Sentry issue: ${shortId}`,
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
    log(`Processing proposal for ${proposal.shortId}`);

    const branchName = `sentry-triage/${proposal.shortId.toLowerCase()}`;
    const commitMessage = `fix(${proposal.shortId}): ${proposal.rootCause.slice(0, 72)}`;

    await createBranch(branchName, baseSha);

    const patches = proposal.fix?.patches ?? [];
    for (const patch of patches) {
      try {
        await applyPatch(patch, branchName, commitMessage);
      } catch (err) {
        log(`  Error applying patch to ${patch.file}: ${err.message}`);
      }
    }

    let pr;
    try {
      pr = await openDraftPR(branchName, proposal);
    } catch (err) {
      if (err.message.includes('422')) {
        log(`  PR already exists for branch ${branchName} — skipping`);
        continue;
      }
      throw err;
    }

    const clickupTaskId = taskMap[proposal.sentryId];
    if (clickupTaskId && pr) {
      await commentOnClickUpTask(clickupTaskId, pr, proposal.shortId);
    }
  }

  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
