/**
 * Drift gate binding the documented Node quick-start's enforcement claims to
 * the controls that prove them (AAASM-5529, Epic AAASM-5526).
 *
 * `docs/02-quick-start/index.md` §3 and §4 are where the quick-start tells a
 * reader what governance does for them: that policy is enforced before a tool
 * runs, that a deny throws a `PolicyViolationError` with the tool body never
 * running, and that the allow path's governance event is discarded rather than
 * retained. Nothing connected those sentences to the controls in
 * `quickstart-negative-control.test.ts`, so a claim could be added, reworded,
 * or left standing after the behaviour beneath it changed, and no gate would
 * notice.
 *
 * WHAT THIS GATE PROVES
 *
 * 1. Every enforcement sentence in the gated sections is bound to a named
 *    control. The sentences are read out of the document, so a new claim that
 *    no binding quotes fails here rather than shipping unbacked.
 * 2. Every binding still describes the document. Rewording a claim breaks its
 *    quote and fails.
 * 3. Every control a binding names still exists. Control ids are extracted from
 *    each control file's TypeScript AST as `<file> :: <describe> > <it>`, not
 *    transcribed, so renaming or deleting one fails here.
 * 4. The error class the document names is the one the SDK actually throws.
 *    Derived by driving a real deny through `withAssembly` and reading
 *    `constructor.name` off the thrown value. The class is deliberately NOT
 *    imported here: importing it would make a rename a *type* error, which is
 *    red but aborts before the assertion meant to catch it can run — the
 *    inverted-order defect the round-1 review of this ticket found in all three
 *    SDKs.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *
 * It does not execute, type-check or lint a documented snippet.
 * `metadata/quickstart-snippets/` is excluded from ESLint
 * (`eslint.config.mjs:22`), from Prettier (`.prettierignore:10`) and from every
 * tsconfig, and the snippets import `createPolicyGatewayClient` from
 * `"./policy.js"` — a file the reader supplies from the examples repo, not an
 * SDK export. The existing drift check round-trips them as *text*: it proves
 * this page matches the vendored snippet and nothing more. This gate does not
 * change that.
 *
 * Nor does binding a claim make the claim true. A binding records which control
 * stands behind a sentence.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { withAssembly } from "../src/wrappers/with-assembly.js";
import { createFileSideEffect, createPolicyGatewayClient } from "./helpers/negative-control.js";

const QUICK_START = resolve(process.cwd(), "docs/02-quick-start/index.md");

/**
 * The test files a binding may name.
 *
 * More than one, because the quick-start's claims are not all proved in the
 * same place: the deny claims are proved by the negative controls, while the
 * "reports auditSink" claim is proved by the AAASM-5681 disposition suite.
 * Control ids are file-qualified so two suites cannot collide on a title.
 */
const CONTROL_FILES = [
  "tests/quickstart-negative-control.test.ts",
  "tests/audit-sink-disposition.test.ts"
] as const;

const ENFORCEMENT = "enforcement";
const LIFECYCLE = "lifecycle";

interface ClaimBinding {
  readonly id: string;
  readonly kind: typeof ENFORCEMENT | typeof LIFECYCLE;
  /**
   * A verbatim fragment of the claim as it appears in the document, with
   * Markdown's soft wrapping collapsed. Rewording the document breaks it.
   */
  readonly quote: string;
  /** `<file> :: <describe> > <it>` ids drawn from CONTROL_FILES. */
  readonly controls?: readonly string[];
  /** Set when no control proves the claim. Must name a ticket. */
  readonly unprovenReason?: string;
}

