// The production root component.
//
// One indirection, and it earns it: `metro.config.js` redirects this specifier
// to `src/acceptance/root` when `LARK_ACCEPTANCE=1`, which is how decision o①
// gets an entry-point fork out of a toolchain that gives no other way to
// choose one (`app.config.ts` cannot set an entry file, and Gradle's is a
// generated-project detail CNG owns).
//
// The fork is at the MODULE GRAPH, not at a runtime flag, so the production
// bundle does not contain `acceptance/` at all — which is the thing a guard
// can check (`scripts/check-portable-bundles.mjs`) and a runtime flag is not.

export { App as Root } from './App';
