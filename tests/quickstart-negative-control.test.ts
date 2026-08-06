/**
 * Enforcement-truth negative controls for the documented Node quick-start
 * (AAASM-5529, Epic AAASM-5526).
 *
 * `docs/02-quick-start/index.md` §3 tells a reader that `withAssembly` wraps a
 * tool map so "an allowed call executes normally, while a denied call throws a
 * `PolicyViolationError` and the tool body never runs". Every existing test of
 * that claim asserts it with a `vi.fn()` spy. A spy proves the SDK did not call
 * a function it holds a reference to; it does not prove that the *effect the
 * tool exists to produce* was prevented. This suite closes that gap: each tool
 * here performs a real, externally-observable effect (a file on disk, an HTTP
 * request delivered to a live loopback listener), and each deny is asserted as
 * the absence of that effect.
 *
 * Every negative control is paired with a positive control over the same tool
 * and the same fixture. Without the pair, "the file is absent" is satisfied
 * equally well by enforcement working and by the tool being incapable of
 * writing anything — which is precisely the class of vacuous evidence this
 * Epic exists to eliminate.
 *
 * The `FALSIFICATION` cases run the identical tool with governance removed
 * (calling the pre-wrap function directly). They must observe the side effect.
 * If they ever stop observing it, every deny assertion in this file has become
 * vacuous and the suite is no longer measuring enforcement.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors/configuration-error.js";
import { PolicyViolationError } from "../src/errors/policy-violation-error.js";
import { initAssembly } from "../src/core/init-assembly.js";
import { withAssembly } from "../src/wrappers/with-assembly.js";
import {
  createFileSideEffect,
  createNetworkSideEffect,
  createPolicyGatewayClient,
  type FileSideEffect,
  type NetworkSideEffect
} from "./helpers/negative-control.js";

const AGENT_ID = "quickstart-negative-control-agent";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function fileEffect(): FileSideEffect {
  const effect = createFileSideEffect();
  cleanups.push(effect.cleanup);
  return effect;
}

async function networkEffect(): Promise<NetworkSideEffect> {
  const effect = await createNetworkSideEffect();
  cleanups.push(effect.close);
  return effect;
}

/**
 * Settle a governed call without letting its outcome abort the test.
 *
 * The side-effect assertion is the load-bearing one, so it must be reached and
 * evaluated even when the call unexpectedly *succeeds*. Asserting `rejects`
 * first would short-circuit there and leave the side-effect assertion
 * unexercised — the falsification run would then only ever prove "no error was
 * thrown", which is the weak evidence this suite exists to replace.
 */
async function settle(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    (value) => value,
    (error: unknown) => error
  );
}

describe("quick-start negative control: filesystem side effect", () => {
  it("POSITIVE CONTROL: an allowed write_file really creates the file on disk", async () => {
    const effect = fileEffect();
    const gateway = createPolicyGatewayClient({ denyTools: [] });
    const tools = {
      write_file: { execute: async (content: string) => effect.write(content) }
    };

    withAssembly(tools, { gatewayClient: gateway, agentId: AGENT_ID });
    await tools.write_file.execute("allowed-content");

    expect(effect.occurred()).toBe(true);
    expect(effect.content()).toBe("allowed-content");
  });

  it("NEGATIVE CONTROL: a denied write_file leaves no file on disk", async () => {
    const effect = fileEffect();
    const gateway = createPolicyGatewayClient({ denyTools: ["write_file"] });
    const tools = {
      write_file: { execute: async (content: string) => effect.write(content) }
    };

    withAssembly(tools, { gatewayClient: gateway, agentId: AGENT_ID });

    const outcome = await settle(tools.write_file.execute("denied-content"));

    // The load-bearing assertion, asserted first: not "an error was raised", but
    // "the effect the tool exists to produce is absent from the filesystem".
    expect(effect.occurred()).toBe(false);
    expect(effect.content()).toBeUndefined();
    // Secondary: the client also receives the documented error.
    expect(outcome).toBeInstanceOf(PolicyViolationError);
    expect((outcome as Error).message).toContain("Tool 'write_file' blocked");
  });

  it("FALSIFICATION: the same write, ungoverned, does create the file", async () => {
    const effect = fileEffect();

    // No withAssembly, no gateway — enforcement removed. If this does not write,
    // the negative control above is vacuous.
    await effect.write("ungoverned-content");

    expect(effect.occurred()).toBe(true);
    expect(effect.content()).toBe("ungoverned-content");
  });
});

