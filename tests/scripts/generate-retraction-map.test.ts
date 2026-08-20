import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AAASM-5676 / AAASM-5689. Like generate-docs-metadata.test.ts, this asserts
// on the committed, generated output rather than importing
// scripts/generate-retraction-map.mjs directly: `website/` is a separate
// pnpm project from the SDK root (see this repo's CLAUDE.md), so the
// generator's own regenerate-and-git-diff drift check (publish-docs.yml)
// exercises the generation path; this suite pins the shipped shape.

const mapPath = path.resolve(
  fileURLToPath(import.meta.url),
  "../../..",
  "website/src/generated/retraction-map.ts"
);

const registryPath = path.resolve(
  fileURLToPath(import.meta.url),
  "../../..",
  "website/retractions.json"
);

function mapSource(): string {
  return readFileSync(mapPath, "utf8");
}

describe("retraction map (generated)", () => {
  it("flags the known AAASM-5528 activation-claim retraction in the frozen 0.0.1-rc.6 snapshot", () => {
    const source = mapSource();
    // Loose substring check on the rendered JSON, not a full parse -- this is
    // pinning shipped output the same way generate-docs-metadata.test.ts does,
    // not re-implementing the generator's own logic.
    expect(source).toContain('"0.0.1-rc.6"');
    const rc6Block = source.slice(source.indexOf("retractionsByVersion:"));
    expect(rc6Block).toMatch(/"0\.0\.1-rc\.6":\s*\[\s*"AAASM-5528-activation-claim"/);
  });

  it("does NOT flag the current (already-corrected) docs tree", () => {
    const source = mapSource();
    const byVersionBlock = source.slice(
      source.indexOf("retractionsByVersion:"),
      source.indexOf("retractionNoticesById:")
    );
    expect(byVersionBlock).not.toMatch(/"current":/);
  });

  it("carries a notice and canonical link for every id it references", () => {
    const source = mapSource();
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      retractions: { id: string }[];
    };
    for (const { id } of registry.retractions) {
      expect(source).toContain(`"${id}"`);
    }
    expect(source).toMatch(/"notice": "This statement is factually incorrect and has been retracted/);
  });
});
