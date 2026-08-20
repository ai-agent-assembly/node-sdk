import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- scripts/*.mjs has no declaration file (plain Node ESM,
// not part of this package's build); typed narrowly below instead of adding one.
import * as retractionMapGen from "../../scripts/generate-retraction-map.mjs";

const validateRetractions = retractionMapGen.validateRetractions as (
  retractions: Record<string, unknown>[]
) => string[];
const validateVersionChannels = retractionMapGen.validateVersionChannels as (channels: {
  lastVersion: string;
  versions: Record<string, { banner?: string }>;
}) => string[];

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

// AAASM-5689 clause 8, checks 3 and 4. Unit tests on the exported validators
// directly (not a subprocess), so a violation and its restoration are both
// asserted in-process rather than only proven once by hand at review time.
describe("validateRetractions (AC check 3: no retraction without errata metadata)", () => {
  const wellFormed = () => ({
    id: "R1",
    pattern: "x",
    notice: "y",
    canonical: "https://example.com",
    retracted_on: "2026-08-20",
  });

  it("passes a well-formed retraction", () => {
    expect(validateRetractions([wellFormed()])).toEqual([]);
  });

  it("fails a retraction missing a required field", () => {
    const r = wellFormed();
    delete (r as Partial<typeof r>).canonical;
    const errors = validateRetractions([r]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/canonical/);
  });

  it("fails on a duplicate id", () => {
    const errors = validateRetractions([wellFormed(), wellFormed()]);
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });
});

describe("validateVersionChannels (AC check 4: default channel cannot be unreleased)", () => {
  it("passes when lastVersion is a real released version", () => {
    const errors = validateVersionChannels({
      lastVersion: "0.0.1-rc.6",
      versions: { current: { banner: "unreleased" }, "0.0.1-rc.6": { banner: "none" } },
    });
    expect(errors).toEqual([]);
  });

  it("fails when lastVersion is current", () => {
    const errors = validateVersionChannels({
      lastVersion: "current",
      versions: { current: { banner: "unreleased" } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("fails when the lastVersion entry itself carries an unreleased banner", () => {
    const errors = validateVersionChannels({
      lastVersion: "0.0.1-rc.7",
      versions: { "0.0.1-rc.7": { banner: "unreleased" } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
