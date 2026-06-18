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

describe("decodeAuditEvent — malformed wire payloads", () => {
  const validBase = {
    event_id: "evt-1",
    agent_id: "agent-1",
    action_type: "llm_call",
    decision: "allow",
  };

  it.each([
    ["a JSON array (non-object root)", "[1, 2, 3]"],
    ["a JSON scalar (non-object root)", "42"],
    ["JSON null (non-object root)", "null"],
  ])("throws TypeError for %s", (_label, payload) => {
    expect(() => decodeAuditEvent(payload)).toThrow(TypeError);
    expect(() => decodeAuditEvent(payload)).toThrow(/expected JSON object/);
  });

  it.each([
    ["event_id", "AuditEvent.event_id"],
    ["agent_id", "AuditEvent.agent_id"],
    ["action_type", "AuditEvent.action_type"],
    ["decision", "AuditEvent.decision"],
  ])("throws TypeError when %s is missing", (field, message) => {
    const wire: Record<string, unknown> = { ...validBase };
    delete wire[field];
    expect(() => decodeAuditEvent(wire)).toThrow(TypeError);
    expect(() => decodeAuditEvent(wire)).toThrow(new RegExp(message));
  });
});

describe("decodeCallStackNode — malformed nodes", () => {
  const valid = { id: "n0", kind: "tool", label: "gmail.send" };

  it("throws TypeError when a call_stack child is not an object", () => {
    const wire = {
      event_id: "evt-1",
      agent_id: "agent-1",
      action_type: "tool_call",
      decision: "allow",
      call_stack: ["not-an-object"],
    };
    expect(() => decodeAuditEvent(wire)).toThrow(TypeError);
    expect(() => decodeAuditEvent(wire)).toThrow(/expected JSON object/);
  });

  it.each([
    ["id", "CallStackNode.id"],
    ["kind", "CallStackNode.kind"],
    ["label", "CallStackNode.label"],
  ])("throws TypeError when node.%s is missing", (field, message) => {
    const node: Record<string, unknown> = { ...valid };
    delete node[field];
    const wire = {
      event_id: "evt-1",
      agent_id: "agent-1",
      action_type: "tool_call",
      decision: "allow",
      call_stack: [node],
    };
    expect(() => decodeAuditEvent(wire)).toThrow(TypeError);
    expect(() => decodeAuditEvent(wire)).toThrow(new RegExp(message));
  });
});
