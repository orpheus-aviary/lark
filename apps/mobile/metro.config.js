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

module.exports = config;
