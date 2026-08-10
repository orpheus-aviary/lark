// Ad-hoc sign the assembled bundle (M7-1).
//
// macOS Sequoia refuses to launch an unsigned .app — it reports it as
// "damaged", which is a spectacularly misleading thing for a first-time user
// to see. There is no developer certificate here by decision (R28), so the
// bundle is signed with `-`: an ad-hoc signature, which is exactly enough for
// Gatekeeper to let a locally-downloaded app open after "右键 → 打开".
//
// This runs even though the config also sets `identity: '-'`. electron-builder
// 25 parsed that as a keychain name and silently skipped signing; 26 claims to
// handle it. Signing twice is harmless (`--force` replaces), and the
// alternative — trusting a version-dependent behaviour to produce the one
// thing that makes the app launchable — is not worth the elegance.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  process.stdout.write(`[codesign-adhoc] signing ${app}\n`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  process.stdout.write('[codesign-adhoc] verified\n');
}
