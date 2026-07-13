import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AAASM-4514: the quick-start section 3 framework tabs are generated into a
// bounded block in docs/02-quick-start/index.md from the vendored snippet
// manifest under metadata/quickstart-snippets/. These tests assert on the
// committed, rendered block (the shipped output) rather than importing the
// generator module: the generator's own regenerate-and-git-diff drift check
// exercises the generation path, and asserting on the output keeps this suite
// free of the generator's fenced-code string literals.

// The three-backtick code-fence marker, built from a unicode escape so the
// source carries no literal backtick at all (keeps the suite trivially portable
// across toolchains that tokenize source before running it).
const FENCE = "\u0060".repeat(3);

const docPath = path.resolve(
  fileURLToPath(import.meta.url),
  "../../..",
  "docs/02-quick-start/index.md"
);

function tabBlock(): string {
  const doc = readFileSync(docPath, "utf8");
  const match = doc.match(
    /BEGIN GENERATED: quickstart-framework-tabs[\s\S]*?END GENERATED: quickstart-framework-tabs/
  );
  if (match === null) {
    throw new Error("quickstart-framework-tabs generated block not found");
  }
  return match[0];
}

describe("quickstart framework tabs (generated doc block)", () => {
  it("renders a tab for every Node framework", () => {
    const block = tabBlock();
    for (const label of [
      "LangChain.js",
      "Custom (no framework)",
      "OpenAI (Node)",
      "Vercel AI SDK",
      "LangGraph.js",
      "Mastra"
    ]) {
      expect(block).toContain(label);
    }
  });

  it("orders validated frameworks before experimental ones", () => {
    const block = tabBlock();
    expect(block.indexOf("langchain-js-basic-agent")).toBeLessThan(
      block.indexOf("langgraph-js")
    );
    expect(block.indexOf("custom-tool-policy")).toBeLessThan(
      block.indexOf("mastra")
    );
  });

  it("defaults to LangChain.js and suffixes experimental tab labels", () => {
    const block = tabBlock();
    expect(block).toContain('label="LangChain.js" default');
    expect(block).toContain('label="Mastra (Experimental)"');
    expect(block).toContain('label="LangGraph.js (Experimental)"');
    // Validated frameworks keep a plain label (no suffix).
    expect(block).not.toContain("LangChain.js (Experimental)");
  });

  it("embeds each framework's snippet in a ts code fence", () => {
    const block = tabBlock();
    expect(block).toContain(FENCE + "ts");
    for (const agentId of [
      "langchain-js-example-agent",
      "custom-tool-policy-agent",
      "openai-node-example-agent",
      "vercel-ai-example-agent",
      "langgraph-js-example-agent",
      "mastra-example-agent"
    ]) {
      expect(block).toContain(agentId);
    }
  });
});