const BINDINGS: readonly ClaimBinding[] = [
  {
    id: "policy-enforced-before-each-tool-runs",
    kind: ENFORCEMENT,
    quote: "wraps a map of tools so the local policy is enforced before each one runs",
    // Both halves are named. The negative controls prove the "before" by the
    // absence of the side effect; the positive controls prove the probe would
    // have seen that effect had it happened. Either alone is the vacuous
    // evidence this Epic exists to remove.
    controls: [
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: filesystem side effect > POSITIVE CONTROL: an allowed write_file really creates the file on disk",
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk",
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: network side effect > POSITIVE CONTROL: an allowed egress tool reaches the listener",
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: network side effect > NEGATIVE CONTROL: a denied egress tool never reaches the listener"
    ]
  },
  {
    id: "allow-event-is-discarded-not-retained",
    kind: ENFORCEMENT,
    // A negative capability claim, and the honest one: it says the SDK retains
    // nothing. Bound so that if someone deletes the caveat because a sink was
    // wired (AAASM-5750), this gate makes them revisit the control rather than
    // quietly dropping the sentence.
    quote: "it is discarded, not retained, so there is no audit trail to read it back from",
    controls: [
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: a deny is handed to the gateway's record call > hands the gateway an audit event naming the denied tool and its run"
    ]
  },
  {
    id: "init-warns-and-reports-the-discard",
    kind: ENFORCEMENT,
    // Found by this gate's own unbound-sentence check, not by reading: the
    // sentence before it was bound, this one was not, and the two make
    // different claims. The first says the event is dropped; this one says
    // initAssembly tells you so at startup and on the context. A reader relying
    // on the second without the first would not know to look.
    quote:
      'warns about this at startup and reports `auditSink: "discarded"` on the returned context',
    controls: [
      'tests/audit-sink-disposition.test.ts :: AAASM-5681: initAssembly surfaces the drop without AA_DEBUG > WARNS on stderr and reports auditSink="discarded" with AA_DEBUG unset'
    ]
  },
  {
    id: "deny-rejects-and-body-never-runs",
    kind: ENFORCEMENT,
    quote: "message includes the tool name and the gateway's reason — the tool body never runs",
    controls: [
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk",
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: network side effect > NEGATIVE CONTROL: a denied egress tool never reaches the listener"
    ]
  },
  {
    id: "pending-waits-then-proceeds-or-rejects",
    kind: ENFORCEMENT,
    quote: "for a human decision, then either proceeds or rejects",
    controls: [
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: a deny is handed to the gateway's record call > hands the gateway a distinct audit event when an approval is rejected"
    ]
  },
  {
    id: "deny-throws-instead-of-executing",
    kind: ENFORCEMENT,
    // Also found by the unbound-sentence check. It restates the deny claim in
    // the strongest terms the page uses ("the whole point"), and a restatement
    // is exactly the kind of sentence that survives a behaviour change because
    // nobody thinks of it as the claim.
    quote: "a denied tool call throws instead of executing",
    controls: [
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk",
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: filesystem side effect > FALSIFICATION: the same write, ungoverned, does create the file"
    ]
  },
  {
    id: "observe-mode-does-not-block",
    kind: ENFORCEMENT,
    quote: "watch what *would* be blocked without actually blocking it",
    controls: [
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: the zero-config initAssembly path > BOUNDARY: enforcementMode observe inits and lets the tool body run"
    ]
  },
  {
    id: "gateway-must-be-reachable",
    kind: LIFECYCLE,
    quote: "The SDK enforces policy by talking to an Agent Assembly **gateway**",
    unprovenReason:
      "AAASM-5663: both README entrypoints were executed and neither runs as written, " +
      "so no control covers the documented zero-config path end to end. The control " +
      "that exists asserts the documented config REFUSES to init; it does not prove a " +
      "reader can reach a working gateway."
  }
];

/** Drops fenced code and collapses soft wrapping. */
function flattenMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\s+/)
    .join(" ")
    .trim();
}

/**
 * The flattened text of the quick-start regions this gate is responsible for.
 *
 * Read from the document rather than transcribed, so a claim added to either
 * region shows up here without anyone editing this file.
 */
