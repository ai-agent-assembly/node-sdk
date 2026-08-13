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
 * The assertion is two-tier, because one tier alone fails in one direction or
 * the other and review caught both:
 *
 *   - a **guarded** site (one of `EXPECTED_SITES`) must name AAASM-5750 exactly.
 *     Without this the gate stops asserting the thing the change made true —
 *     repointing a guarded site to any other live ticket passed green, which is
 *     precisely the drift the gate exists to catch.
 *   - **any other** site must merely not name a stale referent. Asserting
 *     AAASM-5750 repo-wide was the first version's defect: §6 scopes `Planned`
 *     to any decided-but-unbuilt capability with any ticket, so an unrelated
 *     roadmap row is legitimate and must not fail this gate.
 *
 * Two limits are disclosed rather than fixed, both measured as currently
 * unreachable:
 *
 *   - the reachability check is per **file**, not per site. A guarded file that
 *     reflowed its real site out of the scan's reach AND gained a second,
 *     correct claim would keep its entry. Requires two coordinated edits; today
 *     no file in this repo carries more than one site.
 *   - the gate file is excluded from its own scan, so it is a hiding place for a
 *     stale referent. It is a test file that documents no SDK behaviour, and the
 *     exclusion matches one exact path rather than a prefix.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tickets that *measured* the absence of an SDK-side audit sink. Backward
 * citations to them are correct and are left alone; what this gate forbids is
 * either one appearing as the ticket a forward-looking claim defers to.
 */
/** The ticket that owns building the SDK-side audit sink. Guarded sites must name it exactly. */
const CAPABILITY_REFERENT = "AAASM-5750";

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

/**
 * Whether a comment line closes a sentence. A wrapped sentence (`… Planned
 * under ADR 0033 §6` / `(AAASM-5750) …`) does not; a complete one does.
 */
function endsSentence(line: string): boolean {
  const trimmed = line.trim().replace(/[*/\s]+$/, "");
  return trimmed.length > 0 && ".!?".includes(trimmed[trimmed.length - 1]!);
}

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
      // Extend to the next line only when this line carries no ticket of its
      // own AND does not end a sentence. Without the sentence guard the window
      // pairs a claim with a ticket belonging to the *next* sentence — review
      // produced a real case where an inserted line of forward-looking prose
      // was blamed for a correct backward citation beneath it. There are 18
      // such backward citations in this repo.
      const next = lines[index + 1];
      const extend = !TICKET_REF.test(line) && !endsSentence(line) && next !== undefined;
      const window = extend ? `${line}\n${next}` : line;

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

describe("AAASM-5750: forward claims name the right ticket", () => {
  it("holds guarded sites to the capability ticket, and everything else off the stale ones", () => {
    const guarded = new Set(EXPECTED_SITES);
    const problems: string[] = [];

    for (const site of deferralSites()) {
      if (guarded.has(site.path)) {
        if (site.ticket !== CAPABILITY_REFERENT) {
          problems.push(
            `${site.path}:${site.line} is a guarded audit-sink deferral and ` +
              `must name ${CAPABILITY_REFERENT}, not ${site.ticket} — this is ` +
              `the site the referent change corrected, and letting it drift to ` +
              `any other ticket is what this gate exists to prevent: ${site.text}`
          );
        }
      } else if (STALE_REFERENTS.has(site.ticket)) {
        problems.push(
          `${site.path}:${site.line} defers to ${site.ticket}, which measured ` +
            `the drop and will not fix it — use the ticket that builds the sink ` +
            `(AAASM-5750, per its own description): ${site.text}`
        );
      }
    }

    expect(problems).toEqual([]);
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
