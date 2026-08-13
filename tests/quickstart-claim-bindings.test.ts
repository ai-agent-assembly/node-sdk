/**
 * Drift gate binding the documented Node quick-start's enforcement claims to
 * the controls that prove them (AAASM-5529, Epic AAASM-5526).
 *
 * `docs/02-quick-start/index.md` tells a reader what governance does for them.
 * Those sentences are the product's load-bearing enforcement claims, and
 * nothing connected them to the controls that prove them.
 *
 * WHAT THIS GATE PROVES
 *
 * 1. The WHOLE document is scanned, not opted-in regions. Every sentence using
 *    enforcement vocabulary must be bound. Sections and sentences are excluded
 *    only through the two named allow-lists, each entry carrying a reason and
 *    an exact sentence, so an entry cannot cover a reworded or new claim.
 * 2. A binding must match a WHOLE sentence, exactly — compared with ===, never
 *    with `includes`. Containment let a sentence carry unlimited extra unbound
 *    claims as long as one bound fragment survived. The reviewer replaced the
 *    true claim with its opposite, left the bound fragment intact, and this
 *    gate stayed green; that is what this revision closes.
 * 3. Exactly one binding may match a sentence.
 * 4. Every control a binding names still exists, extracted from each control
 *    file's TypeScript AST as `<file> :: <describe> > <it>`.
 * 5. Every claim is proven or openly unproven, with no exempt category. There
 *    was a `kind` field; it was written and never read, which is worse than a
 *    bypass because a reader assumes it is enforced. Removed.
 * 6. The error class the document names is the one the SDK actually throws,
 *    derived from `constructor.name` on a real deny rather than imported.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *
 * It does not execute or lint a documented snippet.
 * `metadata/quickstart-snippets/` is excluded from ESLint (`eslint.config.mjs`)
 * and Prettier (`.prettierignore`), and the snippets import
 * `createPolicyGatewayClient` from `"./policy.js"` — a file the reader supplies
 * from the examples repo, not an SDK export. The base `tsconfig.json` DOES
 * include the snippet files, but no CI job type-checks with that config
 * (`pnpm typecheck` runs `tsconfig.test.json`), so nothing gates them. The
 * existing drift step round-trips them as text only, and this gate does not
 * change that.
 *
 * Binding a claim also does not make it true.
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
 * same place: the deny claims come from the negative controls, the audit-sink
 * claims from the AAASM-5681 disposition suite, and the auto-start claim from
 * the gateway resolver's suite. Control ids are file-qualified so two suites
 * cannot collide on a title.
 */
const CONTROL_FILES = [
  "tests/quickstart-negative-control.test.ts",
  "tests/audit-sink-disposition.test.ts",
  "tests/gateway-resolver.test.ts"
] as const;

const NEG = "tests/quickstart-negative-control.test.ts :: quick-start negative control: ";
const AUDIT = "tests/audit-sink-disposition.test.ts :: AAASM-5681: ";
const RESOLVER = "tests/gateway-resolver.test.ts :: resolveGatewayUrl > ";

interface ClaimBinding {
  readonly id: string;
  /** The claim as a WHOLE sentence, flattened. Compared with ===, not includes. */
  readonly quote: string;
  /** `<file> :: <describe> > <it>` ids drawn from CONTROL_FILES. */
  readonly controls?: readonly string[];
  /** Set when no control proves the claim. Must name a ticket. */
  readonly unprovenReason?: string;
}

const DENY_CONTROLS = [
  `${NEG}filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk`,
  `${NEG}network side effect > NEGATIVE CONTROL: a denied egress tool never reaches the listener`
] as const;

const ALLOW_AND_DENY_CONTROLS = [
  `${NEG}filesystem side effect > POSITIVE CONTROL: an allowed write_file really creates the file on disk`,
  `${NEG}filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk`,
  `${NEG}network side effect > POSITIVE CONTROL: an allowed egress tool reaches the listener`,
  `${NEG}network side effect > NEGATIVE CONTROL: a denied egress tool never reaches the listener`
] as const;

