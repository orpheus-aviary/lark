// HOST script (Node, desktop) — criterion 26's backup-exclusion half.
//
// Three layers, in the subplan's order, and each answers a different question:
//
//   1. **the merged manifest of the BUILT APK** — not `app.config.ts`, not the
//      generated `AndroidManifest.xml`. Everything before the APK is an
//      intention; the manifest inside it is what the system reads. It is also
//      where a second plugin quietly winning would show up;
//   2. **the two rule files, read out of the APK's compiled resources** — a
//      manifest attribute pointing at an empty or half-written XML would pass
//      layer 1 perfectly;
//   3. **the backup manager's own answer** — `bmgr backupnow` on the device.
//      A control package that DOES allow backup runs in the same pass, because
//      "Backup is not allowed" only means something if something else in the
//      same run says "Success".
//
//   node scripts/backup-audit.mjs            # or: just spike-mobile-backup-audit
//
// Layer 3 needs the device; layers 1 and 2 only need the APK.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ANDROID_HOME = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const ADB = `${ANDROID_HOME}/platform-tools/adb`;
const AAPT2 = `${ANDROID_HOME}/build-tools/36.0.0/aapt2`;
const PACKAGE = 'com.orpheusaviary.lark.spike';
/** A system package known to permit backup — layer 3's control. */
const CONTROL_PACKAGE = 'com.android.providers.settings';
const LOCAL_TRANSPORT = 'com.android.localtransport/.LocalTransport';

const APK =
  process.argv[2] ??
  fileURLToPath(
    new URL('../android/app/build/outputs/apk/release/app-release.apk', import.meta.url),
  );

/** Every domain `plugins/with-backup-rules.js` claims to exclude. */
const DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];

const capture = (bin, args) =>
  execFileSync(bin, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
const aapt2 = (...args) => capture(AAPT2, args);
const adb = (...args) => capture(ADB, args);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${detail}`);
};

if (!existsSync(APK)) {
  console.error(`✗ no APK at ${APK}`);
  console.error('  build one first: just spike-mobile-android-release');
  process.exit(2);
}
console.log(`APK: ${APK}\n`);

// ── layer 1: the merged manifest ────────────────────────────────────────────

const manifest = aapt2('dump', 'xmltree', APK, '--file', 'AndroidManifest.xml');

const attribute = (name) => {
  const match = new RegExp(`android:${name}\\([^)]*\\)=(\\S+)`).exec(manifest);
  return match?.[1] ?? null;
};

check(
  'allowBackup is false',
  attribute('allowBackup') === 'false',
  `android:allowBackup=${attribute('allowBackup')}`,
);

// Compiled references are numeric ids; the resource table is what turns them
// back into names. Reading the source tree instead would be checking that we
// wrote a file, not that the APK points at it.
const resources = aapt2('dump', 'resources', APK);
const resourceById = new Map();
for (const m of resources.matchAll(/resource (0x[0-9a-f]+) (\S+)\n\s+\(\) \(file\) (\S+)/g)) {
  resourceById.set(m[1], { name: m[2], file: m[3] });
}

const resolved = (attributeName) => {
  const raw = attribute(attributeName);
  if (raw === null) return null;
  return resourceById.get(raw.startsWith('@') ? raw.slice(1) : raw) ?? null;
};

const rulePointers = [
  ['dataExtractionRules', 'xml/lark_data_extraction_rules'],
  ['fullBackupContent', 'xml/lark_backup_rules'],
];

for (const [attributeName, expected] of rulePointers) {
  const target = resolved(attributeName);
  check(
    `${attributeName} points at ours`,
    target?.name === expected,
    `${attribute(attributeName)} → ${target?.name ?? 'unresolved'} (${target?.file ?? '—'})`,
  );
}

// ── layer 2: the rule files themselves ──────────────────────────────────────

const ruleTree = (attributeName) => {
  const target = resolved(attributeName);
  if (target === null) return '';
  return aapt2('dump', 'xmltree', APK, '--file', target.file);
};

const domainsIn = (tree, section) => {
  // `data-extraction-rules` nests its excludes under cloud-backup /
  // device-transfer; `full-backup-content` has one flat list.
  if (section === null) return [...tree.matchAll(/A: domain="([a-z_]+)"/g)].map((m) => m[1]);
  const start = tree.indexOf(`E: ${section}`);
  if (start < 0) return [];
  const rest = tree.slice(start + 1);
  const end = rest.search(/\n {4}E: /);
  const body = end < 0 ? rest : rest.slice(0, end);
  return [...body.matchAll(/A: domain="([a-z_]+)"/g)].map((m) => m[1]);
};

const extraction = ruleTree('dataExtractionRules');
for (const section of ['cloud-backup', 'device-transfer']) {
  const found = domainsIn(extraction, section);
  const missing = DOMAINS.filter((d) => !found.includes(d));
  check(
    `data-extraction-rules <${section}> excludes every domain`,
    missing.length === 0 && found.length === DOMAINS.length,
    missing.length === 0
      ? `${found.length} domains: ${found.join(' ')}`
      : `missing: ${missing.join(' ')}`,
  );
}

const fullDomains = domainsIn(ruleTree('fullBackupContent'), null);
const missingFull = DOMAINS.filter((d) => !fullDomains.includes(d));
check(
  'full-backup-content excludes every domain (API ≤30 — static check only)',
  missingFull.length === 0,
  missingFull.length === 0
    ? `${fullDomains.length} domains; the frozen device is API 35, so this file is never exercised here`
    : `missing: ${missingFull.join(' ')}`,
);

// ── layer 3: the backup manager ─────────────────────────────────────────────

let deviceReachable = true;
try {
  adb('shell', 'true');
} catch {
  deviceReachable = false;
}

if (!deviceReachable) {
  console.log('\n— no device: layer 3 (bmgr) skipped —');
} else {
  console.log(`\n${adb('shell', 'bmgr', 'transport', LOCAL_TRANSPORT).trim()}`);

  const ours = adb('shell', 'bmgr', 'backupnow', PACKAGE);
  check(
    'the backup manager refuses to back us up',
    /Backup is not allowed/.test(ours),
    ours
      .split('\n')
      .find((l) => l.includes(PACKAGE))
      ?.trim() ?? ours.trim(),
  );

  // The control. Without it, "not allowed" could equally mean the transport is
  // broken, backup is off, or bmgr says that about everything.
  const control = adb('shell', 'bmgr', 'backupnow', CONTROL_PACKAGE);
  check(
    'a package that DOES allow backup succeeds in the same run',
    /with result: Success/.test(control) && !/Backup is not allowed/.test(control),
    control
      .split('\n')
      .find((l) => l.includes(CONTROL_PACKAGE))
      ?.trim() ?? control.trim(),
  );

  const participants = adb('shell', 'dumpsys', 'backup');
  check(
    'we are not a backup participant',
    !participants.includes(PACKAGE),
    participants.includes(PACKAGE)
      ? 'the package appears in dumpsys backup'
      : 'dumpsys backup does not mention the package at all',
  );

  // Restore side: ask for our package out of the local set and show the
  // transport has nothing to give back.
  const sets = adb('shell', 'bmgr', 'list', 'sets');
  const token = /^\s*(\S+)\s*:/m.exec(sets)?.[1] ?? null;
  if (token === null) {
    check('a restore of our package brings nothing back', false, `no backup set: ${sets.trim()}`);
  } else {
    const restore = adb('shell', 'bmgr', 'restore', token, PACKAGE);
    check(
      'a restore of our package brings nothing back',
      !/restoring: /i.test(restore),
      restore.trim().split('\n').slice(-3).join(' | '),
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