function gatedDocumentRegions(): Record<string, string> {
  const document = readFileSync(QUICK_START, "utf-8");
  const openings: Record<string, string> = {
    "gateway-reachable": "## 2. Make sure a gateway is reachable",
    "govern-your-first-agent": "## 3. Govern your first agent",
    "what-to-expect": "## 4. What to expect"
  };

  const regions: Record<string, string> = {};
  for (const [name, opening] of Object.entries(openings)) {
    const start = document.indexOf(opening);
    expect(
      start,
      `${QUICK_START} no longer contains the "${name}" region (looked for ${JSON.stringify(opening)}). ` +
        "If the quick-start was restructured, re-point this gate at the section that now " +
        "carries the enforcement claims — do not delete it."
    ).toBeGreaterThan(-1);

    // Skip the region's own heading LINE before looking for the next heading.
    const body = document.slice(start);
    const afterHeading = body.indexOf("\n");
    const rest = afterHeading === -1 ? "" : body.slice(afterHeading);
    const next = rest.search(/\n#{1,6} /);
    regions[name] = flattenMarkdown(next === -1 ? body : body.slice(0, afterHeading + next));
  }
  return regions;
}

/**
 * Extract `<file> :: <describe> > <it>` ids from each control file's AST.
 *
 * Derived from the source rather than transcribed, so this set changes when a
 * control is renamed or removed and the bindings above then fail.
 */
function controlTitles(): Set<string> {
  const titles = new Set<string>();

  const literalTitle = (node: ts.CallExpression): string | undefined => {
    const [first] = node.arguments;
    return first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
  };

  for (const file of CONTROL_FILES) {
    const absolute = resolve(process.cwd(), file);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf-8"),
      ts.ScriptTarget.Latest,
      true
    );

    const walk = (node: ts.Node, prefix: string): void => {
      let nextPrefix = prefix;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = node.expression.text;
        const title = literalTitle(node);
        if (title !== undefined) {
          if (fn === "describe") {
            nextPrefix = prefix === "" ? title : `${prefix} > ${title}`;
          } else if (fn === "it" || fn === "test") {
            titles.add(`${file} :: ${prefix === "" ? title : `${prefix} > ${title}`}`);
          }
        }
      }
      ts.forEachChild(node, (child) => walk(child, nextPrefix));
    };

    walk(source, "");
  }
  return titles;
}

describe("claim gate: it can see what it gates", () => {
  // Positive controls for the gate itself. Every check below reads a real
  // artifact; these prove the reads arrived. An empty parse and a clean result
  // are otherwise indistinguishable.
  it("finds the gated document regions and they are non-empty", () => {
    const regions = gatedDocumentRegions();
    expect(Object.keys(regions).sort()).toEqual([
      "gateway-reachable",
      "govern-your-first-agent",
      "what-to-expect"
    ]);
    for (const [name, text] of Object.entries(regions)) {
      expect(
        text.length,
        `region "${name}" is too short to hold its claims: ${text}`
      ).toBeGreaterThan(80);
    }
  });

  it("extracts the negative-control titles from the AST", () => {
    const titles = controlTitles();
    expect(titles.size).toBeGreaterThanOrEqual(12);
    // A named one, so an extraction that returned an unrelated set of the right
    // size cannot satisfy the count above.
    expect([...titles]).toContain(
      "tests/quickstart-negative-control.test.ts :: quick-start negative control: filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk"
    );
  });
});

describe("claim gate: every documented claim is bound", () => {
  it.each(BINDINGS.map((binding) => [binding.id, binding] as const))(
    "%s still quotes the document",
    (_id, binding) => {
      const regions = Object.values(gatedDocumentRegions());
      expect(
        regions.some((text) => text.includes(binding.quote)),
        `Claim binding "${binding.id}" quotes:\n  ${JSON.stringify(binding.quote)}\n` +
          "which no longer appears in the gated regions of the quick-start. The claim was " +
          "reworded or removed. Update the quote and re-check that the named controls still " +
          "prove the new wording."
      ).toBe(true);
    }
  );

  it("no enforcement sentence in the gated regions is unbound", () => {
    // The check that makes this gate load-bearing rather than decorative: a new
    // enforcement sentence cannot reach the published quick-start without
    // someone naming the control behind it.
    //
    // Deliberately excludes a bare "policy": it appears in every snippet import
    // line and tab label, so matching it would sweep in prose that makes no
    // enforcement claim.
    const enforcementLanguage =
      /\bdenie[sd]\b|\bdeny\b|\bblocked\b|\bblocking\b|\bnever runs\b|\benforced?\b|\brejects\b|\bdiscarded\b/i;

    const unbound: string[] = [];
    for (const [region, text] of Object.entries(gatedDocumentRegions())) {
      for (const raw of text.split(/(?<=\.)\s+/)) {
        const sentence = raw.trim();
        if (sentence === "" || !enforcementLanguage.test(sentence)) continue;
        if (BINDINGS.some((binding) => sentence.includes(binding.quote))) continue;
        unbound.push(`[${region}] ${sentence}`);
      }
    }

    expect(
      unbound,
      "These quick-start enforcement sentences have no ClaimBinding:\n" +
        unbound.map((s) => `  ${s}`).join("\n") +
        "\n\nAdd a ClaimBinding naming the control that proves each one. If no control " +
        "does, set unprovenReason and name the ticket — do not delete the claim from " +
        "this gate to make it pass."
    ).toEqual([]);
  });
});