describe("quick-start negative control: network side effect", () => {
  it("POSITIVE CONTROL: an allowed egress tool reaches the listener", async () => {
    const effect = await networkEffect();
    const gateway = createPolicyGatewayClient({ denyTools: [] });
    const tools = {
      post_report: { execute: async (body: string) => effect.call(body) }
    };

    withAssembly(tools, { gatewayClient: gateway, agentId: AGENT_ID });
    const status = await tools.post_report.execute("allowed-payload");

    expect(status).toBe(204);
    expect(effect.requests()).toHaveLength(1);
    expect(effect.requests()[0]?.body).toBe("allowed-payload");
  });

  it("NEGATIVE CONTROL: a denied egress tool never reaches the listener", async () => {
    const effect = await networkEffect();
    const gateway = createPolicyGatewayClient({ denyTools: ["post_report"] });
    const tools = {
      post_report: { execute: async (body: string) => effect.call(body) }
    };

    withAssembly(tools, { gatewayClient: gateway, agentId: AGENT_ID });

    const outcome = await settle(tools.post_report.execute("denied-payload"));

    // The listener is live and was reachable throughout (the positive control
    // above proves that on the same fixture), so zero received requests is
    // evidence the egress did not happen — not that it could not have.
    expect(effect.occurred()).toBe(false);
    expect(effect.requests()).toHaveLength(0);
    expect(outcome).toBeInstanceOf(PolicyViolationError);
  });

  it("FALSIFICATION: the same egress, ungoverned, does reach the listener", async () => {
    const effect = await networkEffect();

    await effect.call("ungoverned-payload");

    expect(effect.occurred()).toBe(true);
    expect(effect.requests()[0]?.body).toBe("ungoverned-payload");
  });
});

describe("quick-start negative control: what a deny is and is not attributed to", () => {
  it("records the tool name and run id the deny was decided against, and no agent id", async () => {
    const effect = fileEffect();
    const gateway = createPolicyGatewayClient({ denyTools: ["write_file"] });
    const tools = {
      write_file: { execute: async (content: string) => effect.write(content) }
    };

    withAssembly(tools, { gatewayClient: gateway, agentId: AGENT_ID });

    const outcome = await settle(tools.write_file.execute("denied-content"));

    // The load-bearing assertion, asserted first — the same shape the other
    // negative controls in this file already use. Asserting the error first
    // aborts the test before this line is ever reached, so under a mutation
    // that neuters the deny this control failed on the missing exception and
    // its absence check was never exercised at all.
    expect(effect.occurred()).toBe(false);
    // Secondary: the client also receives the documented error.
    expect(outcome).toBeInstanceOf(PolicyViolationError);

    expect(gateway.decisions).toHaveLength(1);
    const decision = gateway.decisions[0];
    expect(decision?.denied).toBe(true);
    expect(decision?.toolName).toBe("write_file");
    expect(decision?.action).toBe("tool_call");
    // A run id must be present so the deny can be correlated with the rest of
    // the trace; an anonymous deny is not usable evidence.
    expect(decision?.runId).toMatch(/^run_/);

    // And what the deny is NOT attributed to: an agent.
    //
    // This test used to assert `decision.agentId === AGENT_ID`, which could
    // never fail. The fixture populated that field from its own constructor
    // argument, so the assertion compared the constant this test passed with
    // itself; it stayed green even when `withAssembly` was handed a completely
    // different agent id. The SDK never supplied it and still does not:
    // `WithAssemblyOptions` declares `agentId` (src/wrappers/with-assembly.ts)
    // and no code path reads it, and `GatewayCheckRequest`
    // (src/types/gateway-governance.ts) has no field to carry it. The
    // documented quick-start passes an `agentId`
    // (docs/02-quick-start/index.md) and the SDK discards it.
    //
    // Pinning the real shape of the outbound request is worth more than
    // claiming an attribution the SDK does not make: this assertion fails the
    // moment the gap is closed, which is exactly when someone needs to know.
    expect(gateway.checkRequests).toHaveLength(1);
    const requestKeys = Object.keys(gateway.checkRequests[0] ?? {}).sort();
    expect(
      requestKeys,
      "The outbound GatewayCheckRequest shape changed. If an agent identity is " +
        "now sent on the tool-call check path then this gap is CLOSED, and this " +
        "test must be REWRITTEN (not deleted) to assert the deny carries the " +
        "correct agent id — passing withAssembly a different agentId than the " +
        "fixture expects, so that the new assertion is able to fail."
    ).toEqual(["action", "args", "runId", "toolName"]);
  });
});

