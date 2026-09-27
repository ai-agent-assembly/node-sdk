#!/usr/bin/env bash
# AAASM-6184: proves scripts/check_no_ignore_workspace.sh actually fails closed
# instead of quietly passing everything. A gate that never turns red is
# indistinguishable from no gate at all, so this exercises the failure paths —
# not just the happy path the CI step already covers.
#
# Mirrors the AAASM-5756 precedent set by
# scripts/check_contact_metadata_negative_control.sh: every case builds an
# isolated temp tree (the real working tree is never mutated), runs the real
# checker against it with --root, and asserts the exact expected exit code.
#
# The cases are chosen to pin BOTH directions, because a guard that is merely
# "always red" is as useless as one that is always green:
#   - the four reintroduction shapes that must be caught (workflow run: line,
#     package.json script, shell script, prose recommending the flag)
#   - the three rationale shapes that must NOT be caught (YAML comment,
#     JS/Rust comment, Markdown blockquote), which are how the prohibition is
#     documented in website/pnpm-workspace.yaml, publish-docs.yml and
#     .claude/CLAUDE.md
#   - the real repository tree, which must be clean
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="${REPO_ROOT}/scripts/check_no_ignore_workspace.sh"

# Assembled from two halves so this file is not itself a call site the checker
# would (correctly) flag. Every fixture below interpolates this variable rather
# than spelling the flag out.
FLAG="--ignore-""workspace"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

pass=0
fail=0

# run_case <name> <expected_exit> <relative-fixture-path> <fixture-line>
run_case() {
    local name="$1" expected_exit="$2" rel="$3" line="$4"
    local case_dir="${WORKDIR}/${name}"
    mkdir -p "${case_dir}/$(dirname "${rel}")"
    printf '%s\n' "${line}" > "${case_dir}/${rel}"

    set +e
    bash "${CHECKER}" --root "${case_dir}" >"${WORKDIR}/out" 2>&1
    local actual_exit=$?
    set -e

    if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
        echo "PASS: ${name} (exit=${actual_exit}, expected=${expected_exit})"
        pass=$((pass + 1))
    else
        echo "FAIL: ${name} (exit=${actual_exit}, expected=${expected_exit})"
        sed 's/^/    /' "${WORKDIR}/out"
        fail=$((fail + 1))
    fi
}

echo "--- must be CAUGHT (expect exit 1) ---"

# The exact defect AAASM-6184 removed from release-node.yml's docs-version job.
run_case "workflow-run-line" 1 \
    ".github/workflows/x.yml" \
    "        run: pnpm install --no-frozen-lockfile ${FLAG}"

# A package.json script is just as executable as a workflow step.
run_case "package-json-script" 1 \
    "package.json" \
    "    \"docs:install\": \"cd website && pnpm install ${FLAG}\","

# A helper shell script invoked by a workflow.
run_case "shell-script" 1 \
    "scripts/x.sh" \
    "pnpm install ${FLAG} --dir website"

# Prose that RECOMMENDS the flag. This is the shape .claude/CLAUDE.md carried on
# main: not executed itself, but a standing instruction to a human or an agent
# to reintroduce it, which is how the flag would come back.
run_case "prose-recommendation" 1 \
    "README.md" \
    "Run \`cd website && pnpm install ${FLAG}\` to install the docs site."

# A flag smuggled onto a continuation line of a multi-line run: block — the
# preceding line being a comment must not launder it.
run_case "run-block-continuation" 1 \
    ".github/workflows/y.yml" \
    "            ${FLAG} \\\\"

echo
echo "--- must be ALLOWED (expect exit 0) ---"

# How publish-docs.yml and website/pnpm-workspace.yaml document the ban.
run_case "yaml-comment-rationale" 0 \
    ".github/workflows/z.yml" \
    "        # ${FLAG} makes pnpm skip the local pnpm-workspace.yaml."

# The same rationale from a JS/TS/Rust source comment.
run_case "slash-comment-rationale" 0 \
    "src/x.ts" \
    "// Never pass ${FLAG}: it drops the security floors."

# How .claude/CLAUDE.md now states the prohibition.
run_case "markdown-blockquote-rationale" 0 \
    "docs/x.md" \
    "> Never pass \`${FLAG}\` here: it drops every security floor."

echo
echo "--- the real repository tree must be clean (expect exit 0) ---"
set +e
bash "${CHECKER}" --root "${REPO_ROOT}" >"${WORKDIR}/real" 2>&1
real_exit=$?
set -e
sed 's/^/    /' "${WORKDIR}/real"
if [[ "${real_exit}" -eq 0 ]]; then
    echo "PASS: real-tree-clean (exit=0)"
    pass=$((pass + 1))
else
    echo "FAIL: real-tree-clean (exit=${real_exit}, expected=0)"
    fail=$((fail + 1))
fi

echo
echo "${FLAG} negative control: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
