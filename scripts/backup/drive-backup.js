#!/usr/bin/env node
// Google Drive helper for the nightly DB backup workflow (#49).
//
// Dependency-free on purpose: the backup job runs in GitHub Actions where a
// full `npm ci` would slow every nightly run and add supply-chain surface.
// Everything here is built-in Node (>=20 for global fetch): a hand-rolled
// service-account JWT (RS256 via node:crypto) exchanged for an OAuth token,
// then plain Drive API v3 REST calls. All Drive calls pass
// supportsAllDrives=true so the backup folder may live on a Shared Drive.
//
// Env (set as GitHub Actions secrets — values never live in the repo):
//   BACKUP_GDRIVE_SA_KEY    full service-account key JSON
//   BACKUP_GDRIVE_FOLDER_ID id of the Drive folder that holds the backups
//                           (share the folder with the SA's client_email,
//                           Editor access, or put it on a Shared Drive the
//                           SA is a member of)
//
// Subcommands:
//   upload <path> [remoteName]   upload a file into the backup folder
//   prune                        apply retention: keep the 30 most recent
//                                dailies + the first backup of each of the
//                                last 12 months; delete the rest (and their
//                                sidecar .manifest.json files)
//   latest                       print JSON {id,name,manifestId,manifestName}
//                                for the newest rw-backup-*.dump.gpg
//   download <fileId> <dest>     download a file by id
//   swap-db <newDbName>          read BACKUP_DATABASE_URL from env, print the
//                                same URL pointed at a different database —
//                                used by restore-test to build the scratch-DB
//                                connection string
//   compare <manifest.json> <counts.json>
//                                compare restored row counts against the
//                                manifest written at backup time; prints a
//                                PASS/FAIL summary, exits 1 on FAIL
//
// The pure helpers (chooseBackupsToDelete, swapDbName, compareManifest) are
// exported for scripts/test-dr-backup.js.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const DUMP_RE = /^rw-backup-(\d{4}-\d{2}-\d{2})\.dump\.gpg$/;

// Row-count tables recorded in the manifest at backup time and re-checked
// after the test restore. Keep in sync with the psql json_build_object list
// in .github/workflows/db-backup.yml.
const MANIFEST_TABLES = ['registrations', 'people', 'kids', 'kid_enrollments', 'waiver_signatures'];

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

// Retention policy: given the backup DATES present in Drive (YYYY-MM-DD
// strings) and today's date, return the dates whose backups should be
// DELETED. Keep = the 30 most recent dates, plus the earliest backup within
// each of the last 12 calendar months (today's month counts as month 1) —
// the "first-of-month keepers".
function chooseBackupsToDelete(dates, todayStr) {
  const uniq = Array.from(new Set(dates)).sort(); // ascending
  const keep = new Set(uniq.slice(-30));
  const m = /^(\d{4})-(\d{2})/.exec(String(todayStr || ''));
  if (m) {
    const ty = parseInt(m[1], 10);
    const tm = parseInt(m[2], 10); // 1-based
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
      const monthKey = d.toISOString().slice(0, 7);
      const first = uniq.find((x) => x.slice(0, 7) === monthKey);
      if (first) keep.add(first);
    }
  }
  return uniq.filter((d) => !keep.has(d));
}

// Point a postgres:// URL at a different database, preserving credentials,
// host, port and query string (?sslmode=require etc.).
function swapDbName(dbUrl, newDbName) {
  const u = new URL(dbUrl);
  u.pathname = '/' + newDbName;
  return u.toString();
}

// Compare restored row counts against the backup-time manifest.
// Returns { pass, lines } — lines are human-readable per-table results.
function compareManifest(manifest, counts) {
  const lines = [];
  let pass = true;
  for (const t of MANIFEST_TABLES) {
    const want = Number(manifest[t]);
    const got = Number(counts[t]);
    if (!Number.isFinite(want) || !Number.isFinite(got)) {
      pass = false;
      lines.push(`  ✗ ${t}: missing count (manifest=${manifest[t]}, restored=${counts[t]})`);
    } else if (want !== got) {
      pass = false;
      lines.push(`  ✗ ${t}: manifest=${want}, restored=${got}`);
    } else {
      lines.push(`  ✓ ${t}: ${got} rows`);
    }
  }
  return { pass, lines };
}

// ── Drive API plumbing ─────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken() {
  const raw = process.env.BACKUP_GDRIVE_SA_KEY;
  if (!raw) throw new Error('BACKUP_GDRIVE_SA_KEY is not set');
  const key = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Full drive scope: the SA can only see what's explicitly shared with it,
  // and prune/download must operate on files regardless of which run
  // uploaded them (drive.file scope would wall off files by "app").
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claims), key.private_key);
  const jwt = header + '.' + claims + '.' + b64url(sig);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
      + '&assertion=' + encodeURIComponent(jwt),
  });
  if (!res.ok) throw new Error('token exchange failed: ' + res.status + ' ' + (await res.text()));
  const data = await res.json();
  return data.access_token;
}

