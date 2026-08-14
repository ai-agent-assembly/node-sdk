/**
 * Drift gate binding the documented Node quick-start's claims to the controls
 * that prove them (AAASM-5529, Epic AAASM-5526).
 *
 * Every sentence in `docs/02-quick-start/index.md` must be either BOUND to a
 * control that proves it, or explicitly ALLOW-LISTED as making no capability
 * claim. There is no third state and no keyword filter.
 *
 * WHY THE DEFAULT IS INVERTED
 *
 * Earlier revisions only scanned sentences matching an enforcement vocabulary.
 * Review appended three plain sentences using none of the 21 terms — the last,
 * "Tool bodies always execute; the policy result is recorded alongside them",
 * is the negation of the product — and every gate stayed green. Widening 3 → 21
 * closed the instance, not the class: a keyword allow-list cannot be completed,
 * because whoever adds the claim picks the words after reading the list.
 *
 * The vocabulary now gates nothing. It survives as a severity hint in the
 * failure message, and as the trigger for a stricter allow-list rule: an entry
 * whose sentence reads like a claim needs a written justification, not a
 * category.
 *
 * Section-level exclusions are gone. An excluded section was a black hole — the
 * guard checked the heading still existed and said nothing about its contents —
 * so a claim inserted into "## Next steps" was never scanned at all.
 *
 * WHAT THIS GATE PROVES
 *
 * 1. Every sentence in the document is accounted for.
 * 2. A binding matches a WHOLE sentence, exactly, and only one binding may.
 * 3. Every control a binding names exists, extracted from the control files'
 *    TypeScript ASTs rather than transcribed.
 * 4. Every claim is proven or openly unproven, and an unproven claim may not
 *    name the ticket this file implements — that pointer resolves to a closed
 *    issue the moment the work merges.
 * 5. Comments are stripped before scanning, HTML and MDX alike, because a
 *    reader cannot see them. Leaving them in let a bound claim be commented out
 *    of the rendered page while the gate still counted it.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *
 * It does not execute or lint a documented snippet.
 * `metadata/quickstart-snippets/` is excluded from ESLint (`eslint.config.mjs`)
 * and Prettier (`.prettierignore`), and the snippets import
 * `createPolicyGatewayClient` from `"./policy.js"` — a file the reader supplies.
 * The base `tsconfig.json` DOES include them, but no CI job type-checks with
 * that config (`pnpm typecheck` runs `tsconfig.test.json`), so nothing gates
 * them. The existing drift step round-trips them as text only.
 *
 * Binding a claim does not make it true.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { withAssembly } from "../src/wrappers/with-assembly.js";
import { createFileSideEffect, createPolicyGatewayClient } from "./helpers/negative-control.js";

const QUICK_START = resolve(process.cwd(), "docs/02-quick-start/index.md");

/**
 * The ticket this file implements. An unproven claim may not name it: on merge
 * that pointer resolves to a closed issue and nothing would notice.
 */
