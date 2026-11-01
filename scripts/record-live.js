#!/usr/bin/env node
'use strict';

/**
 * Runs on a schedule via .github/workflows/record-live.yml (every 5
 * minutes). Each run:
 *   1. Checks /api/live-status. If not live, exits immediately.
 *   2. If live, records the stream with ffmpeg. Short drops are tolerated:
 *      a single "offline" reading from live-status (or a brief stream
 *      hiccup that makes ffmpeg exit) does NOT end the recording. The
 *      recording only ends after the broadcast has been continuously
 *      offline for a grace period (5 minutes normally, 30 minutes during
 *      Jumuah). Pieces recorded around a hiccup are joined into one file.
 *   3. Normal days: recorded in ~2-hour parts (part 1, part 2, ...).
 *      Jumuah (Friday, Bangladesh time): any recording that starts before
 *      3:00 PM runs as ONE unbroken file until 3:00 PM, labelled
 *      "জুমুয়াবারের আলোচনা". If the broadcast is still live after 3:00 PM
 *      the rest becomes a separate normal part.
 *   4. Each finished file is uploaded as its own GitHub Release asset and
 *      an entry (dates, start/end time, label, part number, download URL)
 *      is appended to manifest.json on the `archive-data` branch (not the
 *      branch Netlify deploys from, so no Netlify rebuild happens).
 *   5. settings.json on the same branch (written by the admin page) can
 *      hold `hijriOffsetDays`: when the admin corrects a Hijri date, later
 *      recordings are computed from the corrected date.
 *
 * GitHub's hard 6-hour job limit can't be raised; JOB_SOFT_LIMIT_MS stops
 * new segments before it, and the next scheduled run continues the rest.
 * Overlapping runs are queued by the workflow's `concurrency` setting.
 */

