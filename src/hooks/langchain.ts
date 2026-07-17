import type { NativeClient } from "../native/client.js";

/**
 * Intentional no-op stub: native-transport LangChain patching is not
 * implemented. LangChain enforcement is performed in the SDK's wrapper layer
 * (`wrapToolWithAssembly`, pre-execution deny — the only layer that actually
 * blocks) plus an audit-only callback layer, both wired by `initAssembly`, not
 * through this native hook — so there is nothing to patch here yet. Returns
 * `false` (nothing patched) for every mode.
 *
 * The `client` parameter is retained to keep the adapter-registry hook
 * signature (and the public `patchLangChain` export) uniform with the other
 * `patch*` hooks; it is deliberately unused until native patching lands.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub param kept for signature stability; see TSDoc above
export async function patchLangChain(client: NativeClient): Promise<boolean> {
  return false;
}
