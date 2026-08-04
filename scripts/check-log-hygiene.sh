#!/usr/bin/env bash
# log-hygiene guard (M2-15). Violations are judged by NON-EMPTY captured
# output, decoupled from rg's exit codes (rg exits 1 on "no match" — that is
# our PASS state, so bare rg in a recipe would invert the semantics).
#
# This is a BOUNDED APPROXIMATION: a variable indirection or a call longer than
# the window slips through. Red means definitely wrong; green does not mean
# definitely right. It is the outermost of three layers — the redact unit tests
# and the Public-projection convention (log `redactConfig(cfg)`, never a config
# object) are the other two.
set -u
viol=0
SRC=(packages/core/src packages/daemon/src)

report() { # $1 = rule label, $2 = captured output
  if [ -n "$2" ]; then
    printf '[log-hygiene] %s:\n%s\n' "$1" "$2" >&2
    viol=1
  fi
}

# 1) direct console writes (line-level waiver: `// log-hygiene: console-ok`)
report "console" "$(rg -n 'console\.(log|error|warn)' "${SRC[@]}" -g '!*.test.ts' \
    | grep -v 'log-hygiene: console-ok' || true)"

# 2) secret FIELD (incl. shorthand) inside a logger call, 200-char window —
#    field position only, so message text like "token rotated" never matches
report "secret-field" "$(rg -nU \
    'logger\.\w+\([\s\S]{0,200}?[{,]\s*(token|api_key|authorization)\s*[:,}]' \
    "${SRC[@]}" -g '!*.test.ts' || true)"

# 3) whole-config injection (field name / spread / direct ctx.config)
report "config-object" "$(rg -nU \
    'logger\.\w+\([\s\S]{0,200}?(config:\s|\.\.\.\s*(ctx\.)?config\b|\bctx\.config\s*[,)])' \
    "${SRC[@]}" -g '!*.test.ts' || true)"

if [ "$viol" -eq 0 ]; then
  echo "✓ log hygiene: no direct console writes, no secrets or config objects in log calls"
fi
exit "$viol"