const IMPLEMENTING_TICKET = "AAASM-5529";

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
      "AAASM-5758: no control covers a reader actually reaching a gateway. Every control " +
      "that exists decides tool calls through a caller-supplied gatewayClient answering " +
      "in-process, which is what the documented snippets do — so they prove a wrapped " +
      "call is decided before its body runs, not that the deciding party is a gateway. " +
      "Closing this needs a CI job that runs each documented quick-start from a clean " +
      "environment against published artifacts only, which AAASM-5758 owns. This is a " +
      "forward pointer to the work that would prove the sentence, not a citation for " +
      "where it was last examined."
  },
  {
    id: "auto-start-is-opt-in",
    quote:
      "Auto-start is opt-in — without it, a missing gateway throws a `ConfigurationError` instead of spawning anything.",
    controls: [
      `${RESOLVER}throws ConfigurationError instead of auto-starting when AA_AUTO_START is unset`
    ]
  },
  {
    id: "policy-enforced-before-each-tool-runs",
    quote:
      "`withAssembly` wraps a map of tools so the local policy is enforced before each one runs: an allowed call executes normally, while a denied call throws a `PolicyViolationError` and the tool body never runs.",
    // Both halves. The negative controls prove the "before" by absence of the
    // side effect; the positive controls prove the probe would have seen that
    // effect had it happened.
    controls: ALLOW_AND_DENY_CONTROLS
  },
  {
    id: "allow-path-runs-and-returns",
    quote: "The tool runs normally and returns its result.",
    controls: [
      `${NEG}filesystem side effect > POSITIVE CONTROL: an allowed write_file really creates the file on disk`,
      `${NEG}network side effect > POSITIVE CONTROL: an allowed egress tool reaches the listener`
    ]
  },
  {
    id: "allow-event-goes-where-the-client-can-send-it",
    quote:
      "A governance event is emitted, and where it goes depends on the gateway client: the native one hands it to the runtime's event channel, while the no-op one has no channel and drops it.",
    // Bound to the audit-sink suite, which drives the SHIPPED clients against a
    // downstream boundary probe. A control whose FIXTURE client supplies its own
    // sink cannot decide this claim in either direction, and one such binding
    // did previously stay green while the claim was false. The sentence names
    // both clients, so both branches need a control.
    controls: [
      `${AUDIT}shipped clients declare what they do with audit events > a client declaring "forwarded" reaches the boundary with every audit method`,
      `${AUDIT}shipped clients declare what they do with audit events > the two shipped clients do NOT declare the same thing`,
      `${AUDIT}shipped clients declare what they do with audit events > the no-op client's audit methods resolve to undefined and retain nothing`
    ]
  },
  {
    id: "the-handoff-is-not-an-arrival",
    quote:
      "Neither is an assurance the event was retained — the handoff is unacknowledged, so the SDK cannot report arrival.",
    // A statement about what the SDK CANNOT observe. Bound to the disposition
    // suite because that is where the boundary double shows exactly how far the
    // send goes: `sendEvent` returns void and the client returns regardless.
    controls: [
      `${AUDIT}shipped clients declare what they do with audit events > a client declaring "forwarded" reaches the boundary with every audit method`
    ]
  },
  {
    id: "init-warns-and-reports-the-disposition",
    quote:
      "`initAssembly` warns when the event is dropped and reports `auditSink` on the returned context (AAASM-5750).",
    // Both directions of the warning: it must fire on the dropping path and stay
    // quiet on the forwarding one. Binding only the first would be satisfied by
    // a build that warns unconditionally, which is what it used to do.
    controls: [
      `${AUDIT}initAssembly surfaces the drop without AA_DEBUG > WARNS on stderr and reports auditSink="discarded" with AA_DEBUG unset`,
      `${AUDIT}initAssembly surfaces the drop without AA_DEBUG > in napi-inprocess with a loaded binding, does NOT warn at all`
    ]
  },
  {
    id: "deny-rejects-and-body-never-runs",
    quote:
      "The wrapped `invoke()` *rejects* with a `PolicyViolationError` whose message includes the tool name and the gateway's reason — the tool body never runs.",
    controls: DENY_CONTROLS
  },
  {
    id: "pending-waits-then-proceeds-or-rejects",
    quote:
      "The call waits up to `langchain.approvalTimeoutMs` (default applies if unset) for a human decision, then either proceeds or rejects.",
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
      "If you want to watch what *would* be blocked without actually blocking it while you tune policy, register the agent in observe mode:",
    controls: [
      `${NEG}the zero-config initAssembly path > BOUNDARY: enforcementMode observe inits and lets the tool body run`
    ]
  }
];

/**
 * Allow-list categories. Permitted only for a sentence that does NOT match the
 * vocabulary below; anything that does needs a written justification.
 */

/**
 * Every sentence that makes no capability claim, keyed exactly.
 *
 * There is no section-level exclusion: an excluded section was a black hole,
 * since the guard checked the heading still existed and said nothing about its
 * contents.
 */
/**
 * STRUCTURAL is the ONLY bare constant, permitted solely for lines that are not
 * prose — MDX tags, admonition delimiters, tab captions, bare link items —
 * matched by STRUCTURAL_LINE. Every other entry carries a written justification
 * unique to that sentence.
 *
 * The previous rule required a justification only when the sentence matched the
 * enforcement vocabulary, which is backwards: the sentences that most need
 * explaining are the ones that EVADE it, since evading it is the whole reason
 * the scan was inverted.
 */
const STRUCTURAL =
  "Structurally non-prose: a line that is entirely MDX scaffolding and carries no sentence.";