const BINDINGS: readonly ClaimBinding[] = [
  {
    id: "page-takes-you-to-a-governed-agent",
    quote: "This page takes you from nothing to a governed agent in a few minutes.",
    controls: ALLOW_AND_DENY_CONTROLS
  },
  {
    id: "sdk-enforces-by-talking-to-a-gateway",
    quote: "The SDK enforces policy by talking to an Agent Assembly **gateway**.",
    unprovenReason:
      "AAASM-5663: both README entrypoints were executed and neither runs as written, so no " +
      "control covers a reader actually reaching a gateway. The control that exists asserts " +
      "the documented config REFUSES to init; it does not prove this sentence."
  },
  {
    id: "auto-start-is-opt-in",
    quote:
      "Auto-start is opt-in — without it, a missing gateway throws a `ConfigurationError` " +
      "instead of spawning anything.",
    controls: [
      `${RESOLVER}throws ConfigurationError instead of auto-starting when AA_AUTO_START is unset`
    ]
  },
  {
    id: "policy-enforced-before-each-tool-runs",
    quote:
      "`withAssembly` wraps a map of tools so the local policy is enforced before each one runs: " +
      "an allowed call executes normally, while a denied call throws a `PolicyViolationError` and " +
      "the tool body never runs.",
    // Both halves. The negative controls prove the "before" by absence of the
    // side effect; the positive controls prove the probe would have seen that
    // effect had it happened.
    controls: ALLOW_AND_DENY_CONTROLS
  },
  {
    id: "allow-event-is-discarded-not-retained",
    quote:
      "A governance event is emitted — but with either gateway client this SDK ships it is " +
      "discarded, not retained, so there is no audit trail to read it back from.",
    // Repointed under review. This was bound to a negative control that hands
    // the event to a FIXTURE client, which retains it — so flipping the shipped
    // clients' disposition left that control green and the binding could not
    // fail when the claim became false. The control named here drives the
    // SHIPPED client against a downstream boundary probe, and its sibling at
    // :164 is the reachability positive control for that same probe.
    controls: [
      `${AUDIT}shipped clients declare what they do with audit events > a client declaring "discarded" reaches nothing with any audit method`
    ]
  },
  {
    id: "init-warns-and-reports-the-discard",
    quote:
      '`initAssembly` warns about this at startup and reports `auditSink: "discarded"` on the ' +
      "returned context; supply your own `gatewayClient` to retain the event (AAASM-5681).",
    controls: [
      `${AUDIT}initAssembly surfaces the drop without AA_DEBUG > WARNS on stderr and reports auditSink="discarded" with AA_DEBUG unset`
    ]
  },
  {
    id: "deny-rejects-and-body-never-runs",
    quote:
      "- **Deny.** The wrapped `invoke()` *rejects* with a `PolicyViolationError` whose message " +
      "includes the tool name and the gateway's reason — the tool body never runs.",
    controls: DENY_CONTROLS
  },
  {
    id: "pending-waits-then-proceeds-or-rejects",
    quote:
      "- **Pending (needs approval).** The call waits up to `langchain.approvalTimeoutMs` (default " +
      "applies if unset) for a human decision, then either proceeds or rejects.",
    controls: [
      `${NEG}a deny is handed to the gateway's record call > hands the gateway a distinct audit event when an approval is rejected`
    ]
  },
  {
    id: "deny-throws-instead-of-executing",
    // A restatement, which is exactly the kind of sentence that survives a
    // behaviour change because nobody thinks of it as the claim.
    quote:
      "That deny-on-policy behavior is the whole point: a denied tool call throws instead of executing.",
    controls: [
      `${NEG}filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk`,
      `${NEG}filesystem side effect > FALSIFICATION: the same write, ungoverned, does create the file`
    ]
  },
  {
    id: "observe-mode-does-not-block",
    quote:
      "If you want to watch what *would* be blocked without actually blocking it while you tune " +
      "policy, register the agent in observe mode:",
    controls: [
      `${NEG}the zero-config initAssembly path > BOUNDARY: enforcementMode observe inits and lets the tool body run`
    ]
  }
];

/** Whole sections excluded from the scan, each with a reason. */
const EXCLUDED_SECTIONS: Record<string, string> = {
  "## Next steps":
    "A link list. Every line is a cross-reference to another page; the claims live on the pages " +
    "linked to and are gated there."
};

/**
 * Individual sentences excluded from the scan, each with a reason. Exact
 * flattened sentences, never patterns, so an entry cannot silently cover a
 * reworded or newly added claim.
 */
