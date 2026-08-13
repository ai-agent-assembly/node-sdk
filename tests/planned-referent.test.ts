/**
 * AAASM-5750 — the ADR 0033 §6 `Planned` term must reference the ticket that
 * will build the capability, not the one that measured its absence.
 *
 * §6 scopes `Planned` to "decided but not implemented — a ticket reference; no
 * capability claim." A reference to a ticket that never intended to deliver the
 * capability goes stale the moment that ticket closes: the term still reads as
 * a live commitment while the reference points at finished work. Nothing
 * mechanical catches that, because the referent lives in a comment, and a
 * comment is the one artifact in a source file with no check on it at all.
 *
 * Scope, stated because it is narrower than it looks: this scans for the §6
 * term itself. `with-assembly.ts`'s "supplying a sink that retains it is
 * tracked as …" is the same kind of forward reference and was repointed by
 * hand, but it does not use the term, so this scan does not cover it. That is
 * a consequence of node-sdk describing one state with two different §6 terms —
 * `Planned` in `gateway-governance.ts`, `Unmeasured` in `with-assembly.ts` and
 * the quickstart control — which go-sdk and python-sdk both reason explicitly
 * is wrong for this state (AAASM-5755). When that is reconciled, those sites
 * acquire the term and this scan covers them without a change here.
 *
 * The floor is a ratchet, not a transcription. It was measured from the tree
 * when this was written, and exists because an empty scan and a clean scan
 * otherwise report the same result.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The ticket that owns building the SDK-side audit sink. */
const CAPABILITY_REFERENT = "AAASM-5750";

/**
 * §6 `Planned` sites carrying a ticket reference when this gate was written.
 * Fewer means sites were removed without revisiting this gate, which would
 * leave it passing over nothing.
 */
const PLANNED_REFERENT_FLOOR = 1;

const PLANNED_TERM = /\bPlanned\b/;
const TICKET_REF = /AAASM-\d+/;
const SCANNED_SUFFIXES = [".ts", ".md"];
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".docusaurus"]);

const REPO_ROOT = resolve(__dirname, "..");

interface PlannedSite {
  path: string;
  line: number;
  ticket: string;
  text: string;
}

function scan(dir: string, sites: PlannedSite[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;

    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full, sites);
      continue;
    }

    if (!SCANNED_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;

    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, index) => {
      // A `Planned` with no ticket on the line is prose continuation, not a
      // referent.
      if (!PLANNED_TERM.test(line)) return;
      const ticket = TICKET_REF.exec(line);
      if (ticket === null) return;

      sites.push({
        path: relative(REPO_ROOT, full),
        line: index + 1,
        ticket: ticket[0],
        text: line.trim()
      });
    });
  }
}

function plannedSites(): PlannedSite[] {
  const sites: PlannedSite[] = [];
  scan(REPO_ROOT, sites);
  return sites;
}

describe("AAASM-5750: the §6 Planned referent names the capability ticket", () => {
  it("reaches the referent sites at all", () => {
    // Positive control on the scan. Without it, a walk that reached no files —
    // a broken root, a changed suffix set, an over-broad skip list — reports
    // the same clean result as a tree with every referent correct.
    const sites = plannedSites();
    expect(
      sites.length,
      `scan found ${sites.length} §6 Planned referent sites under ${REPO_ROOT}, ` +
        `floor is ${PLANNED_REFERENT_FLOOR}; either sites were removed without ` +
        `revisiting this gate, or the scan stopped reaching them and is passing ` +
        `over nothing`
    ).toBeGreaterThanOrEqual(PLANNED_REFERENT_FLOOR);
  });

  it("points every site at the ticket that builds the sink", () => {
    const wrong = plannedSites().filter((site) => site.ticket !== CAPABILITY_REFERENT);
    expect(
      wrong.map(
        (site) =>
          `${site.path}:${site.line} references ${site.ticket}, want ` +
          `${CAPABILITY_REFERENT} (the ticket that builds the sink, not one ` +
          `that measured its absence): ${site.text}`
      )
    ).toEqual([]);
  });
});