/**
 * Fully anchored, and deliberately narrow. The previous pattern asked whether a
 * sentence STARTED with structure, not whether it was ONLY structure, so a link
 * item or an HTML-tag-prefixed line was waved through on its first characters
 * while its anchor text — rendered prose a reader sees — went unexamined. A
 * payload as plain as
 *   [Every tool request is permitted to proceed and its outcome captured](x.md)
 * passed. Only lines that are entirely MDX scaffolding qualify now.
 */
const STRUCTURAL_LINE =
  /^(?:<\/?(?:Tabs|TabItem)[^>]*>\s*)+$|^:::$|^import [^;]+;(?:\s*import [^;]+;)*$/;

/**
 * A sentence that turns mid-way can under-claim and over-claim at once:
 * "Network-layer interception is not enabled by default, because the in-process
 * adapter already verifies every outbound request before it leaves the host."
 * The first clause is a limitation; the second is a fabrication riding along
 * under it. Rather than judge each case, the shape is rejected.
 *
 * Applied to EVERY entry, not only ones whose justification calls itself a
 * disclaimer: keying off a marker phrase made the rule opt-in by the author it
 * constrains. "so" is excluded — it is consequential rather than adversative —
 * and both attack payloads are still caught, one using "because" and one "but".
 */
const CONTRASTIVE_CONJUNCTION = /\s(?:but|because|though|although|however|whereas|while)\s/i;

/**
 * The "so" rule, deliberately separate from CONTRASTIVE_CONJUNCTION.
 *
 * The risk "so" carries is not adversativeness but POLARITY CHANGE. "We don't
 * do X but Y" is a concession; "we don't do X so Y covers it" is a REASSURANCE,
 * and reassurance is the register documentation over-claims in. A negated
 * clause followed by an un-negated one is the shape that hides an affirmative
 * capability claim behind a limitation.
 *
 * Flagging "so" flat would catch live sentences in all three repos, every one
 * of which turns the way it started. This form catches none of them and still
 * catches the payload, which is the only negative-to-positive case.
 */