describe("quick-start negative control: an ungoverned seam cannot look protected", () => {
  it("a tool with no execute/invoke seam is warned about and still performs its effect", async () => {
    const effect = fileEffect();
    const gateway = createPolicyGatewayClient({ denyTools: ["run_now"] });
    // No `execute` / `invoke`: withAssembly has nothing to wrap (AAASM-4847).
    const tools = { run_now: { call: async () => effect.write("unwrappable") } };

    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      withAssembly(tools, { gatewayClient: gateway, agentId: AGENT_ID });
    } finally {
      process.stderr.write = originalWrite;
    }

    // The SDK must say so out loud rather than let the caller believe the tool
    // is governed (AAASM-5526: a degraded path may not present as protected).
    expect(warnings.join("")).toContain("will NOT be governed");

    // And the negative control proves the warning is not cosmetic: the effect
    // really does happen despite the deny policy, because nothing intercepts it.
    await tools.run_now.call();
    expect(effect.occurred()).toBe(true);
    expect(gateway.decisions).toHaveLength(0);
  });
});

describe("quick-start negative control: the zero-config initAssembly path", () => {
  it("refuses to init when wrapped tools would route through the allow-all no-op client", async () => {
    // The README quickstart config verbatim: gatewayUrl + agentId + langchain
    // tools, no `mode`, no `enforcementMode`. An omitted posture resolves
    // fail-closed, and mode "auto" is not check-capable, so the AAASM-4735
    // guard refuses rather than register under a check that cannot deny.
    // Asserting the refusal is the negative control for this path: there is no
    // configuration here under which a deny could be silently allowed, because
    // there is no working configuration at all.
    const effect = fileEffect();
    const tool = {
      name: "write_file",
      invoke: async () => effect.write("should-never-run")
    };

    const outcome = await settle(
      initAssembly({
        gatewayUrl: "http://localhost:7391",
        agentId: AGENT_ID,
        langchain: { tools: { write_file: tool } }
      })
    );

    expect(effect.occurred()).toBe(false);
    expect(outcome).toBeInstanceOf(ConfigurationError);
    expect((outcome as Error).message).toContain("allow-all no-op");
  });

  it("BOUNDARY: enforcementMode observe inits and lets the tool body run", async () => {
    // The documented opt-out. It must really pass through, otherwise the
    // refusal above would be indistinguishable from "this path never works" —
    // and a reader would have no way to tell an advisory posture from an
    // enforcing one. This posture is telemetry-only: tool checks route through
    // the allow-all no-op client, so no policy decision can block a call here.
    const effect = fileEffect();
    const tool = {
      name: "write_file",
      invoke: async () => effect.write("observe-posture")
    };

    const context = await initAssembly({
      gatewayUrl: "http://localhost:7391",
      agentId: AGENT_ID,
      enforcementMode: "observe",
      langchain: { tools: { write_file: tool } }
    });
    try {
      await tool.invoke();
    } finally {
      await context.shutdown();
    }

    expect(effect.occurred()).toBe(true);
    expect(effect.content()).toBe("observe-posture");
  });
});
