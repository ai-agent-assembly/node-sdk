/**
 * AAASM-5750 — AAASM-5681 must not be the referent of a forward-looking claim.
 *
 * The rule this gate enforces comes from **AAASM-5750's own description**, not
 * from ADR 0033 §6. §6 requires that `Planned` carry *a* ticket reference and
 * says nothing about which ticket; naming the right one is 5750's decision.
 * Stating the source precisely matters, because a failure message citing an ADR
 * for a rule the ADR does not contain sends the next reader to the wrong
 * document.
 *
 * The defect: AAASM-5681 measured that both shipped gateway clients discard the
 * hook-layer audit event. It never intended to build a sink. A forward-looking
 * claim pointing at it will read as a live commitment while resolving to
 * finished work the moment it closes. So the invariant is narrow and permanent
 * — **AAASM-5681 may be cited as the ticket that measured the drop, never as
 * the ticket that will fix it.**
 *
 * Deliberately NOT asserted: that every `Planned` in this repository names
 * AAASM-5750. §6 scopes `Planned` to any decided-but-unbuilt capability with any
 * ticket, so an unrelated roadmap row is legitimate and must not fail this gate.
 * The first version of this test made exactly that over-broad assertion.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tickets that *measured* the absence of an SDK-side audit sink. Backward
 * citations to them are correct and are left alone; what this gate forbids is
 * either one appearing as the ticket a forward-looking claim defers to.
 */
const STALE_REFERENTS = new Set(["AAASM-5681", "AAASM-5731"]);

/**
 * The two shapes a deferral takes: the ADR 0033 §6 term, and the plain
 * "tracked as" pointer used in `with-assembly.ts`, where no term is stated.
 * Covering both is why that site is checked rather than merely corrected — the
 * first version keyed on the term alone and left it unguarded.
 */
const FORWARD_CLAIM = /\bPlanned\b|tracked as/;
const TICKET_REF = /AAASM-\d+/;
const SCANNED_SUFFIXES = [".ts", ".md"];
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".docusaurus"]);

const REPO_ROOT = resolve(__dirname, "..");

/**
 * Excluded from its own scan. Including it was the first version's defect: this
 * file names AAASM-5750 in its own header, which padded the site count and let
 * the floor be satisfied entirely by the gate quoting itself — green over a tree
 * with no real site left in it.
 */
const GATE_FILE = join("tests", "planned-referent.test.ts");

/**
 * Audit-sink deferrals that must remain reachable by the scan. A fixture
 * compared against a walk of the tree, not a constant compared against another
 * constant: if a site is deleted, renamed, or reflowed out of the scan's reach,
 * the walk stops finding it and this fails.
 */
const EXPECTED_SITES = [
  join("src", "types", "gateway-governance.ts"),
  join("src", "wrappers", "with-assembly.ts")
];

interface DeferralSite {
  path: string;
  line: number;
  ticket: string;
  text: string;
}

function scan(dir: string, sites: DeferralSite[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;

    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full, sites);
      continue;
    }

    if (!SCANNED_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;

    const rel = relative(REPO_ROOT, full);
    if (rel === GATE_FILE) continue;

    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!FORWARD_CLAIM.test(line)) return;

      // The ticket is looked for on the claim's own line **and the line after
      // it**. One line is not enough: the sibling Python SDK wraps `Planned`
      // and its ticket onto separate lines, and a same-line-only scan skipped
      // that site while its PR claimed coverage. Whether a site is checked must
      // not depend on where a comment happens to wrap.
      const next = lines[index + 1];
      const window = next === undefined ? line : `${line}\n${next}`;

      const ticket = TICKET_REF.exec(window);
      if (ticket === null) return;

      sites.push({
        path: rel,
        line: index + 1,
        ticket: ticket[0],
        text: line.trim()
      });
    });
  }
}

function deferralSites(): DeferralSite[] {
  const sites: DeferralSite[] = [];
  scan(REPO_ROOT, sites);
  return sites;
}

describe("AAASM-5750: no forward claim defers to a closed measurement ticket", () => {
  it("never names a measuring ticket as the one that will fix it", () => {
    const wrong = deferralSites().filter((site) => STALE_REFERENTS.has(site.ticket));
    expect(
      wrong.map(
        (site) =>
          `${site.path}:${site.line} defers to ${site.ticket}, which measured ` +
          `the drop and will not fix it — use the ticket that builds the sink ` +
          `(AAASM-5750, per its own description): ${site.text}`
      )
    ).toEqual([]);
  });

  it("still reaches every site it is supposed to guard", () => {
    // Anti-vacuity, and the reason it names paths rather than counting: a count
    // can be held up by an unrelated site appearing as a real one is deleted.
    // Naming them makes that substitution visible.
    const seen = new Set(deferralSites().map((site) => site.path));
    const missing = EXPECTED_SITES.filter((path) => !seen.has(path));
    expect(
      missing.map(
        (path) =>
          `${path} carries no forward claim the scan can pair with a ticket; ` +
          `it was deleted, renamed, or reflowed so the claim and the ticket ` +
          `are more than one line apart — in which case a stale referent ` +
          `there would no longer be checked`
      )
    ).toEqual([]);
  });
});