const NEGATION = /\b(?:not|no|never|cannot|can't|without)\b/i;
const SO_CONNECTOR = /\sso\s/gi;

/** A floor, not a real check: no gate can tell a justification from noise. */
const MIN_JUSTIFICATION = 40;

const ALLOWED = new Map<string, string>([
  [
    ":::note[Pre-1.0 / release candidate] The public surface (`initAssembly`, `withAssembly`) is stabilizing.",
    "An API-stability note: the public surface is still settling. A statement about release maturity, not about what governance does to a call."
  ],
  [
    "It may change between pre-releases.",
    "The second half of the pre-1.0 stability note, after it was split at its contrastive conjunction."
  ],
  [
    '**AI SDK 4.x:** `import { useChat } from "ai/react";`',
    "A before/after import pair from the Vercel AI SDK migration note."
  ],
  [
    '**AI SDK ≥ 5.0 (current):** `import { useChat } from "@ai-sdk/react";` :::',
    "The after half of the Vercel AI SDK import pair, closing its admonition."
  ],
  [
    "**Allow.**",
    "The bold label of a What-to-expect bullet. The claims it introduces are the two sentences after it, both bound."
  ],
  [
    "**Deny.**",
    "The bold label of a What-to-expect bullet. The claim it introduces is the next sentence, which is bound to the deny controls."
  ],
  [
    "**LangChain.js** is the validated path; the remaining frameworks are experimental.",
    "Ranks the framework tabs by support level. A maturity statement about coverage, not about what governance does to a call."
  ],
  [
    "**Let the SDK auto-start a local gateway.**",
    "The bold label of one of the two gateway options; the mechanics follow in the sentences after it."
  ],
  [
    "**Pending (needs approval).**",
    "The bold label of a What-to-expect bullet. The behaviour it introduces is the next sentence, which is bound."
  ],
  ["**Point at a gateway you already run.**", "The bold label of the other gateway option."],
  [
    "**[Configuration](../05-configuration/index.md)** — every `AssemblyConfig` field and the gateway/API-key resolution precedence.",
    "A Next-steps link item pointing at Configuration; the field reference and resolution precedence live on that page."
  ],
  [
    "**[Core Concepts](../03-core-concepts/index.md)** — what the native binding, the adapter registry, and the `initAssembly` lifecycle actually do.",
    "A Next-steps link item pointing at Core Concepts. Its claims live on that page and are gated there."
  ],
  [
    "**[Guides](../04-guides/index.md)** — the full LangChain walkthrough, the low-level `withAssembly` wrapper, experimental frameworks, and how to handle allow/deny decisions and errors.",
    "A Next-steps link item pointing at the Guides index. It reads like a claim only through the linked page's title."
  ],
  [
    '**`@mastra/core` 0.x:** `import { Agent, Workflow, createTool } from "@mastra/core";`',
    "A before/after import pair from the Mastra migration note."
  ],
  [
    '**`@mastra/core` ≥ 1.0 (current):** `import { createTool } from "@mastra/core/tools";` (similarly `Agent` from `@mastra/core/agent`, `Workflow` from `@mastra/core/workflows`) :::',
    "The after half of the Mastra import pair, listing the new module paths and closing its admonition."
  ],
  [
    '**`langchain` / `@langchain/core` ≥ 0.1.0 (current):** `import { tool } from "@langchain/core/tools";` :::',
    "The after half of the LangChain.js import pair, closing its admonition."
  ],
  [
    '**`langchain` < 0.1.0:** `import { Tool } from "langchain/tools";`',
    "The before half of the LangChain.js import pair."
  ],
  [":::", STRUCTURAL],
  [
    ":::note[Local-mode transports: `:7391` REST + `:50051` gRPC] Starting the local gateway binds **two** loopback surfaces in one process:",
    "The admonition heading plus the sentence introducing the two loopback surfaces; the ports themselves are described in the sentences that follow."
  ],
  [
    ":::note[Version compatibility] Base tool abstractions like `Tool` moved out of the `langchain` monolith into `@langchain/core` when LangChain split the package in [v0.1.0](https://www.langchain.com/blog/langchain-v0-1-0) (Jan 2024; `@langchain/core` first published to npm 2023-11-22).",
    "Third-party framework migration note, for the LangChain.js tool-abstraction move into @langchain/core."
  ],
  [
    ":::note[Version compatibility] Mastra [v1](https://mastra.ai/guides/migrations/upgrade-to-v1/mastra) moved every export except `Mastra` itself off the `@mastra/core` root entry point onto subpaths (see the `npx @mastra/codemod@latest v1/mastra-core-imports` codemod).",
    "Third-party framework migration note, for the Mastra v1 export reorganisation."
  ],
  [
    ":::note[Version compatibility] The React UI hooks were extracted out of the core `ai` package into a dedicated package in [AI SDK 5.0](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0), which removed the deprecated `ai/react` export.",
    "Third-party framework migration note, for the Vercel AI SDK 5.0 React package split."
  ],
  ["</TabItem> </Tabs>", STRUCTURAL],
  ['</TabItem> <TabItem value="bun" label="bun">', STRUCTURAL],
  ['</TabItem> <TabItem value="custom-tool-policy" label="Custom (no framework)">', STRUCTURAL],
  ['</TabItem> <TabItem value="langgraph-js" label="LangGraph.js (Experimental)">', STRUCTURAL],
  ['</TabItem> <TabItem value="mastra" label="Mastra (Experimental)">', STRUCTURAL],
  ['</TabItem> <TabItem value="npm" label="npm">', STRUCTURAL],
  [
    '</TabItem> <TabItem value="openai-node-tool-policy" label="OpenAI (Node) (Experimental)">',
    STRUCTURAL
  ],
  ['</TabItem> <TabItem value="vercel-ai" label="Vercel AI SDK (Experimental)">', STRUCTURAL],
  ['</TabItem> <TabItem value="yarn" label="yarn">', STRUCTURAL],
  [
    '<Tabs groupId="quickstart-install-package-manager"> <TabItem value="pnpm" label="pnpm" default>',
    STRUCTURAL
  ],
  [
    '<Tabs groupId="quickstart-node-framework"> <TabItem value="langchain-js-basic-agent" label="LangChain.js" default>',
    STRUCTURAL
  ],
  [
    "Copy the full, runnable script — imports, tools, and the agent run — from the linked example; the slice below is just the part that wires in governance.",
    "An instruction about which lines to copy. Identifies the excerpt without claiming what the wiring achieves."
  ],
  [
    "Everything here is copy-paste; the snippets mirror the patterns the SDK's own test suite exercises.",
    "Describes how the snippets relate to the test suite. A provenance statement about the page."
  ],
  [
    "If you have the `aasm` binary on your `PATH` (`brew install ai-agent-assembly/tap/aasm`, or `curl -fsSL https://agent-assembly.com/install.sh | sh`) and set `AA_AUTO_START=1`, a zero-config `initAssembly()` will probe `http://localhost:7391` and start a local gateway for you if nothing is running.",
    "Describes the auto-start opt-in, its binary prerequisite, and the port probed. Startup mechanics, not a claim that a call is checked."
  ],
  [
    "Pick your framework below — each tab is the governance-wiring excerpt from that framework's runnable [example](https://github.com/ai-agent-assembly/examples/tree/HEAD/node), vendored into this repo and kept in lock-step with this page by a CI drift check — the check catches this page drifting from the vendored snippet, not the vendored snippet drifting from the upstream example.",
    "Describes tab provenance, and is unusually precise about the limit of the drift check. Names the excerpt, not an enforcement outcome."
  ],
  [
    "Pin an exact version for reproducible installs:",
    "Introduces the pinned-install command below it."
  ],
  [
    "See [Configuration](../05-configuration/index.md) for the full resolution order.",
    "A cross-reference to the gateway and credential resolution documentation."
  ],
  [
    "Set `AA_GATEWAY_URL` (and `AA_API_KEY` if it requires auth), or pass `gatewayUrl` explicitly.",
    "Names the environment variables and option for pointing at an existing gateway."
  ],
  [
    'The `tool()` factory used above is unaffected — it still imports from `"ai"` unchanged through the 7.x line this example pins.',
    "Scopes the Vercel AI SDK migration note, saying which import did not move."
  ],
  [
    'The excerpts are ESM / TypeScript; under CommonJS, swap the import for `const { withAssembly } = require("@agent-assembly/sdk")`.',
    "Tells a CommonJS reader how to adapt the import line."
  ],
  [
    "The package ships dual ESM/CJS entries and selects a prebuilt native binding for your platform during `postinstall`, so there is no extra build step for typical consumers.",
    "Describes packaging and install mechanics: module formats and prebuilt binary selection."
  ],
  [
    "This example's `@mastra/core` pin (`^1.50.1`) already uses the new layout.",
    "Notes that the Mastra example is already on the post-migration import layout."
  ],
  [
    "This exposes the REST API on `http://localhost:7391` (what `gatewayUrl` points to, and what the SDK probes and, with `AA_AUTO_START=1`, auto-starts) **and** the gRPC `AgentLifecycleService` on `127.0.0.1:50051`, which is the endpoint the native `aa-sdk-client` binding dials to **register** your agent.",
    "Maps each local-mode port to the consumer that dials it. Transport topology, not enforcement."
  ],
  [
    "To confirm both surfaces are actually up rather than guessing from the SDK's behavior, check them directly:",
    "Tells the reader to verify the ports themselves; the commands follow below."
  ],
  [
    "You don't configure `:50051` yourself — registration dials it automatically — so a no-argument `initAssembly()` both connects and shows the agent in the dashboard once a gateway is reachable.",
    "Describes registration transport and dashboard visibility, conditioned on a reachable gateway. Connectivity, not a claim that any call is checked."
  ],
  ["You have two options:", "A list lead-in with no predicate of its own."],
  [
    "`npm install @agent-assembly/sdk@0.0.1-rc.6`",
    "A pinned install command, shown as inline code."
  ],
  ['import Tabs from "@theme/Tabs"; import TabItem from "@theme/TabItem";', STRUCTURAL]
]);

/**
 * Read the quick-start with line endings normalised to LF.
 *
 * Without this the paragraph split below never fires on Windows: git checks the
 * file out with CRLF, so `split("\n\n")` finds no `\n\n` and the whole section
 * collapses into one "sentence" that matches no binding. The four Windows legs
 * of test-matrix caught exactly that — the Linux and macOS legs stayed green,
 * which is why it is worth stating that this gate reads a file whose bytes
 * differ per platform.
 */
function readQuickStart(): string {
  return readFileSync(QUICK_START, "utf-8").replace(/\r\n/g, "\n");
}

/** Strips Docusaurus front matter, which otherwise flattens into sentence one. */
function stripFrontMatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function flattenMarkdown(text: string): string {
  return text.split(/\s+/).join(" ").trim();
}

/** A line that opens a list item or a table row starts a new unit. */
const UNIT_OPENER = /^\s*(?:[-*+]|\d+\.)\s|^\|/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+\.)\s+/gm;