const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATUS_URL = process.env.STATUS_URL || 'https://nijamuddin.netlify.app/api/live-status';
const SEGMENT_SECONDS = 2 * 60 * 60; // normal days: ~2h parts
const JOB_SOFT_LIMIT_MS = (5 * 60 + 45) * 60 * 1000; // stop before GitHub's hard 6h job limit
const POLL_INTERVAL_MS = 60 * 1000; // how often to re-check live-status while recording
const MIN_VALID_FILE_BYTES = 150 * 1024; // discard obviously-too-short false-positive recordings
const NORMAL_GRACE_MS = 5 * 60 * 1000; // normal days: end only after this long continuously offline
const JUMUAH_GRACE_MS = 30 * 60 * 1000; // Jumuah: much more patient — no stopping for short silences
const JUMUAH_END_HOUR = 15; // 3:00 PM Bangladesh time
const JUMUAH_TITLE = 'জুমুয়াবারের আলোচনা';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function hijriDateString(d, offsetDays = 0) {
  try {
    const shifted = new Date(d.getTime() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('ar-SA-u-ca-islamic', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka'
    }).format(shifted);
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

function allDateStrings(d, hijriOffsetDays = 0) {
  const { en, iso } = gregorianDateStrings(d);
  return { iso, english: en, hijri: hijriDateString(d, hijriOffsetDays), bengali: bengaliDateString(d) };
}

// Bangladesh-time clock parts (Asia/Dhaka has no daylight saving).
function dhakaParts(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(d).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday: p.weekday };
}

function hhmmDhaka(d) {
  const p = dhakaParts(d);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// If `now` is a Friday (Bangladesh time) before 3:00 PM, returns the
// timestamp of today's 3:00 PM; otherwise null (not in the Jumuah window).
function jumuahDeadlineMs(now) {
  const p = dhakaParts(now);
  if (p.weekday !== 'Fri') return null;
  const deadline = Date.UTC(p.year, p.month - 1, p.day, JUMUAH_END_HOUR - 6, 0, 0); // Dhaka = UTC+6
  return now.getTime() < deadline ? deadline : null;
}

/* ============================================================
   Shell helpers
   ============================================================ */

function sh(cmd) {
  log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
}

function shOut(cmd) {
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function releaseExists(tag) {
  try {
    execSync(`gh release view "${tag}"`, { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

// If the tag is already taken, pick the next free "-2", "-3", ... suffix
// instead of failing outright.
function uniqueTag(baseTag) {
  if (!releaseExists(baseTag)) return baseTag;
  let n = 2;
  while (releaseExists(`${baseTag}-${n}`)) n++;
  return `${baseTag}-${n}`;
}

/* ============================================================
   Recording (patient: short drops don't end the recording)
   ============================================================ */

// Tracks whether the broadcast is live, and for how long it has been
// continuously offline. One bad reading never ends a recording — only
// `graceMs` of unbroken "offline" does.
function makeMonitor(graceMs) {
  const m = {
    lastLiveMs: Date.now(),
    offlineSinceMs: null,
    async check() {
      try {
        const s = await fetchLiveStatus();
        if (s && s.live) {
          if (m.offlineSinceMs !== null) log('live-status is live again — continuing the same recording.');
          m.lastLiveMs = Date.now();
          m.offlineSinceMs = null;
          return true;
        }
        if (m.offlineSinceMs === null) {
          m.offlineSinceMs = Date.now();
          log(`live-status reports offline — waiting up to ${Math.round(graceMs / 60000)} min in case it comes back.`);
        }
        return false;
      } catch (e) {
        log(`status check failed (ignored, not counted as offline): ${e.message}`);
        return null;
      }
    },
    offlineTooLong() {
      return m.offlineSinceMs !== null && Date.now() - m.offlineSinceMs >= graceMs;
    }
  };
  return m;
}

// Records one continuous ffmpeg run of up to `seconds`. Resolves with
// { code, offline } — offline=true if we stopped it because the grace
// period ran out.
function recordPiece(streamUrl, outFile, seconds, useReconnect, monitor) {
  return new Promise((resolve) => {
    const args = ['-y', '-user_agent', 'AlHikmahLiveRecorder/1.0'];
    if (useReconnect) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30', '-rw_timeout', '20000000');
    }
    args.push('-i', streamUrl, '-c', 'copy', '-write_xing', '0', '-t', String(Math.ceil(seconds)), outFile);

    const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
    let killedForOffline = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearInterval(poller);
      resolve({ code, offline: killedForOffline });
    };

    const poller = setInterval(async () => {
      await monitor.check();
      if (monitor.offlineTooLong() && !killedForOffline) {
        killedForOffline = true;
        log('offline for too long — stopping this recording (SIGINT so the file closes cleanly).');
        ff.kill('SIGINT');
      }
    }, POLL_INTERVAL_MS);

    ff.on('error', (e) => { log(`could not run ffmpeg: ${e.message}`); finish(-1); });
    ff.on('close', (code) => { log(`ffmpeg exited with code ${code}`); finish(code); });
  });
}

// Records one "segment" (one archive entry). If ffmpeg dies early while
// the broadcast is still live, it is restarted and the pieces are joined
// into a single file. Returns { reason, endedAt, hadAudio }.
//   reason: 'cap'     - reached maxSeconds (more may still be live)
//           'offline' - broadcast ended (offline longer than the grace)
//           'failed'  - ffmpeg kept failing immediately
async function recordSegment(streamUrl, outFile, { maxSeconds, graceMs }) {
  const monitor = makeMonitor(graceMs);
  const startedMs = Date.now();
  const pieces = [];
  let reason = 'cap';
  let useReconnect = true;
  let instantFailures = 0;

  while (true) {
    const remaining = maxSeconds - (Date.now() - startedMs) / 1000;
    if (remaining < 5) { reason = 'cap'; break; }

    const piece = `${outFile}.piece${pieces.length}`;
    const pieceStartMs = Date.now();
    const res = await recordPiece(streamUrl, piece, remaining, useReconnect, monitor);
    if (fs.existsSync(piece) && fs.statSync(piece).size > 0) pieces.push(piece);

    if (res.offline) { reason = 'offline'; break; }

    const ranSec = (Date.now() - pieceStartMs) / 1000;
    if (ranSec >= remaining - 5) { reason = 'cap'; break; } // ran to its time limit normally

    // ffmpeg ended early on its own (stream hiccup). Don't give up yet.
    log(`ffmpeg ended early after ${Math.round(ranSec)}s — checking whether the broadcast is still live...`);
    if (ranSec < 5) {
      instantFailures++;
      if (instantFailures >= 2) useReconnect = false; // maybe the reconnect options aren't accepted
      if (instantFailures >= 8) { reason = 'failed'; break; }
    } else {
      instantFailures = 0;
    }
    await sleep(10000);
    await monitor.check();
    while (monitor.offlineSinceMs !== null && !monitor.offlineTooLong()) {
      await sleep(15000);
      await monitor.check();
    }
    if (monitor.offlineTooLong()) { reason = 'offline'; break; }
  }

  // End time shown in the archive: when the broadcast was last seen live
  // if it ended; otherwise now.
  const endedAt = new Date(reason === 'offline' ? monitor.lastLiveMs : Date.now());

  if (pieces.length === 0) return { reason, endedAt, hadAudio: false };

  if (pieces.length === 1) {
    fs.renameSync(pieces[0], outFile);
  } else {
    log(`joining ${pieces.length} pieces into one file...`);
    execSync(`cat ${pieces.map((p) => `"${p}"`).join(' ')} > "${outFile}"`, { shell: '/bin/bash' });
    pieces.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
  }
  return { reason, endedAt, hadAudio: true };
}

/* ============================================================
   Release + manifest/settings (on the archive-data branch)
   ============================================================ */

function ensureArchiveDataBranch() {
  try {
    sh('git fetch origin +archive-data:archive-data');
  } catch (e) {
    log('archive-data branch does not exist yet — creating it as an orphan branch.');
    const originalRef = shOut('git rev-parse HEAD').trim();
    sh('git checkout --orphan archive-data');
    sh('git rm -rf . 2>/dev/null || true');
    fs.writeFileSync('manifest.json', '[]\n');
    sh('git add manifest.json');
    sh('git -c user.name="al-hikmah-bot" -c user.email="actions@users.noreply.github.com" commit -m "Initialise archive manifest"');
    sh('git push origin archive-data');
    sh(`git checkout ${originalRef}`);
  }
}

function readManifestFromBranch() {
  try {
    const m = JSON.parse(shOut('git show archive-data:manifest.json'));
    return Array.isArray(m) ? m : [];
  } catch (e) {
    return [];
  }
}

// settings.json is written by the admin page. Currently:
//   { "hijriOffsetDays": 1 }  -> shift the computed Hijri date by +1 day
function readHijriOffsetDays() {
  try {
    execSync('git fetch origin +archive-data:archive-data', { stdio: 'ignore', shell: '/bin/bash' });
  } catch (e) { /* branch may not exist yet */ }
  try {
    const s = JSON.parse(shOut('git show archive-data:settings.json'));
    const n = Number(s && s.hijriOffsetDays);
    if (Number.isInteger(n) && n >= -5 && n <= 5) return n;
  } catch (e) { /* no settings yet */ }
  return 0;
}

function writeManifestToBranch(manifest, commitMessage) {
  const tmpDir = fs.mkdtempSync('/tmp/archive-data-');
  try {
    sh(`git worktree add "${tmpDir}" archive-data`);
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    sh(`git -C "${tmpDir}" add manifest.json`);
    sh(`git -C "${tmpDir}" -c user.name="al-hikmah-bot" -c user.email="actions@users.noreply.github.com" commit -m "${commitMessage}"`);
    sh(`git -C "${tmpDir}" push origin archive-data`);
  } finally {
    try { sh(`git worktree remove "${tmpDir}" --force`); } catch (e) {}
  }
}

// Re-reads the freshest manifest each attempt, so an admin edit made at
// the same moment is merged instead of overwritten.
function updateManifest(mutator, message) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    ensureArchiveDataBranch();
    const next = mutator(readManifestFromBranch());
    try {
      writeManifestToBranch(next, message);
      return;
    } catch (e) {
      log(`manifest update failed (attempt ${attempt}/3): ${e.message}`);
      if (attempt === 3) throw e;
    }
  }
}

/* ============================================================
   Main
   ============================================================ */

async function main() {
  log('checking live status...');
  let status = await fetchLiveStatus();

  if (!status || !status.live || !status.streamUrl) {
    log('not live right now — nothing to do.');
    return;
  }

  log(`live! source=${status.source} bitrate=${status.bitrateKbps || 'unknown'}kbps`);

  const hijriOffsetDays = readHijriOffsetDays();
  if (hijriOffsetDays) log(`Hijri date offset from admin settings: ${hijriOffsetDays > 0 ? '+' : ''}${hijriOffsetDays} day(s)`);

  const jobStartedMs = Date.now();

  while (status && status.live && status.streamUrl) {
    const elapsedMs = Date.now() - jobStartedMs;
    if (elapsedMs > JOB_SOFT_LIMIT_MS) {
      log("approaching this job's safe time limit — stopping here; the next scheduled run will pick up the rest automatically.");
      break;
    }
    const jobRemainingSec = (JOB_SOFT_LIMIT_MS - elapsedMs) / 1000;

    const startedAt = new Date();
    const deadlineMs = jumuahDeadlineMs(startedAt);
    const jumuah = deadlineMs !== null;
    const maxSeconds = jumuah
      ? Math.min((deadlineMs - startedAt.getTime()) / 1000, jobRemainingSec)
      : Math.min(SEGMENT_SECONDS, jobRemainingSec);
    if (maxSeconds < 60) break;

    const dates = allDateStrings(startedAt, hijriOffsetDays);
    const tmpFile = `/tmp/segment-${Date.now()}.mp3`;

    log(`recording ${jumuah ? 'JUMUAH segment (continuous until 3:00 PM)' : 'segment'} to ${tmpFile}`);
    log(`  Gregorian: ${dates.english}`);
    log(`  Hijri:     ${dates.hijri}`);
    log(`  Bengali:   ${dates.bengali}`);

    const result = await recordSegment(status.streamUrl, tmpFile, {
      maxSeconds,
      graceMs: jumuah ? JUMUAH_GRACE_MS : NORMAL_GRACE_MS
    });

    if (!result.hadAudio || !fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < MIN_VALID_FILE_BYTES) {
      log('recording too short or missing — skipping upload (likely a brief false-positive live reading).');
      if (result.reason === 'failed') break;
      status = await fetchLiveStatus().catch(() => null);
      continue;
    }

    const sizeBytes = fs.statSync(tmpFile).size;

    // Part number = how many recordings that day already exist + 1 (fresh read).
    ensureArchiveDataBranch();
    const part = readManifestFromBranch().filter((r) => r.iso === dates.iso).length + 1;
    const baseTag = `rec-${dates.iso}`;
    const tag = uniqueTag(part === 1 ? baseTag : `${baseTag}-part${part}`);

    const uploadFile = `/tmp/${tag}.mp3`;
    fs.renameSync(tmpFile, uploadFile);

    const title = [dates.english, dates.hijri, dates.bengali].filter(Boolean).join(' · ')
      + (jumuah ? ` · ${JUMUAH_TITLE}` : (part > 1 ? ` (part ${part})` : ''));

    log('creating GitHub Release and uploading the recording...');
    execFileSync('gh', ['release', 'create', tag, uploadFile, '--title', title, '--notes', 'Automated recording of the live broadcast.'], { stdio: 'inherit' });

    const assetUrl = shOut(`gh release view "${tag}" --json assets -q '.assets[0].url'`);

    const entry = {
      iso: dates.iso,
      english: dates.english,
      hijri: dates.hijri,
      bengali: dates.bengali,
      kind: jumuah ? 'jumuah' : 'regular',
      title: jumuah ? JUMUAH_TITLE : '',
      startTime: hhmmDhaka(startedAt),
      endTime: hhmmDhaka(result.endedAt),
      tag,
      assetUrl,
      sizeBytes,
      part,
      recordedAt: startedAt.toISOString(),
      endedAt: result.endedAt.toISOString()
    };
    updateManifest((m) => { m.push(entry); return m; }, `Add recording ${dates.iso}${part > 1 ? ` part ${part}` : ''}`);

    if (result.reason !== 'cap') break; // broadcast really ended (or ffmpeg kept failing)

    status = await fetchLiveStatus().catch(() => null);
  }

  log('done.');
}

main().catch((err) => {
  console.error('[record-live] fatal error:', err);
  process.exit(1);
});
