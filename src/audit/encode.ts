// JSON wire-format bridge for the `AuditEvent` / `CallStackNode` interfaces
// declared in `../types/audit.ts`. Mirrors the gateway's snake_case JSON
// convention (consistent with the existing `sendEvent(handle, eventJSON)`
// path used by `native/aa-ffi-node`) — see AAASM-1450 for context.

import type { CallStackNode, CallStackNodeKind } from "../types/audit.js";

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
