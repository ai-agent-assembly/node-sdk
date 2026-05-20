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

  it("translates snake_case wire keys to camelCase interface fields and back", () => {
    const event: AuditEvent = {
      eventId: "evt-2",
      agentId: "support-agent",
      actionType: "tool_call",
      decision: "redact",
      traceId: "trace-xyz",
      spanId: "span-9",
      parentSpanId: "span-8",
      callStack: [
        { id: "n0", kind: "tool", label: "gmail.send", latencyMs: 0 },
      ],
    };

    const wire = JSON.parse(encodeAuditEvent(event)) as Record<string, unknown>;

    expect(Object.keys(wire).sort()).toEqual([
      "action_type",
      "agent_id",
      "call_stack",
      "decision",
      "event_id",
      "parent_span_id",
      "span_id",
      "trace_id",
    ]);
    expect(wire.event_id).toBe("evt-2");
    expect(wire.action_type).toBe("tool_call");
    expect(wire.parent_span_id).toBe("span-8");
    expect(Array.isArray(wire.call_stack)).toBe(true);
    const [node] = wire.call_stack as Array<Record<string, unknown>>;
    expect(node?.latency_ms).toBe(0);
    expect(node).not.toHaveProperty("latencyMs");
    expect(node).not.toHaveProperty("callStack");

    expect(decodeAuditEvent(wire)).toEqual(event);
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
