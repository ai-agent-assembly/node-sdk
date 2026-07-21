/**
 * Frozen-tool seam guard shared across the governance wrappers/adapters.
 *
 * Every SDK-layer enforcement path governs a caller-supplied tool by assigning a
 * wrapper over the tool's call seam in place (`tool.invoke = …`, `tool.execute =
 * …`). A caller is free to `Object.freeze` (or otherwise seal / redefine a
 * non-writable, setter-less) tool object; assigning to a seam on such an object
 * throws a `TypeError` under strict mode / ESM. An unguarded throw is worse than
 * the one tool it can't wrap: it aborts wrapping of every *remaining* tool and
 * can silently downgrade a whole session's enforcement (a policy DENY then no
 * longer blocks those tools). Each wrapper therefore consults this predicate and
 * skips-with-warning instead of assigning.
 *
 * This is the exact writability computation AAASM-4847 established inline in
 * `hooks/openai-agents.ts` (`wrapFunctionToolInvoke`), extracted so the sibling
 * seams the langchain wrapper and `withAssembly` mutate are guarded the same way
 * (AAASM-4852).
 */

/**
 * Whether assigning to `target[seam]` in place would succeed rather than throw.
 *
 * Two independent shapes let `target[seam] = …` succeed, and extensibility only
 * governs the second:
 *  - The slot **already exists** as a writable data property or an accessor with
 *    a setter — the assignment mutates it in place and succeeds *regardless of
 *    extensibility*. `Object.seal()` leaves data properties `writable:true` while
 *    setting `extensible:false`, so a sealed-but-writable seam is still writable;
 *    gating this case on extensibility was an over-conservative false-negative
 *    that skipped wrapping (and silently downgraded enforcement) on a seam the
 *    assignment would in fact have taken (AAASM-4951).
 *  - The slot is **absent** — assigning *adds* a property, which only succeeds
 *    when the object is extensible. A frozen object is non-extensible and has a
 *    non-writable slot, so both branches reject it.
 */
export function isSeamWritable(target: object, seam: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, seam);
  if (descriptor === undefined) {
    return Object.isExtensible(target);
  }
  return descriptor.writable === true || descriptor.set !== undefined;
}