function splitUnits(paragraph: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  for (const line of paragraph.split("\n")) {
    if (UNIT_OPENER.test(line) && current.length > 0) {
      units.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) units.push(current.join("\n"));
  return units;
}

/**
 * '.' and '?' only. '!' is not a terminator: emphatic prose and admonition
 * markers would otherwise split into fragments.
 *
 * Closing markup between the terminator and the space is kept WITH the
 * sentence, so a bold lead-in like "**Deny.**" ends there instead of running
 * into the claim it introduces — binding the glued pair covered both. A
 * backtick is deliberately excluded from that trailing class: inline code such
 * as `phi.*` would otherwise be read as a sentence end.
 */
const SENTENCE_END = /[.?][*)\]_"']*(?=\s)/g;

function splitSentences(unit: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const match of unit.matchAll(SENTENCE_END)) {
    const cut = match.index + match[0].length;
    out.push(unit.slice(start, cut));
    start = cut;
  }
  out.push(unit.slice(start));
  return out;
}

/**
 * Gates NOTHING. A severity hint in the failure message, and the trigger for the
 * stricter allow-list rule. See the header for why a keyword list is unsound.
 */
const ENFORCEMENT_VOCABULARY =
  /\bdenie[sd]\b|\bdeny\b|\bblocked\b|\bblocking\b|\bnever runs?\b|\bbefore execution\b|\bchecked against\b|\benforces?\b|\benforced\b|\bpassthrough\b|\bdiscards?\b|\bdiscarded\b|\bthrows?\b|\brejects?\b|\brouted\b|\bintercepts?\b|\binterception\b|\bgovern(s|ed|ance)?\b|\bverified\b|\bprotection\b|\bunprotected\b|\bbypass(ed|es)?\b/i;

