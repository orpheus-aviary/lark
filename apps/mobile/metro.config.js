// Metro, told about the monorepo (N2a; same shape the spike proved in N0b-1).
//
// CommonJS on purpose: this package has no `"type": "module"`, because Metro
// and Babel read their configs as CJS. Application source is still ESM
// TypeScript — Babel does not care.
//
// The two settings below are what make the bundle smoke mean anything: Metro
// has to follow `@lark/core/portable` and `@lark/shared` through the workspace
// links to `packages/*/dist`, and it will not watch a folder nobody told it
// about. `disableHierarchicalLookup` keeps resolution to these two roots, so a
// package that resolves only because something hoisted it into an ancestor
// directory fails here instead of on a phone — which is also why this app
// declares core's own runtime deps (`drizzle-orm`, `@noble/hashes`, the
// skybridge SDK) as its own.

const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// Decision o①: `LARK_ACCEPTANCE=1` swaps the root component, and it does so by
// redirecting one specifier rather than by branching at runtime. The point of
// doing it here is what it makes checkable — the production bundle's module
// graph contains no `acceptance/` module at all, which a guard can assert and
// a runtime flag could never be trusted about.
//
// Two artifacts, not two flags stacked (decision o②): `just
// mobile-android-release` builds the product, `just mobile-acceptance-release`
// builds the same package, same signing, with this redirect on. They cannot be
// installed side by side, and that is the accepted cost of D16's criteria
// testing the SAME package the user gets.
const ROOT_SPECIFIER = './src/root';
const ACCEPTANCE_ROOT = './src/acceptance/root';

if (process.env.LARK_ACCEPTANCE === '1') {
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolve = upstream ?? context.resolveRequest;
    if (moduleName === ROOT_SPECIFIER && context.originModulePath.startsWith(projectRoot)) {
      return resolve(context, ACCEPTANCE_ROOT, platform);
    }
    return resolve(context, moduleName, platform);
  };
}

module.exports = config;
