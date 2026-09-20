#!/usr/bin/env node
'use strict';

/**
 * Runs on a schedule via .github/workflows/record-live.yml (every 10
 * minutes). Each run:
 *   1. Checks /api/live-status. If not live, exits immediately (cheap,
 *      fast — this is what most runs do, since the broadcast isn't live
 *      most of the day).
 *   2. If live, records the stream with ffmpeg, polling live-status every
 *      60s so it stops recording soon after the real broadcast ends
 *      (rather than recording a looped fallback file for hours). A 6-hour
 *      ceiling (MAX_RECORD_SECONDS) is a safety net in case polling ever
 *      fails to detect the end.
 *   3. Uploads the finished file as a GitHub Release asset (releases are
 *      built for hosting downloadable binaries — this keeps the actual
 *      audio out of the git history that Netlify deploys from, so it
 *      never bloats or slows down the website).
 *   4. Appends an entry (Gregorian / Hijri / Bengali dates + the asset's
 *      download URL) to manifest.json on a dedicated `archive-data`
 *      branch. That branch is NOT the one Netlify deploys from, so
 *      updating it does not trigger a Netlify rebuild — the archive page
 *      just fetches this file directly from GitHub at read time.
 *
 * Overlapping runs (a new schedule tick firing while a recording from an
 * earlier tick is still in progress) are handled by the workflow's
 * `concurrency` setting, not by this script — GitHub queues the new run
 * until the current one finishes, rather than running both at once.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATUS_URL = process.env.STATUS_URL || 'https://nijamuddin.netlify.app/api/live-status';
const MAX_RECORD_SECONDS = 6 * 60 * 60; // hard safety ceiling per recording
const POLL_INTERVAL_MS = 60 * 1000; // how often to re-check live-status while recording
const MIN_VALID_FILE_BYTES = 150 * 1024; // discard obviously-too-short false-positive recordings

function log(msg) {
  console.log(`[record-live] ${msg}`);
}

async function fetchLiveStatus() {
  const res = await fetch(STATUS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`status check failed: HTTP ${res.status}`);
  return res.json();
}

/* ============================================================
   Trilingual date helpers
   ============================================================ */

function gregorianDateStrings(d) {
  const en = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka'
  }).format(d);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d); // YYYY-MM-DD
  return { en, iso };
}

// Uses the ICU Islamic (tabular) calendar built into Node. This is a
// calculated Hijri date, not a moon-sighting-confirmed one — it can be a
// day off from an official/local moon-sighting announcement. Good enough
// as a reference date on a recording, but worth knowing about.
function hijriDateString(d) {
  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-islamic', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka'
    }).format(d);
  } catch (e) {
    return null;
  }
}

// Bengali (Bangladesh) calendar, 2019 Bangla Academy revision: Boishakh 1
// always falls on 14 April (Gregorian). Months 1-5 have 31 days, months
// 6-12 have 30 days, except Falgun (month 11) gets 31 days in the years
// whose following February is a Gregorian leap-year February.
const BANGLA_MONTHS = ['বৈশাখ', 'জ্যৈষ্ঠ', 'আষাঢ়', 'শ্রাবণ', 'ভাদ্র', 'আশ্বিন', 'কার্তিক', 'অগ্রহায়ণ', 'পৌষ', 'মাঘ', 'ফাল্গুন', 'চৈত্র'];
const BANGLA_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

function toBanglaNumeral(n) {
  return String(n).split('').map(c => (c >= '0' && c <= '9') ? BANGLA_DIGITS[+c] : c).join('');
}

function isGregorianLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

function bengaliDateString(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const gYear = Number(parts.year), gMonth = Number(parts.month), gDay = Number(parts.day);

  const onOrAfterApr14 = (gMonth > 4) || (gMonth === 4 && gDay >= 14);
  const bYear = onOrAfterApr14 ? gYear - 593 : gYear - 594;

  const anchorGregorianYear = bYear + 593;
  const anchor = Date.UTC(anchorGregorianYear, 3, 14); // 14 April, month index 3
  const today = Date.UTC(gYear, gMonth - 1, gDay);
  let offsetDays = Math.round((today - anchor) / 86400000);
  if (offsetDays < 0) offsetDays += 365; // defensive guard, shouldn't trigger given the year rule above

  const falgunIsLeap = isGregorianLeapYear(anchorGregorianYear + 1);
  const monthLengths = [31, 31, 31, 31, 31, 30, 30, 30, 30, 30, falgunIsLeap ? 31 : 30, 30];

  let monthIndex = 0;
  let remaining = offsetDays;
  while (monthIndex < monthLengths.length - 1 && remaining >= monthLengths[monthIndex]) {
    remaining -= monthLengths[monthIndex];
    monthIndex++;
  }
  const bDay = remaining + 1;

  return `${toBanglaNumeral(bDay)} ${BANGLA_MONTHS[monthIndex]} ${toBanglaNumeral(bYear)} বঙ্গাব্দ`;
}