/**
 * Every sentence in the document, keyed to its section heading.
 *
 * No section is skipped. Fenced code and comments become PARAGRAPH breaks:
 * replacing a fence with a space glued the sentences either side into one, and
 * a comment is invisible to a reader, so a bound claim commented out of the
 * rendered page must not still satisfy this gate.
 */
interface Occurrence {
  readonly text: string;
  readonly section: string;
}

/**
 * Every (sentence, section) OCCURRENCE. An array, not a record: keying by
 * sentence collapsed duplicates before anything counted them, so `matched === 1`
 * could only ever be 0 or 1 and a bound true sentence could be pasted into a
 * section that inverts its meaning — an observe-mode block, a "what not to do"
 * block — and still count once. Section attribution was last-write-wins too.
 */
function scannedOccurrences(): Occurrence[] {
  let body = stripFrontMatter(readQuickStart());
  for (const pattern of [/```[\s\S]*?```/g, /<!--[\s\S]*?-->/g, /\{\/\*[\s\S]*?\*\/\}/g]) {
    body = body.replace(pattern, "\n\n");
  }

  const occurrences: Occurrence[] = [];
  let section = "(preamble)";
  for (const chunk of body.split(/^(#{1,6} .*)$/m)) {
    if (chunk === undefined) continue;
    if (/^#{1,6} /.test(chunk)) {
      section = chunk.trim();
      continue;
    }
    for (const paragraph of chunk.split("\n\n")) {
      for (const unit of splitUnits(paragraph)) {
        for (const raw of splitSentences(unit.replace(LIST_MARKER, ""))) {
          const flat = flattenMarkdown(raw);
          if (flat !== "") occurrences.push({ text: flat, section });
        }
      }
    }
  }
  return occurrences;
}

/** The de-duplicated set, for membership questions where count does not matter. */
function scannedTexts(): Set<string> {
  return new Set(scannedOccurrences().map((occ) => occ.text));
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
    expect(scannedOccurrences().length).toBeGreaterThan(30);
  });

  it("reaches every section, including the last", () => {
    const sections = new Set(scannedOccurrences().map((occ) => occ.section));
    expect(sections.size).toBeGreaterThanOrEqual(5);
    // "## Next steps" used to be excluded by name, which made it a black hole:
    // a claim inserted there was never seen.
    expect([...sections], "'## Next steps' must be scanned, not excluded").toContain(
      "## Next steps"
    );
  });

  it("strips comments before scanning", () => {
    const document = readQuickStart();
    expect(document, "this control assumes the page still contains an MDX or HTML comment").toMatch(
      /<!--|\{\/\*/
    );
    for (const sentence of scannedTexts()) {
      expect(sentence).not.toContain("<!--");
      expect(sentence).not.toContain("{/*");
    }
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
  it("every allowed sentence is still present verbatim", () => {
    // An entry is a whole sentence, so rewording the claim makes the entry
    // stale and fails here rather than silently exempting the new wording.
    const scanned = scannedTexts();
    const stale = [...ALLOWED.keys()].filter((sentence) => !scanned.has(sentence));
    expect(
      stale,
      "ALLOWED contains sentences that no longer appear in the quick-start. Delete the stale " +
        "entries, and if a replacement makes a capability claim, bind it."
    ).toEqual([]);
  });

  it("only structural lines may use the bare constant", () => {
    // Every prose entry needs a written justification, not only the ones the
    // vocabulary already catches. Keying off the vocabulary was backwards: a
    // sentence that MATCHES it has already warned the author; one that EVADES
    // it has not, and evading it is why this scan was inverted.
    const offenders = [...ALLOWED.entries()]
      .filter(([sentence, reason]) => reason === STRUCTURAL && !STRUCTURAL_LINE.test(sentence))
      .map(([sentence]) => sentence);
    expect(
      offenders,
      "These allow-listed sentences are prose but are waved through with the bare STRUCTURAL " +
        "constant. Replace it with a written justification saying why this particular sentence " +
        "makes no capability claim, or bind it."
    ).toEqual([]);
  });

  it("no allow-listed sentence turns mid-way", () => {
    // An allow-listed sentence may not contain a contrastive conjunction. It
    // costs nothing on genuine non-claims, because a sentence that turns should
    // be split regardless of what its justification says.
    const offenders = [...ALLOWED.keys()].filter((sentence) =>
      CONTRASTIVE_CONJUNCTION.test(sentence)
    );
    expect(
      offenders,
      "These allow-listed sentences contain a contrastive conjunction, so part of each may be " +
        "an affirmative capability claim riding along under its justification. Split the " +
        "affirmative clause into its own sentence and bind it to the controls that prove it."
    ).toEqual([]);
  });

  it("no allow-listed sentence reassures across a negation", () => {
    // "Network-layer interception is not enabled by default, so the in-process
    // adapter verifies every outbound request before it leaves the host
    // instead." reads as a limitation and asserts a capability the product does
    // not have. The contrastive list does not catch it, because "so" is not
    // adversative — it is the reassurance that follows a denial, which is
    // precisely where an unbacked claim hides.
    const offenders = [...ALLOWED.keys()].filter((sentence) =>
      [...sentence.matchAll(SO_CONNECTOR)].some((match) => {
        const before = sentence.slice(0, match.index);
        const after = sentence.slice(match.index + match[0].length);
        return NEGATION.test(before) && !NEGATION.test(after);
      })
    );
    expect(
      offenders,
      'These allow-listed sentences negate something and then say "so ..." without a second ' +
        "negation — the shape of a limitation followed by a reassurance, where the reassurance " +
        'may be an unbacked capability claim. Split the clause after "so" into its own sentence ' +
        "and bind it to the controls that prove it."
    ).toEqual([]);
  });

  it("written justifications are substantial and distinct", () => {
    // A cheap partial, and only that. No gate can tell a justification from
    // noise — reason="x" is prose to a computer. Length and uniqueness only
    // make an empty gesture and a copy-paste visible in review.
    const written = [...ALLOWED.entries()].filter(([, reason]) => reason !== STRUCTURAL);
    const tooShort = written
      .filter(([, reason]) => reason.length < MIN_JUSTIFICATION)
      .map(([s]) => s);
    expect(tooShort, `justifications shorter than ${MIN_JUSTIFICATION} characters`).toEqual([]);

    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [sentence, reason] of written) {
      const other = seen.get(reason);
      if (other !== undefined) duplicates.push(`${reason} — used by both ${other} and ${sentence}`);
      seen.set(reason, sentence);
    }
    expect(
      duplicates,
      "A justification explains one specific sentence; reuse is copy-paste waving."
    ).toEqual([]);
  });

  it("every allow-list reason is non-empty", () => {
    const empty = [...ALLOWED.entries()]
      .filter(([, reason]) => reason.trim() === "")
      .map(([s]) => s);
    expect(empty).toEqual([]);
  });
});

describe("claim gate: every documented claim is bound", () => {
  it("no sentence is unbound and unallowed", () => {
    // The inversion. A keyword filter cannot be completed, because whoever adds
    // a claim picks the words after reading the filter — review appended three
    // plain sentences, one of them the negation of the product, and every
    // keyword-gated revision of this gate stayed green.
    const quotes = new Set(BINDINGS.map((binding) => binding.quote));
    const seen = new Set<string>();
    const loose = scannedOccurrences()
      .filter(({ text }) => {
        if (quotes.has(text) || ALLOWED.has(text) || seen.has(text)) return false;
        seen.add(text);
        return true;
      })
      .map(
        ({ text, section }) =>
          `  [${ENFORCEMENT_VOCABULARY.test(text) ? "CLAIM-LIKE" : "prose"}] [${section}] ${text}`
      );

    expect(
      loose,
      `${loose.length} sentence(s) are neither bound nor allow-listed:\n${loose.join("\n")}\n\n` +
        "CLAIM-LIKE marks a vocabulary match — a severity hint only. A sentence marked " +
        "'prose' can still be a claim, which is exactly why this gate does not filter on the " +
        "vocabulary.\nAdd a ClaimBinding whose quote is the WHOLE sentence and which names the " +
        "control that proves it (or an unprovenReason naming a ticket), or add it to ALLOWED " +
        "with a category. A vocabulary match needs a written justification there, not a category."
    ).toEqual([]);
  });

  it("nothing is both bound and allowed", () => {
    const overlap = BINDINGS.filter((binding) => ALLOWED.has(binding.quote)).map((b) => b.id);
    expect(overlap).toEqual([]);
  });

  it.each(BINDINGS.map((binding) => [binding.id, binding] as const))(
    "%s matches exactly one whole sentence",
    (_id, binding) => {
      // Whole-sentence equality, not containment. Containment allowed a
      // sentence to carry extra unbound claims — up to and including its own
      // negation — while one bound fragment kept the gate green.
      // Whole-sentence equality over OCCURRENCES, so `=== 1` is live: more
      // than one means the sentence now appears in two places, and a true
      // claim pasted into a section that inverts its meaning would otherwise
      // still be counted by this binding as the sentence that was proven.
      const where = scannedOccurrences()
        .filter((occ) => occ.text === binding.quote)
        .map((occ) => occ.section);
      expect(
        where.length,
        `ClaimBinding "${binding.id}" must match exactly one whole sentence occurrence; it ` +
          `matched ${where.length} (sections: ${JSON.stringify(where)}).\nIts quote is:\n  ${binding.quote}\n` +
          "0 means the claim was reworded, split, merged, or commented out."
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
    "%s does not name the implementing ticket",
    (_id, binding) => {
      // An unproven claim may not point at the ticket that closes it. On merge
      // that pointer resolves to a CLOSED issue and nothing would notice: the
      // ticket-shaped check below is satisfied by any AAASM-nnnn, open or not.
      expect(
        binding.unprovenReason ?? "",
        `Claim "${binding.id}" is registered unproven against ${IMPLEMENTING_TICKET}, the ticket ` +
          "this file implements. On merge that pointer resolves to a closed issue and the claim " +
          "is silently orphaned. Name the ticket that will actually resolve it, or file one."
      ).not.toContain(IMPLEMENTING_TICKET);
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

      const documented = [...readQuickStart().matchAll(/`([A-Za-z0-9_]+Error)`/g)].map(
        (match) => match[1]
      );
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
