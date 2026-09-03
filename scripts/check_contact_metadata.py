#!/usr/bin/env python3
"""Sync/audit the security-contact literal against the canonical org registry.

WHY THIS EXISTS
---------------
AAASM-5756: the org's public contact identities (canonical `.com` addresses,
their legacy `.dev` aliases, and the structured security-response SLAs) are
owned by the canonical metadata registry in `ai-agent-assembly/.github`
(`metadata/org-profile.yaml`, projected to `metadata/generated/registry.json`,
per ADR 0014 / AAASM-5519). This repo's `SECURITY.md` previously hand-wrote a
paragraph pointing readers at GitHub's advisories page only, with no
published canonical address or SLA — a literal that would drift silently
once the org's contact registry moves.

This repo's `package.json` has no `author` field and its `bugs.url` is an
issue-tracker URL, not an email address — there is no npm-manifest field
analogous to python-sdk's `[project].authors[].email`, so this port has a
single consumer:

* ``SECURITY.md`` — a **bounded generated region** (BEGIN/END GENERATED:
  security_contact) carrying the canonical reporting address, the structured
  SLAs, and the labeled legacy-alias note.

CROSS-REPO DISTRIBUTION CONTRACT
--------------------------------
We **pin** the canonical registry facts to a specific `.github` commit rather
than fetching mutable `main` at build time. The pinned values live in
``CANONICAL`` below; ``REGISTRY_SOURCE`` records exactly which commit/blob they
were copied from so the pin is auditable and a re-pin is an explicit, reviewed
change. This is reproducible and network-free (CI needs no egress), and it
**fails closed**: if the pinned facts are internally inconsistent, or the
consumed file cannot be read, the check errors rather than silently passing.

Nothing here asserts the `.com` mailbox is live. The org has no Google Workspace
tenant yet (registry ``mail_platform.*_status == planned``); the legacy `.dev`
address keeps receiving via Cloudflare Email Routing during the migration. The
rendered SECURITY.md note says exactly that and never claims `.com` is sending.

This script (and its pinned ``CANONICAL``/``REGISTRY_SOURCE`` values) is
ported verbatim in shape from python-sdk's ``scripts/check_contact_metadata.py``
(AAASM-5520) — the generated region's body renders byte-identical to that
repo's, since both are projections of the same pinned registry commit.

Usage:
    python scripts/check_contact_metadata.py                  # write/sync in place
    python scripts/check_contact_metadata.py --check           # exit non-zero on drift
    python scripts/check_contact_metadata.py --root <path>     # override repo root
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Pinned canonical facts (source of truth: ai-agent-assembly/.github).
# ---------------------------------------------------------------------------
# Copied verbatim from metadata/generated/registry.json at the commit below.
# Re-pin by updating BOTH the values and REGISTRY_SOURCE in one reviewed change.
REGISTRY_SOURCE = {
    "repo": "ai-agent-assembly/.github",
    "commit": "14db28db8fa31e7a26cc29be7c1bfcd2fb0be4aa",
    "path": "metadata/generated/registry.json",
    "blob": "af1e3842984e97ca57fd0680a1f053ad6b827f04",
}

CANONICAL = {
    # contacts.security.primary + its single legacy alias.
    "security_email": "security@agent-assembly.com",
    "security_legacy_alias": "security@agent-assembly.dev",
    # security_policy.{acknowledgement,initial_assessment} as human text.
    "sla_acknowledgement": "2 business days",
    "sla_initial_assessment": "5 business days",
}


class ContactDriftError(RuntimeError):
    """Raised when a consumed file cannot be read or is structurally wrong."""


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# SECURITY.md — bounded generated region.
# ---------------------------------------------------------------------------
_BEGIN = "<!-- BEGIN GENERATED: security_contact -->"
_END = "<!-- END GENERATED: security_contact -->"


def _security_block_body() -> str:
    return "\n".join(
        [
            f"Report security vulnerabilities privately to "
            f"**{CANONICAL['security_email']}**. Do not open a public issue or "
            "discussion for a security report.",
            "",
            "| Response stage | Target |",
            "| --- | --- |",
            f"| Acknowledgement | Within {CANONICAL['sla_acknowledgement']} |",
            f"| Initial assessment | Within {CANONICAL['sla_initial_assessment']} |",
            "",
            f"> **Legacy address.** `{CANONICAL['security_legacy_alias']}` remains "
            "a legacy compatibility alias. During the in-progress migration to "
            f"the canonical `{CANONICAL['security_email']}` identity, the legacy "
            "address continues to receive mail via Cloudflare Email Routing, so "
            "a report sent there still reaches us. The canonical mailbox is not "
            "yet live-sending.",
        ]
    )


def _security_synced(text: str) -> str:
    b = text.find(_BEGIN)
    e = text.find(_END)
    if b < 0 or e < 0 or e < b:
        raise ContactDriftError(
            f"SECURITY.md: bounded region not found — expected {_BEGIN!r} ... "
            f"{_END!r}"
        )
    before = text[: b + len(_BEGIN)]
    after = text[e:]
    return f"{before}\n{_security_block_body()}\n{after}"


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def _consistency_guard() -> None:
    """Fail closed if the pinned facts are internally inconsistent."""
    if not CANONICAL["security_email"].endswith("@agent-assembly.com"):
        raise ContactDriftError("pinned security_email is not a .com address")
    if not CANONICAL["security_legacy_alias"].endswith("@agent-assembly.dev"):
        raise ContactDriftError("pinned legacy alias is not a .dev address")


def _targets(root: Path) -> dict[Path, str]:
    security = root / "SECURITY.md"
    return {
        security: _security_synced(security.read_text(encoding="utf-8")),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if any consumer file drifts from the pinned registry.",
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Repository root to check/sync (default: this script's parent repo).",
    )
    args = parser.parse_args(argv)

    root = Path(args.root).resolve() if args.root is not None else _repo_root()
    try:
        _consistency_guard()
        targets = _targets(root)
    except (ContactDriftError, FileNotFoundError, OSError) as exc:
        print(f"ERROR: contact-metadata check failed — {exc}", file=sys.stderr)
        return 2

    drifted = [
        p for p, desired in targets.items() if p.read_text(encoding="utf-8") != desired
    ]
    if not drifted:
        print("Contact metadata is in sync with the pinned registry.")
        return 0

    if args.check:
        for p in drifted:
            print(f"DRIFT: {p.relative_to(root)} does not match the registry.", file=sys.stderr)
        print("Run: python scripts/check_contact_metadata.py", file=sys.stderr)
        return 1

    for p, desired in targets.items():
        if p in drifted:
            p.write_text(desired, encoding="utf-8")
            print(f"Wrote {p.relative_to(root)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
