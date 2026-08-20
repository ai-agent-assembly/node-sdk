#!/usr/bin/env node
// AAASM-5676 / AAASM-5689 -- errata banners for retracted claims in frozen
// Docusaurus version snapshots.
//
// Frozen version snapshots (`website/versioned_docs/version-*/`) are never
// rewritten -- see the owner decision recorded on AAASM-5676 and the reusable
// rule in agent-assembly's `docs/src/development/content-ownership.md`
// ("Reviewer classes and recurring audits"). Instead, `website/retractions.json`
// names each retracted claim by a literal substring, and this script finds
// every (version, page) pair whose Markdown source contains that substring --
// across `docs/` (the `current` tree) AND every `versioned_docs/version-*/`
// directory, so the default-served version is covered by the same pass as
// every frozen one, with no special-casing.
//
// The result is written as a TypeScript module,
// `website/src/generated/retraction-map.ts`, matching the
// `scripts/generate-docs-metadata.mjs` -> `src/generated/install-hints.ts`
// precedent already in this repo: fully overwritten on every run, so
// `git diff --exit-code` after regenerating is the CI drift check (also the
// "check that fails if a retracted claim appears on a default-served
// documentation page" AAASM-5676 asks for -- a page containing a registered
// pattern with no corresponding map entry is exactly what a stale, un-
// regenerated map looks like).
//
// This does NOT prove a false claim has been found and registered in the
// first place -- it only proves the map matches what `retractions.json`
// already knows to look for. Finding new false claims is
// check_claim_vocabulary's job (docs repo); this script's job starts once a
// claim is already retracted.
//
// Zero network access. Reads local repo state only.
//
// Run from the repo root:  node scripts/generate-retraction-map.mjs
// CI check:                node scripts/generate-retraction-map.mjs && git diff --exit-code

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const WEBSITE_DIR = resolve(REPO_ROOT, "website");
const RETRACTIONS_PATH = resolve(WEBSITE_DIR, "retractions.json");
const OUT_PATH = resolve(WEBSITE_DIR, "src/generated/retraction-map.ts");

// Docusaurus's own version-directory naming: `versioned_docs/version-<v>/`,
// where `<v>` matches the string used in `versionChannels.json`/`versions.json`.
const VERSIONED_DOCS_DIR = resolve(WEBSITE_DIR, "versioned_docs");
const CURRENT_DOCS_DIR = resolve(REPO_ROOT, "docs");

function listMarkdownFiles(dir) {
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md") || entry.endsWith(".mdx")) {
        out.push(full);
      }
    }
  }
  try {
    walk(dir);
  } catch {
    // Directory absent (e.g. no versioned_docs yet) -- nothing to scan.
  }
  return out;
}

function loadRetractions() {
  const raw = JSON.parse(readFileSync(RETRACTIONS_PATH, "utf8"));
  return raw.retractions;
}

// version -> { pagePath (relative to docs root) -> [retraction ids] }
function buildMap(retractions) {
  const map = {};

  const versionDirs = [];
  try {
    for (const entry of readdirSync(VERSIONED_DOCS_DIR)) {
      const full = join(VERSIONED_DOCS_DIR, entry);
      if (statSync(full).isDirectory() && entry.startsWith("version-")) {
        const version = entry.slice("version-".length);
        versionDirs.push({ version, dir: full });
      }
    }
  } catch {
    // No versioned_docs directory -- only `current` is scanned below.
  }
  versionDirs.push({ version: "current", dir: CURRENT_DOCS_DIR });

  for (const { version, dir } of versionDirs) {
    for (const file of listMarkdownFiles(dir)) {
      const text = readFileSync(file, "utf8");
      const pagePath = relative(dir, file).replace(/\\/g, "/");
      for (const retraction of retractions) {
        if (text.includes(retraction.pattern)) {
          map[version] ??= {};
          map[version][pagePath] ??= [];
          map[version][pagePath].push(retraction.id);
        }
      }
    }
  }
  return map;
}

// Per-page precision (`retractionMap`) needs the runtime to resolve a URL
// slug back to the source Markdown path it was rendered from -- Docusaurus's
// numeric-prefix stripping and directory-index rules make that resolution
// its own nontrivial problem, and getting it wrong would show the WRONG
// notice on a page (or none at all) with no visible symptom. So the client
// module (retractionBanner.ts) works at the coarser, but robustly correct,
// per-VERSION granularity: which version is being viewed IS reliably knowable
// client-side from the URL prefix alone (`versionChannels.json`'s own `path`
// config already defines that mapping). `retractionMap` stays in this file at
// full page precision for humans auditing which specific pages are affected
// -- it is not dead weight, only not what the runtime banner reads.
function versionRollup(map) {
  const rollup = {};
  for (const [version, pages] of Object.entries(map)) {
    const ids = new Set();
    for (const pageIds of Object.values(pages)) {
      for (const id of pageIds) ids.add(id);
    }
    rollup[version] = [...ids].sort();
  }
  return rollup;
}

function render(map, retractions) {
  const noticesById = Object.fromEntries(
    retractions.map((r) => [r.id, { notice: r.notice, canonical: r.canonical }])
  );
  const byVersion = versionRollup(map);
  return `// GENERATED FILE -- do not hand-edit.
// Regenerate with: node scripts/generate-retraction-map.mjs
// AAASM-5676 / AAASM-5689. See that script for what this maps and why.

export interface RetractionNotice {
  notice: string;
  canonical: string;
}

// version -> pagePath (relative to that version's docs root) -> retraction ids.
// Full page precision, for humans auditing which pages are affected. The
// runtime banner does NOT read this -- see retractionsByVersion below.
export const retractionMap: Record<string, Record<string, string[]>> = ${JSON.stringify(map, null, 2)};

// version -> retraction ids present anywhere in that version. What
// retractionBanner.ts actually reads at runtime -- see this script's module
// docstring for why page-level precision isn't used client-side.
export const retractionsByVersion: Record<string, string[]> = ${JSON.stringify(byVersion, null, 2)};

export const retractionNoticesById: Record<string, RetractionNotice> = ${JSON.stringify(noticesById, null, 2)};
`;
}

function main() {
  const retractions = loadRetractions();
  const map = buildMap(retractions);
  const rendered = render(map, retractions);
  writeFileSync(OUT_PATH, rendered, "utf8");
  const versionCount = Object.keys(map).length;
  const pageCount = Object.values(map).reduce((n, pages) => n + Object.keys(pages).length, 0);
  console.log(
    `generate-retraction-map: ${retractions.length} registered retraction(s), ` +
      `${versionCount} version(s) with a match, ${pageCount} page(s) flagged`
  );
}

main();
