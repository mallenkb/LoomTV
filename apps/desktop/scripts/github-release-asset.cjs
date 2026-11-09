const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'LoomTV-release-download',
};

/** Read the same release asset through GitHub's API when its download URL is unavailable. */
async function fetchReleaseAsset(repo, tag, name) {
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const releaseResponse = await fetch(releaseUrl, {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(30_000),
  });
  if (!releaseResponse.ok) throw new Error(`Could not inspect ${repo} release ${tag}: HTTP ${releaseResponse.status}.`);
  const release = await releaseResponse.json();
  const asset = release.assets?.find((entry) => entry.name === name && Number.isSafeInteger(entry.id));
  if (!asset) throw new Error(`Release ${tag} does not contain ${name}.`);

  const assetResponse = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
    headers: { ...API_HEADERS, Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!assetResponse.ok || !assetResponse.headers.get('content-type')?.includes('application/octet-stream')) {
    throw new Error(`Could not download ${name} through the GitHub API: HTTP ${assetResponse.status}.`);
  }
  return Buffer.from(await assetResponse.arrayBuffer());
}

module.exports = { fetchReleaseAsset };
