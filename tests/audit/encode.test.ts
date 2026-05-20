import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/types/audit.js";
import { decodeAuditEvent, encodeAuditEvent } from "../../src/audit/encode.js";

describe("AuditEvent wire round-trip", () => {
  it("preserves a three-level call stack (LLM → tool → result) with no data loss", () => {
    const original: AuditEvent = {
      eventId: "evt-1",
      agentId: "support-agent",
      actionType: "llm_call",
      decision: "allow",
      traceId: "trace-abc",
      spanId: "span-1",
      parentSpanId: "span-0",
      labels: { tenant: "acme", env: "prod" },
      callStack: [
        {
          id: "n0",
          kind: "llm",
          label: "gpt-4o",
          latencyMs: 300,
          children: [
            {
              id: "n1",
              kind: "tool",
              label: "gmail.send",
              latencyMs: 120,
              children: [
                { id: "n2", kind: "result", label: "200 OK", latencyMs: 5 },
              ],
            },
          ],
        },
      ],
    };

    const decoded = decodeAuditEvent(encodeAuditEvent(original));

    expect(decoded).toEqual(original);
  });

  it("decodes a legacy payload that has no call_stack into callStack === undefined", () => {
    const legacy = JSON.stringify({
      event_id: "evt-legacy",
      agent_id: "old-agent",
      action_type: "llm_call",
      decision: "allow",
    });

    const decoded = decodeAuditEvent(legacy);

    expect(decoded.callStack).toBeUndefined();
    expect(decoded).toEqual({
      eventId: "evt-legacy",
      agentId: "old-agent",
      actionType: "llm_call",
      decision: "allow",
    });
  });
});
