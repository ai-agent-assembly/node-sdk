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
 * The defect: AAASM-5681 measured that both shipped gateway clients discarded
 * the hook-layer audit event. It never intended to build a sink. A forward-looking
 * claim pointing at it will read as a live commitment while resolving to
 * finished work the moment it closes. So the invariant is narrow and permanent
 * — **AAASM-5681 may be cited as the ticket that measured the drop, never as
 * the ticket that will fix it.**
 *
 * **AAASM-5750 built the sink, so it joined the list it used to be the answer
 * to.** This gate previously required a fixed set of guarded files to name
 * AAASM-5750 as the ticket their `Planned` deferred to. Once the capability
 * exists there is nothing left to defer: a site still calling SDK-side recording
 * *Planned* under AAASM-5750 describes shipped behaviour as unbuilt, the same
 * stale-pointer defect one ticket later. So the rule collapsed to a single tier
 * — **no forward-looking claim in this repo may defer SDK-side audit recording
 * to any of the three tickets that are done with it** — and applies repo-wide
 * rather than to a named set.
 *
 * §6 still scopes `Planned` to any decided-but-unbuilt capability with any
 * ticket, so an unrelated roadmap deferral naming some other ticket is
 * legitimate and must not fail this gate. Only the three named referents are
 * forbidden.
 *
 * A rule whose expected result is "no findings" needs the scan proved reachable,
 * or a broken walk passes as loudly as a clean tree. The `can see` cases below
 * feed the detector synthetic lines carrying exactly the shapes this file
 * forbids and require it to find them. The empty result is meaningful only
 * because those are green.
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
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tickets a forward-looking claim about SDK-side audit recording may no longer
 * defer to. Backward citations to any of them are correct and are left alone;
 * what this gate forbids is one of them appearing as the ticket a *deferral*
 * points at. The reason differs per entry, and the failure message says which.
 */
const STALE_REFERENTS = new Map([
  ["AAASM-5681", "measured the drop and never intended to fix it"],
  ["AAASM-5731", "measured the drop and never intended to fix it"],
  ["AAASM-5750", "built the sink; SDK-side recording is no longer deferred"]
]);

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

/**
 * Walk the tree, tolerating entries that vanish mid-walk.
 *
 * `readdirSync` + a separate `statSync` leaves a window in which an entry can be
 * removed between the two calls, and the throw takes the whole scan down —
 * turning a gate whose verdict is "no findings" into one that produced no
 * verdict at all. CI hit exactly that: pnpm's transient `.tmp-postinstall-*`
 * directory disappeared between the readdir and the stat
 * (`ENOENT: stat '.tmp-postinstall-BtTJQB'`). `withFileTypes` closes the window
 * for the common case by getting the type from the directory entry itself, and
 * the guards below cover the rest — a file deleted before it is read, or one
 * whose type cannot be determined.
 *
 * Skipping a vanished entry is safe in a way skipping a real one would not be:
 * a file that no longer exists carries no claim. A scan that reaches nothing at
 * all is the dangerous failure, and that is what the positive controls catch.
 */
/** Files the walk actually opened, for the reachability control below. */
const scanned: string[] = [];

function scan(dir: string, sites: DeferralSite[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory removed under us
  }

  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full, sites);
      continue;
    }
    // Neither a plain file nor a directory (a dangling symlink, a socket): a
    // stat would be the only way to tell, and that is the racing call.
    if (!entry.isFile()) continue;

    if (!SCANNED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;

    const rel = relative(REPO_ROOT, full);
    if (rel === GATE_FILE) continue;

    let body: string;
    try {
      body = readFileSync(full, "utf8");
    } catch {
      continue; // removed between the readdir and the read
    }
    scanned.push(rel);
    sites.push(...deferralsInLines(rel, body.split("\n")));
  }
}

/**
 * The detector, split out from the walk so a control can drive it over input it
 * constructs rather than over whatever the tree happens to contain. A gate whose
 * expected result is "nothing found" is only as good as the proof that it can
 * find something.
 */
export function deferralsInLines(path: string, lines: string[]): DeferralSite[] {
  const sites: DeferralSite[] = [];
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
      path,
      line: index + 1,
      ticket: ticket[0],
      text: line.trim()
    });
  });
  return sites;
}

function deferralSites(): DeferralSite[] {
  const sites: DeferralSite[] = [];
  scanned.length = 0;
  scan(REPO_ROOT, sites);
  return sites;
}

/** How much the walk actually covered, so a no-op walk cannot pass as a clean one. */
function scanStats(): { files: number; sites: DeferralSite[] } {
  const sites = deferralSites();
  return { files: scanned.length, sites };
}

function scannedPaths(): string[] {
  deferralSites();
  return [...scanned];
}

describe("AAASM-5750: no forward claim defers to a finished ticket", () => {
  it("finds no audit-sink deferral pointing at a ticket that is done with it", () => {
    const problems = deferralSites()
      .filter((site) => STALE_REFERENTS.has(site.ticket))
      .map(
        (site) =>
          `${site.path}:${site.line} defers to ${site.ticket}, which ` +
          `${STALE_REFERENTS.get(site.ticket)} — a forward-looking claim must ` +
          `not point at it: ${site.text}`
      );

    expect(problems).toEqual([]);
  });

  it.each([
    {
      name: "term and ticket on one line",
      lines: ["// recording here is Planned (AAASM-5731), not Observed."],
      ticket: "AAASM-5731"
    },
    {
      name: "term and ticket wrapped onto two lines",
      lines: [
        "// Under ADR 0033 section 6 SDK-side recording is Planned",
        "// (AAASM-5750), not Observed."
      ],
      ticket: "AAASM-5750"
    },
    {
      name: "the termless 'tracked as' shape",
      lines: ["// Supplying a sink that retains it is tracked as AAASM-5681."],
      ticket: "AAASM-5681"
    }
  ])("the scan can still see: $name", ({ lines, ticket }) => {
    // Positive control. The assertion above expects to find nothing, and every
    // way of breaking the scan — a regex that stops matching, a walk that reaches
    // no files, a window that never extends across a wrapped comment — produces
    // exactly the same green.
    const found = deferralsInLines("synthetic.ts", lines);
    expect(found.map((site) => site.ticket)).toEqual([ticket]);
    expect(STALE_REFERENTS.has(ticket)).toBe(true);
  });

  it("the WALK reaches this repository's files — not just the detector", () => {
    // The controls above drive `deferralsInLines` on synthetic strings, so they
    // pass over a `scan()` that returns immediately: review demonstrated exactly
    // that, mutating the walk to `return;` and watching all five tests stay
    // green. Detector reachability and walk reachability are different claims,
    // and only the second one makes the module-wide "no findings" mean anything.
    //
    // Asserted as a floor on files actually opened, plus a known-present file
    // the walk must have reached. A count alone could be held up by any tree;
    // naming a file that only exists here is what pins it to this repository.
    const { files, sites } = scanStats();
    expect(files).toBeGreaterThan(50);
    expect(sites).toBeInstanceOf(Array);
    expect(scannedPaths()).toContain(join("src", "types", "gateway-governance.ts"));
  });

  it("detects an unrelated open deferral and permits it", () => {
    // The other direction: the gate must not forbid every ticket, or it would
    // push authors to drop the reference §6 requires rather than fix the
    // referent.
    const found = deferralsInLines("synthetic.ts", ["// A curated example is Planned (AAASM-9999)."]);
    expect(found).toHaveLength(1);
    expect(STALE_REFERENTS.has(found[0]!.ticket)).toBe(false);
  });
});