const EXCLUDED_SENTENCES: Record<string, string> = {};

/** Strips Docusaurus front matter, which otherwise flattens into sentence one. */
function stripFrontMatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function flattenMarkdown(text: string): string {
  return text.split(/\s+/).join(" ").trim();
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=\.)\s/);
  return parts;
}

/**
 * Every sentence in the document, keyed to its section heading.
 *
 * The gate opts sections OUT by name rather than opting them in, so a claim
 * added to a section nobody thought about is still caught. A fenced block
 * becomes a PARAGRAPH break, not a space: replacing it with a space glued the
 * sentence before a code sample to the one after it, and a binding quoting the
 * glued pair would cover two claims at once — fragment containment one level up.
 */
function scannedSentences(): Record<string, string> {
  const body = stripFrontMatter(readFileSync(QUICK_START, "utf-8")).replace(
    /```[\s\S]*?```/g,
    "\n\n"
  );

  const sentences: Record<string, string> = {};
  let section = "(preamble)";
  for (const chunk of body.split(/^(#{2,6} .*)$/m)) {
    if (chunk === undefined) continue;
    if (/^#{2,6} /.test(chunk)) {
      section = chunk.trim();
      continue;
    }
    if (section in EXCLUDED_SECTIONS) continue;
    for (const paragraph of chunk.split("\n\n")) {
      for (const raw of splitSentences(paragraph)) {
        const flat = flattenMarkdown(raw);
        if (flat !== "") sentences[flat] = section;
      }
    }
  }
  return sentences;
}

const ENFORCEMENT_VOCABULARY =
  /\bdenie[sd]\b|\bdeny\b|\bblocked\b|\bblocking\b|\bnever runs?\b|\bbefore execution\b|\bchecked against\b|\benforces?\b|\benforced\b|\bpassthrough\b|\bdiscards?\b|\bdiscarded\b|\bthrows?\b|\brejects?\b|\brouted\b|\bintercepts?\b|\binterception\b|\bgoverned\b|\bverified\b|\bprotection\b|\bunprotected\b|\bbypass(ed|es)?\b/i;

/** The scanned sentences that make an enforcement claim. */
function claimSentences(): Record<string, string> {
  const claims: Record<string, string> = {};
  for (const [sentence, section] of Object.entries(scannedSentences())) {
    if (!ENFORCEMENT_VOCABULARY.test(sentence)) continue;
    if (sentence in EXCLUDED_SENTENCES) continue;
    claims[sentence] = section;
  }
  return claims;
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
  // Positive controls for the gate itself. An empty parse and a clean result
  // are otherwise indistinguishable.
  it("reads the whole document and splits it into sentences", () => {
    expect(Object.keys(scannedSentences()).length).toBeGreaterThan(30);
  });

  it("finds enforcement claims in more than one section", () => {
    const claims = claimSentences();
    expect(Object.keys(claims).length).toBeGreaterThanOrEqual(8);
    // Narrowing the scan back to one region would otherwise look identical to
    // a clean pass.
    expect(new Set(Object.values(claims)).size).toBeGreaterThanOrEqual(3);
  });

  it("extracts control titles from every control file", () => {
    const titles = [...controlTitles()];
    for (const file of CONTROL_FILES) {
      expect(
        titles.some((title) => title.startsWith(`${file} :: `)),
        `AST extraction found no controls in ${file}`
      ).toBe(true);
    }
    expect(titles).toContain(
      `${NEG}filesystem side effect > NEGATIVE CONTROL: a denied write_file leaves no file on disk`
    );
  });
});

describe("claim gate: the allow-list cannot become a bypass", () => {
  it("every excluded section is still a real heading", () => {
    const document = readFileSync(QUICK_START, "utf-8");
    for (const [heading, reason] of Object.entries(EXCLUDED_SECTIONS)) {
      expect(document, `EXCLUDED_SECTIONS names "${heading}", no longer a heading`).toContain(
        heading
      );
      expect(reason.trim()).not.toBe("");
    }
  });

  it("every excluded sentence is still present verbatim", () => {
    // An entry is a whole sentence, so rewording the claim makes the entry
    // stale and fails here rather than silently exempting the new wording.
    const scanned = scannedSentences();
    for (const [sentence, reason] of Object.entries(EXCLUDED_SENTENCES)) {
      expect(
        Object.hasOwn(scanned, sentence),
        `EXCLUDED_SENTENCES contains a sentence no longer in the quick-start:\n  ${sentence}\n` +
          "Delete the stale entry, and if the replacement makes a claim, bind it."
      ).toBe(true);
      expect(reason.trim()).not.toBe("");
    }
  });
});

describe("claim gate: every documented claim is bound", () => {
  it("no enforcement sentence is unbound", () => {
    const quotes = new Set(BINDINGS.map((binding) => binding.quote));
    const unbound = Object.entries(claimSentences())
      .filter(([sentence]) => !quotes.has(sentence))
      .map(([sentence, section]) => `[${section}] ${sentence}`);

    expect(
      unbound,
      "These quick-start sentences make an enforcement claim and have no ClaimBinding:\n" +
        unbound.map((s) => `  ${s}`).join("\n") +
        "\n\nAdd a ClaimBinding whose quote is the WHOLE sentence, naming the control that proves " +
        "it. If no control does, set unprovenReason and name the ticket. If the sentence makes no " +
        "capability claim, add it to EXCLUDED_SENTENCES with a reason — do not delete the claim " +
        "from this gate to make it pass."
    ).toEqual([]);
  });

  it.each(BINDINGS.map((binding) => [binding.id, binding] as const))(
    "%s matches exactly one whole sentence",
    (_id, binding) => {
      // Whole-sentence equality, not containment. Containment allowed a
      // sentence to carry extra unbound claims — up to and including its own
      // negation — while one bound fragment kept the gate green.
      const matches = Object.keys(scannedSentences()).filter(
        (sentence) => sentence === binding.quote
      );
      expect(
        matches.length,
        `ClaimBinding "${binding.id}" must match exactly one whole sentence; it matched ` +
          `${matches.length}.\nIts quote is:\n  ${binding.quote}\n` +
          "The claim was reworded, split, or merged. Update the quote to the new whole sentence " +
          "and re-check that the named controls still prove it."
      ).toBe(1);
    }
  );

  it("no two bindings claim the same sentence", () => {
    const quotes = BINDINGS.map((binding) => binding.quote);
    const duplicates = quotes.filter((quote, index) => quotes.indexOf(quote) !== index);
    expect(
      duplicates,
      "Split responsibility like that and neither binding owns the claim."
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
        `ClaimBinding "${binding.id}" names controls that do not exist. The control was renamed ` +
          "or removed. Re-point the binding at the control that now proves the claim, or mark " +
          "the claim unproven and name the ticket."
      ).toEqual([]);
    }
  );

  it.each(BINDINGS.map((binding) => [binding.id, binding] as const))(
    "%s is either proven or openly unproven",
    (_id, binding) => {
      // Every claim, with no exempt category. There used to be a `kind` field
      // that was written and never read — dead decoration a reader would assume
      // was enforced. Removed rather than wired up.
      if ((binding.controls ?? []).length > 0) return;
      expect(
        binding.unprovenReason,
        `Claim "${binding.id}" names no control and gives no unprovenReason. A documented claim ` +
          "with neither is exactly the unbacked assertion AAASM-5526 exists to eliminate."
      ).toBeTruthy();
      expect(binding.unprovenReason ?? "").toMatch(/AAASM-\d+/);
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

      // Absence of the effect first, as in every control in this suite.
      expect(
        effect.occurred(),
        "the governed call ran the tool body; measuring the wrong path"
      ).toBe(false);
      expect(outcome).toBeInstanceOf(Error);

      // The name as the running SDK reports it, derived not imported.
      const thrown = (outcome as Error).constructor.name;

      const documented = [
        ...readFileSync(QUICK_START, "utf-8").matchAll(/`([A-Za-z0-9_]+Error)`/g)
      ].map((match) => match[1]);
      expect(
        documented.length,
        "The quick-start no longer names any `<Name>Error`. If that promise was removed, this " +
          "gate must be re-pointed rather than deleted."
      ).toBeGreaterThan(0);

      expect(
        documented,
        `A denied call rejects with ${thrown}, which the quick-start does not name. Either the ` +
          "class was renamed and the documentation now points at something a reader cannot " +
          "import, or the deny path changed which error it throws."
      ).toContain(thrown);
    } finally {
      effect.cleanup();
    }
  });
});
