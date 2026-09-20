#!/usr/bin/env node
'use strict';

/**
 * Runs once a day via .github/workflows/cleanup-archive.yml. Recordings
 * accumulate storage over time, so this removes anything older than
 * RETENTION_DAYS (default 90) — both the GitHub Release (and its audio
 * file) and its entry in manifest.json on the archive-data branch.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);

function log(msg) { console.log(`[cleanup-archive] ${msg}`); }
function sh(cmd) { log(`$ ${cmd}`); return execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' }); }
function shOut(cmd) { return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim(); }

function main() {
  sh('git fetch origin archive-data:archive-data');

  let manifest;
  try {
    manifest = JSON.parse(shOut('git show archive-data:manifest.json'));
  } catch (e) {
    log('no manifest found yet — nothing to clean up.');
    return;
  }

  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const keep = [];
  const remove = [];

  for (const entry of manifest) {
    const recordedAt = new Date(entry.recordedAt || entry.iso).getTime();
    if (Number.isFinite(recordedAt) && recordedAt < cutoff) remove.push(entry);
    else keep.push(entry);
  }

  if (remove.length === 0) {
    log(`nothing older than ${RETENTION_DAYS} days — nothing to remove.`);
    return;
  }

  for (const entry of remove) {
    log(`deleting release ${entry.tag} (${entry.iso})`);
    try {
      sh(`gh release delete "${entry.tag}" --yes --cleanup-tag`);
    } catch (e) {
      log(`could not delete release ${entry.tag}, leaving its manifest entry alone: ${e.message}`);
      keep.push(entry); // don't lose the record if the release deletion failed
    }
  }

  const tmpDir = fs.mkdtempSync('/tmp/archive-data-cleanup-');
  sh(`git worktree add "${tmpDir}" archive-data`);
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(keep, null, 2) + '\n');
  sh(`git -C "${tmpDir}" add manifest.json`);
  sh(`git -C "${tmpDir}" -c user.name="al-hikmah-bot" -c user.email="actions@users.noreply.github.com" commit -m "Prune recordings older than ${RETENTION_DAYS} days"`);
  sh(`git -C "${tmpDir}" push origin archive-data`);
  sh(`git worktree remove "${tmpDir}" --force`);

  log(`removed ${remove.length} old recording(s).`);
}

main();
