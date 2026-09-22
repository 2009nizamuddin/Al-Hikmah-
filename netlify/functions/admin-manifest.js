'use strict';

/**
 * Password-protected endpoint for fixing a recording's dates in
 * manifest.json on the archive-data branch. Called only from admin.html.
 *
 * Two secrets must be set as Netlify environment variables (Site
 * settings -> Environment variables) — never put these in any file:
 *   ADMIN_PASSWORD  - the password you choose for editing the archive.
 *   GH_TOKEN        - a GitHub Personal Access Token (fine-grained,
 *                     scoped to just this repo, with "Contents:
 *                     Read and write" permission) that this function
 *                     uses server-side to commit the fix. It is never
 *                     sent to the browser.
 *
 * The client never touches GH_TOKEN — it only sends the password, which
 * is checked here on the server before anything is written to GitHub.
 */

const REPO_OWNER = process.env.GH_REPO_OWNER || '2009nizamuddin';
const REPO_NAME = process.env.GH_REPO_NAME || 'Al-Hikmah-';
const BRANCH = 'archive-data';

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'invalid JSON' });
  }

  const { password, action, tag, entry } = body;

  if (!process.env.ADMIN_PASSWORD) {
    return json(500, { error: 'ADMIN_PASSWORD is not configured on the server' });
  }
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'ভুল পাসওয়ার্ড' });
  }

  // Lets admin.html check the password immediately without touching
  // GitHub at all.
  if (action === 'verify') {
    return json(200, { ok: true });
  }

  if (action !== 'update' || !tag || !entry || typeof entry !== 'object') {
    return json(400, { error: 'invalid request' });
  }

  if (!process.env.GH_TOKEN) {
    return json(500, { error: 'GH_TOKEN is not configured on the server' });
  }

  const ghHeaders = {
    'Authorization': `Bearer ${process.env.GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'al-hikmah-admin'
  };

  try {
    const getRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/manifest.json?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (!getRes.ok) throw new Error(`manifest fetch failed: HTTP ${getRes.status}`);
    const getData = await getRes.json();
    const manifest = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));

    const idx = manifest.findIndex((r) => r.tag === tag);
    if (idx === -1) throw new Error('এই রেকর্ডিং এখন আর manifest-এ নেই (tag মিলছে না)');

    // Only the display date fields are editable here — tag, assetUrl,
    // sizeBytes etc. are left untouched so the audio link never breaks.
    if (typeof entry.iso === 'string' && entry.iso) manifest[idx].iso = entry.iso;
    if (typeof entry.english === 'string') manifest[idx].english = entry.english;
    if (typeof entry.hijri === 'string') manifest[idx].hijri = entry.hijri;
    if (typeof entry.bengali === 'string') manifest[idx].bengali = entry.bengali;

    const newContent = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8').toString('base64');

    const putRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/manifest.json`,
      {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Admin edit: fix dates for ${tag}`,
          content: newContent,
          sha: getData.sha,
          branch: BRANCH
        })
      }
    );
    if (!putRes.ok) {
      const detail = await putRes.text();
      throw new Error(`commit failed: HTTP ${putRes.status} ${detail}`);
    }

    return json(200, { ok: true });
  } catch (e) {
    return json(502, { error: e.message });
  }
};

