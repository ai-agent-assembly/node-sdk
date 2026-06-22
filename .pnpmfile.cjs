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
// importer and `node_modules`. If the real `ai` / `@langchain/langgraph` /
// `@mastra/core` packages land in this repo's `node_modules`, the SDK's own unit
// suite trips: `initAssembly` detects the framework present and the Vercel adapter
// then assigns to the frozen ESM `tool` binding of the real `ai` module
// (`Cannot assign to read only property 'tool'`). Those frameworks must therefore
// stay declared-but-uninstalled here. `@langchain/core` / `@openai/agents` are left
// alone — `@langchain/core` is already a transitive dep of the `langchain` devDep
// and the existing suite relies on them being resolvable.
const STRIP_FROM_INSTALL = ["@langchain/langgraph", "ai", "@mastra/core"];

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
