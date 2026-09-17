const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function selectArtifacts(pages, runId, sha, attempt) {
  if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^[0-9a-f]{40}$/.test(sha)
    || !Number.isSafeInteger(Number(attempt)) || Number(attempt) < 1) {
    throw new Error('Invalid release run identity.');
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page.artifacts))) {
    throw new Error('Invalid artifact listing.');
  }
  const artifacts = pages.flatMap((page) => page.artifacts);
  return Object.fromEntries(['macos', 'windows', 'linux'].map((platform) => {
    const prefix = `loomtv-${platform}-`;
    const candidates = artifacts.filter((artifact) => (
      typeof artifact.name === 'string' && artifact.name.startsWith(prefix)
      && /^[1-9][0-9]*$/.test(artifact.name.slice(prefix.length))
      && Number(artifact.name.slice(prefix.length)) <= Number(attempt)
      && String(artifact.workflow_run?.id) === String(runId)
      && artifact.workflow_run?.head_sha === sha
    )).sort((left, right) => (
      Number(right.name.slice(prefix.length)) - Number(left.name.slice(prefix.length))
      || right.id - left.id
    ));
    const artifact = candidates[0];
    if (!artifact || artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id < 1
      || candidates.some((other) => other !== artifact && other.name === artifact.name)) {
      throw new Error(`Missing, expired, or ambiguous ${platform} artifact for release run ${runId}.`);
    }
    return [platform, { id: String(artifact.id), name: artifact.name }];
  }));
}

if (require.main === module) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, RELEASE_SHA: sha, GITHUB_OUTPUT: output } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid repository.');
  if (!/^[1-9][0-9]*$/.test(runId || '')) throw new Error('Invalid run ID.');
  const pages = JSON.parse(execFileSync('gh', [
    'api', '--method', 'GET', '--paginate', '--slurp',
    `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const artifacts = selectArtifacts(pages, runId, sha, attempt);
  fs.appendFileSync(output, Object.entries(artifacts).map(([platform, artifact]) => (
    `${platform}_id=${artifact.id}\n${platform}_name=${artifact.name}\n`
  )).join(''));
}

module.exports = { selectArtifacts };
