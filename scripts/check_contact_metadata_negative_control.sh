#!/usr/bin/env bash
# AAASM-5756: proves check_contact_metadata.py --check actually fails closed
# instead of quietly passing everything. A gate that never turns red is
# indistinguishable from no gate at all — this exercises the failure paths,
# not just the happy path scripts/check_contact_metadata.py --check already
# covers in CI.
#
# Each case copies the real SECURITY.md into an isolated temp directory
# (never mutates the working tree) and asserts the *exact* exit code the
# script's own control flow produces for that failure class:
#   - the generated region markers being absent is a structural error that
#     _security_synced() raises as ContactDriftError -> main()'s except ->
#     return 2 (AC#4's required case: the region can be dropped entirely).
#   - a value inside the markers drifting from the pinned CANONICAL values
#     leaves the markers intact, so it flows through the normal `drifted`
#     comparison -> --check's `return 1` path.
# Collapsing these two into "any non-zero" would let a regression that always
# returns the same code pass silently, so each case pins its own code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/check_contact_metadata.py"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

pass=0
fail=0

run_case() {
    local name="$1" expected_exit="$2" mutate_fn="$3"
    local case_dir="${WORKDIR}/${name}"
    mkdir -p "${case_dir}"
    cp "${REPO_ROOT}/SECURITY.md" "${case_dir}/SECURITY.md"
    "${mutate_fn}" "${case_dir}/SECURITY.md"

    set +e
    python3 "${SCRIPT}" --check --root "${case_dir}" >/tmp/nc_stdout.$$ 2>/tmp/nc_stderr.$$
    local actual_exit=$?
    set -e

    if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
        echo "PASS: ${name} (exit=${actual_exit}, expected=${expected_exit})"
        pass=$((pass + 1))
    else
        echo "FAIL: ${name} (exit=${actual_exit}, expected=${expected_exit})"
        echo "  --- stdout ---"; sed 's/^/  /' /tmp/nc_stdout.$$
        echo "  --- stderr ---"; sed 's/^/  /' /tmp/nc_stderr.$$
        fail=$((fail + 1))
    fi
    rm -f /tmp/nc_stdout.$$ /tmp/nc_stderr.$$
}

mutate_clean() { :; }

mutate_region_removed() {
    # AC#4: the generated region can be dropped entirely (not just edited).
    sed -i.bak '/<!-- BEGIN GENERATED: security_contact -->/,/<!-- END GENERATED: security_contact -->/d' "$1"
    rm -f "$1.bak"
}

mutate_email_drift() {
    sed -i.bak 's/security@agent-assembly\.com/security@agent-assembly.dev/' "$1"
    rm -f "$1.bak"
}

mutate_day_count_drift() {
    sed -i.bak 's/Within 2 business days/Within 3 business days/' "$1"
    rm -f "$1.bak"
}

mutate_sla_label_drift() {
    sed -i.bak 's/Initial assessment/Initial response/' "$1"
    rm -f "$1.bak"
}

run_case "clean-copy" 0 mutate_clean
run_case "region-removed" 2 mutate_region_removed
run_case "email-drifted-to-dev" 1 mutate_email_drift
run_case "day-count-drifted" 1 mutate_day_count_drift
run_case "sla-label-drifted" 1 mutate_sla_label_drift

echo
echo "contact-metadata negative control: ${pass} passed, ${fail} failed"

# Prove the mutations above never touched the real tree.
python3 "${SCRIPT}" --check --root "${REPO_ROOT}"
echo "Real SECURITY.md untouched and still in sync."

[[ "${fail}" -eq 0 ]]