function folderId() {
  const raw = String(process.env.BACKUP_GDRIVE_FOLDER_ID || '').trim();
  if (!raw) throw new Error('BACKUP_GDRIVE_FOLDER_ID is not set');
  // Humans paste the whole Drive URL (first live setup, 2026-07-22) —
  // accept either the bare id or any .../folders/<id> URL.
  const m = raw.match(/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : raw;
}

async function driveList(token) {
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId()}' in parents and trashed = false`);
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + q
      + '&fields=' + encodeURIComponent('nextPageToken,files(id,name,size)')
      + '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true'
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('list failed: ' + res.status + ' ' + (await res.text()));
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function driveUpload(token, localPath, remoteName) {
  const meta = JSON.stringify({ name: remoteName, parents: [folderId()] });
  const content = fs.readFileSync(localPath);
  const boundary = 'rwbackup' + crypto.randomBytes(12).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'multipart/related; boundary=' + boundary,
    },
    body,
  });
  if (!res.ok) throw new Error('upload failed: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

async function driveDelete(token, fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?supportsAllDrives=true', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok && res.status !== 404) throw new Error('delete failed: ' + res.status + ' ' + (await res.text()));
}

async function driveDownload(token, fileId, dest) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('download failed: ' + res.status + ' ' + (await res.text()));
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ── Subcommands ────────────────────────────────────────────────────────────

async function cmdUpload(localPath, remoteName) {
  const name = remoteName || localPath.split(/[\\/]/).pop();
  const token = await accessToken();
  const out = await driveUpload(token, localPath, name);
  console.log('uploaded ' + name + ' (id ' + out.id + ')');
}

async function cmdPrune() {
  const token = await accessToken();
  const files = await driveList(token);
  const byDate = new Map(); // date -> [file,...] (dump + manifest sidecars)
  for (const f of files) {
    const dumpMatch = DUMP_RE.exec(f.name);
    const maniMatch = /^rw-backup-(\d{4}-\d{2}-\d{2})\.manifest\.json$/.exec(f.name);
    const date = dumpMatch ? dumpMatch[1] : (maniMatch ? maniMatch[1] : null);
    if (!date) continue; // never touch files this job didn't create
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(f);
  }
  const dumpDates = files.filter((f) => DUMP_RE.test(f.name)).map((f) => DUMP_RE.exec(f.name)[1]);
  const today = new Date().toISOString().slice(0, 10);
  const doomed = chooseBackupsToDelete(dumpDates, today);
  if (doomed.length === 0) { console.log('prune: nothing to delete (' + dumpDates.length + ' backups kept)'); return; }
  for (const date of doomed) {
    for (const f of byDate.get(date) || []) {
      await driveDelete(token, f.id);
      console.log('pruned ' + f.name);
    }
  }
  console.log('prune: deleted ' + doomed.length + ' backup day(s), kept ' + (dumpDates.length - doomed.length));
}

async function cmdLatest() {
  const token = await accessToken();
  const files = await driveList(token);
  const dumps = files.filter((f) => DUMP_RE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (dumps.length === 0) throw new Error('no rw-backup-*.dump.gpg files found in the backup folder');
  const newest = dumps[dumps.length - 1];
  const maniName = newest.name.replace(/\.dump\.gpg$/, '.manifest.json');
  const mani = files.find((f) => f.name === maniName) || null;
  console.log(JSON.stringify({
    id: newest.id,
    name: newest.name,
    manifestId: mani ? mani.id : null,
    manifestName: mani ? mani.name : null,
  }));
}

async function cmdDownload(fileId, dest) {
  const token = await accessToken();
  const n = await driveDownload(token, fileId, dest);
  console.log('downloaded ' + n + ' bytes to ' + dest);
}

function cmdSwapDb(newDbName) {
  const url = process.env.BACKUP_DATABASE_URL;
  if (!url) throw new Error('BACKUP_DATABASE_URL is not set');
  if (!/^[A-Za-z0-9_]+$/.test(newDbName || '')) throw new Error('swap-db: db name must be [A-Za-z0-9_]+');
  process.stdout.write(swapDbName(url, newDbName));
}

function cmdCompare(manifestPath, countsPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const counts = JSON.parse(fs.readFileSync(countsPath, 'utf8'));
  const { pass, lines } = compareManifest(manifest, counts);
  console.log('Restore-test row-count check (' + (manifest.backup_date || 'unknown backup date') + '):');
  for (const l of lines) console.log(l);
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (!pass) process.exit(1);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'upload' && a) return cmdUpload(a, b);
  if (cmd === 'prune') return cmdPrune();
  if (cmd === 'latest') return cmdLatest();
  if (cmd === 'download' && a && b) return cmdDownload(a, b);
  if (cmd === 'swap-db' && a) return cmdSwapDb(a);
  if (cmd === 'compare' && a && b) return cmdCompare(a, b);
  console.error('usage: drive-backup.js upload <path> [name] | prune | latest | download <id> <dest> | swap-db <dbname> | compare <manifest.json> <counts.json>');
  process.exit(2);
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}

module.exports = { chooseBackupsToDelete, swapDbName, compareManifest, MANIFEST_TABLES };
