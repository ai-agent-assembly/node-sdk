// JSON wire-format bridge for the `AuditEvent` / `CallStackNode` interfaces
// declared in `../types/audit.ts`. Mirrors the gateway's snake_case JSON
// convention (consistent with the existing `sendEvent(handle, eventJSON)`
// path used by `native/aa-ffi-node`) — see AAASM-1450 for context.

import type {
  AuditEvent,
  CallStackNode,
  CallStackNodeKind,
} from "../types/audit.js";

/**
 * Wire-form shape of a {@link CallStackNode}. Keys are snake_case to
 * match the gateway's JSON convention; the `children` field is itself
 * a recursive `WireCallStackNode[]`.
 *
 * Optional fields are omitted from the encoded payload when undefined
 * rather than emitted as `null`, so a decoded round-trip yields the
 * original `undefined` (not `null`).
 */
export interface WireCallStackNode {
  id: string;
  kind: string;
  label: string;
  latency_ms?: number;
  children?: WireCallStackNode[];
}

/**
 * Wire-form shape of an {@link AuditEvent}. Keys are snake_case to
 * match the gateway's JSON convention; optional fields are omitted
 * when undefined (rather than emitted as `null` or empty string), so a
 * decoded round-trip yields the original `undefined`.
 */
export interface WireAuditEvent {
  event_id: string;
  agent_id: string;
  action_type: string;
  decision: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  labels?: Record<string, string>;
  call_stack?: WireCallStackNode[];
}

/**
 * Translate a {@link CallStackNode} into its wire JSON object form.
 *
 * Recurses through `children`. Optional fields (`latencyMs`,
 * `children`) are dropped when undefined or — for `children` — empty,
 * so the resulting object is the minimal payload the gateway accepts.
 */
export function encodeCallStackNode(node: CallStackNode): WireCallStackNode {
  const wire: WireCallStackNode = {
    id: node.id,
    kind: node.kind satisfies CallStackNodeKind,
    label: node.label,
  };
  if (node.latencyMs !== undefined) {
    wire.latency_ms = node.latencyMs;
  }
  if (node.children !== undefined && node.children.length > 0) {
    wire.children = node.children.map(encodeCallStackNode);
  }
  return wire;
}

/**
 * Serialize an {@link AuditEvent} to its JSON wire string.
 *
 * Translates the camelCase interface field names into the gateway's
 * snake_case keys (`eventId` → `event_id`, `callStack` → `call_stack`,
 * etc.), recursively encoding the call-stack tree via
 * {@link encodeCallStackNode}. Optional fields whose value is
 * `undefined`, an empty string, or an empty array are omitted so a
 * legacy decoder that has never seen those fields reads the payload
 * unchanged.
 */
export function encodeAuditEvent(event: AuditEvent): string {
  const wire: WireAuditEvent = {
    event_id: event.eventId,
    agent_id: event.agentId,
    action_type: event.actionType,
    decision: event.decision,
  };
  if (event.traceId !== undefined && event.traceId !== "") {
    wire.trace_id = event.traceId;
  }
  if (event.spanId !== undefined && event.spanId !== "") {
    wire.span_id = event.spanId;
  }
  if (event.parentSpanId !== undefined && event.parentSpanId !== "") {
    wire.parent_span_id = event.parentSpanId;
  }
  if (event.labels !== undefined && Object.keys(event.labels).length > 0) {
    wire.labels = event.labels;
  }
  if (event.callStack !== undefined && event.callStack.length > 0) {
    wire.call_stack = event.callStack.map(encodeCallStackNode);
  }
  return JSON.stringify(wire);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected JSON object on the wire");
  }
  return value as Record<string, unknown>;
}

/**
 * Translate a wire JSON object back into a {@link CallStackNode}.
 *
 * Symmetric inverse of {@link encodeCallStackNode}: walks `children`
 * recursively, restores `latencyMs` from `latency_ms`, and treats a
 * missing or empty `children` field as `undefined` on the interface
 * side (matches AAASM-1436's default).
 */
export function decodeCallStackNode(payload: unknown): CallStackNode {
  const wire = asRecord(payload);
  const id = wire.id;
  const kindRaw = wire.kind;
  const label = wire.label;
  if (typeof id !== "string") {
    throw new TypeError("CallStackNode.id missing or not a string");
  }
  if (typeof kindRaw !== "string") {
    throw new TypeError("CallStackNode.kind missing or not a string");
  }
  if (typeof label !== "string") {
    throw new TypeError("CallStackNode.label missing or not a string");
  }
  const node: CallStackNode = {
    id,
    kind: kindRaw as CallStackNodeKind,
    label,
  };
  if (typeof wire.latency_ms === "number") {
    node.latencyMs = wire.latency_ms;
  }
  if (Array.isArray(wire.children) && wire.children.length > 0) {
    node.children = wire.children.map(decodeCallStackNode);
  }
  return node;
}