describe("claim gate: every binding names something real", () => {
  it.each(BINDINGS.map((binding) => [binding.id, binding] as const))(
    "%s names controls that exist",
    (_id, binding) => {
      const available = controlTitles();
      const missing = (binding.controls ?? []).filter((control) => !available.has(control));
      expect(
        missing,
        `Claim binding "${binding.id}" names controls that do not exist in ` +
          "quickstart-negative-control.test.ts. The control was renamed or removed. " +
          "Re-point the binding at the control that now proves the claim, or mark the " +
          "claim unproven and name the ticket."
      ).toEqual([]);
    }
  );

  it.each(BINDINGS.map((binding) => [binding.id, binding] as const))(
    "%s is either proven or openly unproven",
    (_id, binding) => {
      if ((binding.controls ?? []).length > 0) return;
      expect(
        binding.unprovenReason,
        `Claim "${binding.id}" names no control and gives no unprovenReason. One or the ` +
          "other is required: a documented enforcement claim with neither is exactly the " +
          "unbacked assertion AAASM-5526 exists to eliminate."
      ).toBeTruthy();
      expect(
        binding.unprovenReason ?? "",
        `Claim "${binding.id}" is unproven but its reason names no ticket. An unproven ` +
          "claim must be traceable to the work that resolves it."
      ).toMatch(/AAASM-\d+/);
    }
  );
});

describe("claim gate: the documented error class is the one the SDK throws", () => {
  it("a denied call rejects with the class the quick-start names", async () => {
    const effect = createFileSideEffect();
    try {
      const gateway = createPolicyGatewayClient({ denyTools: ["write_file"] });
      const tools = {
        write_file: { execute: async (content: string) => effect.write(content) }
      };

      withAssembly(tools, { gatewayClient: gateway, agentId: "claim-binding-agent" });

      const outcome = await tools.write_file.execute("denied-content").then(
        (value: unknown) => value,
        (error: unknown) => error
      );

      // Absence of the effect first, as in every control in this suite: an
      // error assertion placed ahead of it aborts before the side effect is
      // checked.
      expect(
        effect.occurred(),
        "the governed call ran the tool body; this gate is measuring the wrong path"
      ).toBe(false);
      expect(outcome).toBeInstanceOf(Error);

      // The name as the running SDK reports it, derived not imported.
      const thrown = (outcome as Error).constructor.name;

      // The names the document promises a reader, read out of the document.
      const documented = [
        ...readFileSync(QUICK_START, "utf-8").matchAll(/`([A-Za-z0-9_]+Error)`/g)
      ].map((match) => match[1]);
      expect(
        documented.length,
        "The quick-start no longer names any `<Name>Error`. It used to promise a reader " +
          "the concrete error a deny throws; if that promise was removed, this gate must " +
          "be re-pointed rather than deleted."
      ).toBeGreaterThan(0);

      expect(
        documented,
        `A denied call rejects with ${thrown}, which the quick-start does not name. ` +
          "Either the class was renamed and the documentation now points at something a " +
          "reader cannot import, or the deny path changed which error it throws."
      ).toContain(thrown);
    } finally {
      effect.cleanup();
    }
  });
});
