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
 * A seam is writable only when the object is extensible AND its existing slot is
 * either absent, a writable data property, or an accessor with a setter — the
 * three shapes under which `target[seam] = …` does not throw. A frozen object is
 * non-extensible and short-circuits on the first clause.
 */
export function isSeamWritable(target: object, seam: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, seam);
  return (
    Object.isExtensible(target) &&
    (descriptor === undefined || descriptor.writable === true || descriptor.set !== undefined)
  );
}
