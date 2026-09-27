#!/usr/bin/env bash
# AAASM-6184: fail closed if pnpm's `--ignore-workspace` flag is passed at any
# call site in this repository.
#
# Why this is a security gate and not a style preference: `website/` keeps its
# 32 security version floors in `website/pnpm-workspace.yaml` (they cannot live
# in package.json's `pnpm.overrides`, which pnpm 11 ignores outright — see
# AAASM-5876 / HORO-377). `--ignore-workspace` makes pnpm skip that file, so an
# install carrying the flag resolves a tree with ZERO floors in force, exits 0,
# and prints no warning. Measured on pnpm 10 against the committed lockfile,
# adding the flag drops the lockfile's `overrides:` block from 32 entries to 0
# and re-resolves below the pinned minimums — serialize-javascript 7.0.5 ->
# 6.0.2, http-proxy-middleware 3.0.7 -> 2.0.10, ws 7.5.13 reintroduced
# alongside 8.21.0, qs 6.16.0 -> 6.14.2/6.15.3, uuid 8.3.2 reintroduced.
#
# The flag was removed from publish-docs.yml under AAASM-6106 and from
# release-node.yml's docs-version job under AAASM-6184. Nothing stopped it
# coming back, in either workflow or in a new one, which is what this does.
#
# What counts as a violation: the literal appearing anywhere it would actually
# reach pnpm, or anywhere it is being *recommended* (e.g. a README or agent
# instruction file telling a human or an agent to pass it). Explaining why the
# flag is banned is fine, but only from a comment or blockquote line — see
# ALLOWED PREFIXES below. Placing the rationale in a comment is what keeps this
# guard's own explanatory text, and the matching blocks in
# website/pnpm-workspace.yaml / publish-docs.yml, from tripping it.
#
# Known limitation, stated rather than hidden: a fixed-string scan cannot catch
# a flag assembled at runtime (`--ignore-${x}`, a variable, base64). This raises
# the cost of an accidental reintroduction to "impossible by copy-paste"; it is
# not a defence against someone deliberately evading it.
#
# The negative control (scripts/check_no_ignore_workspace_negative_control.sh)
# proves this script actually turns red, mirroring the AAASM-5756 precedent set
# by check_contact_metadata_negative_control.sh.
set -euo pipefail

# Assembled from two halves on purpose: written as one literal, this line would
# itself be a call site the scan below correctly flags (it is not a comment).
FLAG="--ignore-""workspace"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--root" ]]; then
    ROOT="$(cd "$2" && pwd)"
fi

# Directories that are never a call site: dependency/build output, VCS
# internals, and verification-reports/ — dated, append-only evidence files that
# record what was run at the time and are deliberately not rewritten. Excluding
# generated trees is not a hole: nothing under them is executed by this repo's
# own workflows or scripts.
EXCLUDES=(
    --exclude-dir=.git
    --exclude-dir=node_modules
    --exclude-dir=target
    --exclude-dir=dist
    --exclude-dir=build
    --exclude-dir=.pnpm-store
    --exclude-dir=coverage
    --exclude-dir=verification-reports
    --exclude-dir=versioned_docs
)

# `-F` (fixed string) deliberately: no regex groups, so the scan cannot silently
# under-match the way an alternation-heavy pattern can.
matches="$(grep -rnF "${EXCLUDES[@]}" -- "$FLAG" "$ROOT" 2>/dev/null || true)"

violations=0
allowed=0

while IFS= read -r match; do
    [[ -n "$match" ]] || continue
    # grep -rn output is <path>:<lineno>:<text>
    path="${match%%:*}"
    rest="${match#*:}"
    lineno="${rest%%:*}"
    text="${rest#*:}"

    # ALLOWED PREFIXES: the first non-whitespace characters of the line mark it
    # as commentary rather than something pnpm receives or a reader copies.
    #   #   YAML / shell / Python / TOML comment
    #   //  JS / TS / Rust comment
    #   *   continuation line of a /* */ or JSDoc block
    #   >   Markdown blockquote (how prose files state the prohibition)
    stripped="${text#"${text%%[![:space:]]*}"}"
    case "$stripped" in
        '#'* | '//'* | '*'* | '>'*)
            allowed=$((allowed + 1))
            continue
            ;;
    esac

    if [[ "$violations" -eq 0 ]]; then
        echo "FAIL: pnpm's ${FLAG} flag must not be used anywhere in this repository." >&2
        echo "      It makes pnpm skip website/pnpm-workspace.yaml, silently dropping" >&2
        echo "      all 32 security version floors. See AAASM-6106 / AAASM-6184." >&2
        echo "      If you need to explain the prohibition, put it on a comment (#, //)" >&2
        echo "      or Markdown blockquote (>) line." >&2
        echo >&2
        echo "Offending call sites:" >&2
    fi
    violations=$((violations + 1))
    printf '  %s:%s: %s\n' "${path#"$ROOT"/}" "$lineno" "$stripped" >&2
done <<< "$matches"

if [[ "$violations" -gt 0 ]]; then
    echo >&2
    echo "${violations} violation(s); ${allowed} allowed rationale mention(s)." >&2
    exit 1
fi

echo "OK: no ${FLAG} call site found (${allowed} allowed rationale mention(s) in comments/blockquotes)."