function allDateStrings(d) {
  const { en, iso } = gregorianDateStrings(d);
  return { iso, english: en, hijri: hijriDateString(d), bengali: bengaliDateString(d) };
}

/* ============================================================
   Shell helpers
   ============================================================ */

function sh(cmd) {
  log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
}

function shOut(cmd) {
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim();
}

/* ============================================================
   Recording
   ============================================================ */

function recordStream(streamUrl, outFile) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-user_agent', 'AlHikmahLiveRecorder/1.0',
      '-i', streamUrl,
      '-c', 'copy',
      '-t', String(MAX_RECORD_SECONDS),
      outFile
    ], { stdio: 'inherit' });

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      log('stopping recording (sending SIGINT to ffmpeg so the file closes cleanly)...');
      ff.kill('SIGINT');
    };

    const startedMs = Date.now();
    const poller = setInterval(async () => {
      const elapsed = (Date.now() - startedMs) / 1000;
      if (elapsed >= MAX_RECORD_SECONDS) { clearInterval(poller); stop(); return; }
      try {
        const data = await fetchLiveStatus();
        if (!data || !data.live) {
          log('live-status now reports offline — ending recording.');
          clearInterval(poller);
          stop();
        }
      } catch (e) {
        log(`status check failed during recording, will retry next tick: ${e.message}`);
      }
    }, POLL_INTERVAL_MS);

    ff.on('close', (code) => {
      clearInterval(poller);
      log(`ffmpeg exited with code ${code}`);
      resolve();
    });
  });
}

/* ============================================================
   Release + manifest (on the archive-data branch)
   ============================================================ */

function ensureArchiveDataBranch() {
  try {
    sh('git fetch origin archive-data:archive-data');
  } catch (e) {
    log('archive-data branch does not exist yet — creating it as an orphan branch.');
    sh('git checkout --orphan archive-data');
    sh('git rm -rf . 2>/dev/null || true');
    fs.writeFileSync('manifest.json', '[]\n');
    sh('git add manifest.json');
    sh('git -c user.name="al-hikmah-bot" -c user.email="actions@users.noreply.github.com" commit -m "Initialise archive manifest"');
    sh('git push origin archive-data');
    sh('git checkout -');
  }
}

function readManifestFromBranch() {
  try {
    return JSON.parse(shOut('git show archive-data:manifest.json'));
  } catch (e) {
    return [];
  }
}

function writeManifestToBranch(manifest, commitMessage) {
  const tmpDir = fs.mkdtempSync('/tmp/archive-data-');
  sh(`git worktree add "${tmpDir}" archive-data`);
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  sh(`git -C "${tmpDir}" add manifest.json`);
  sh(`git -C "${tmpDir}" -c user.name="al-hikmah-bot" -c user.email="actions@users.noreply.github.com" commit -m "${commitMessage}"`);
  sh(`git -C "${tmpDir}" push origin archive-data`);
  sh(`git worktree remove "${tmpDir}" --force`);
}

/* ============================================================
   Main
   ============================================================ */

async function main() {
  log('checking live status...');
  const status = await fetchLiveStatus();

  if (!status || !status.live || !status.streamUrl) {
    log('not live right now — nothing to do.');
    return;
  }

  log(`live! source=${status.source} bitrate=${status.bitrateKbps || 'unknown'}kbps`);

  const startedAt = new Date();
  const dates = allDateStrings(startedAt);
  const outFile = `/tmp/${dates.iso}.mp3`;

  log(`recording to ${outFile}`);
  log(`  Gregorian: ${dates.english}`);
  log(`  Hijri:     ${dates.hijri}`);
  log(`  Bengali:   ${dates.bengali}`);

  await recordStream(status.streamUrl, outFile);

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < MIN_VALID_FILE_BYTES) {
    log('recording too short or missing — skipping upload (likely a brief false-positive live reading).');
    return;
  }

  const sizeBytes = fs.statSync(outFile).size;
  const tag = `rec-${dates.iso}`;
  const title = `${dates.english} · ${dates.hijri || ''} · ${dates.bengali}`;

  log('creating GitHub Release and uploading the recording...');
  sh(`gh release create "${tag}" "${outFile}" --title "${title.replace(/"/g, '\\"')}" --notes "Automated recording of the live broadcast."`);

  const assetUrl = shOut(`gh release view "${tag}" --json assets -q '.assets[0].url'`);

  ensureArchiveDataBranch();
  const manifest = readManifestFromBranch();
  manifest.push({
    iso: dates.iso,
    english: dates.english,
    hijri: dates.hijri,
    bengali: dates.bengali,
    tag,
    assetUrl,
    sizeBytes,
    recordedAt: startedAt.toISOString()
  });
  writeManifestToBranch(manifest, `Add recording ${dates.iso}`);

  log('done.');
}

main().catch((err) => {
  console.error('[record-live] fatal error:', err);
  process.exit(1);
});
      
