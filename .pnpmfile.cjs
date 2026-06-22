// pnpm install hook — keep optional framework peerDependencies as a *published
// contract* without pulling their (heavy) dependency trees into this repo's own
// install / test environment.
//
// node-sdk auto-detects 5 agent frameworks (LangChain, OpenAI Agents, LangGraph,
// Vercel AI SDK, Mastra) at runtime and patches them in-process. We declare every
// one as an optional `peerDependency` so a consumer who already has the framework
// gets a correct version range — that is a contract, not an install.
//
// pnpm 10 materializes *declared* peerDependencies (even optional ones) into the
// importer and `node_modules`. We keep the heavyweight `@langchain/langgraph` and
// `@mastra/core` declared-but-uninstalled here purely to avoid pulling their large
// dependency trees into this repo's own install — their adapters mutate a class
// *prototype*, not the module namespace, so they never crashed on a frozen ESM.
//
// `ai` is now installed as a `devDependency` (not stripped): AAASM-3532 fixed the
// Vercel adapter so it no longer assigns to the frozen ESM `tool` binding of the
// real `ai` module (it falls back to a shim copy), and the real-`ai` regression
// test in `tests/vercel-ai-real-module.test.ts` needs the genuine frozen namespace
// to prove the fix. `@langchain/core` / `@openai/agents` are likewise left alone —
// `@langchain/core` is already a transitive dep of the `langchain` devDep and the
// existing suite relies on them being resolvable.
const STRIP_FROM_INSTALL = ["@langchain/langgraph", "@mastra/core"];

function readPackage(pkg) {
  if (pkg.name === "@agent-assembly/sdk") {
    for (const dep of STRIP_FROM_INSTALL) {
      if (pkg.peerDependencies) {
        delete pkg.peerDependencies[dep];
      }
      if (pkg.peerDependenciesMeta) {
        delete pkg.peerDependenciesMeta[dep];
      }
    }
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage
  }
};
