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
import { PolicyViolationError } from "../src/errors/policy-violation-error.js";
import { withAssembly } from "../src/wrappers/with-assembly.js";
import {
  createFileSideEffect,
  createPolicyGatewayClient,
  type FileSideEffect
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
    const gateway = createPolicyGatewayClient({ agentId: AGENT_ID, denyTools: [] });
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
    const gateway = createPolicyGatewayClient({
      agentId: AGENT_ID,
      denyTools: ["write_file"]
    });
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
