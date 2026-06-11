#!/usr/bin/env node
// Regenerate website/versionChannels.json from the cut Docusaurus snapshots
// (website/versions.json) using the channel model (AAASM-2751).
//
// Channels:
//   - `current` (the live ../docs)           -> label "latest (master)",
//                                               path "/next/", banner "unreleased"
//   - newest STABLE snapshot   (vX.Y.Z)      -> label "stable (<tag>)", base path,
//                                               no banner, and is `lastVersion`
//   - newest PRE-RELEASE snap.  (vX.Y.Z-...)  -> label "pre-release (<tag>)",
//                                               no banner
//   - any older snapshot                     -> label "<tag>", banner "unmaintained"
//
// `lastVersion` (the default landing) is the newest stable snapshot, falling
// back to the newest pre-release, falling back to "current" when nothing is
// cut yet.
//
// The release workflow runs `docusaurus docs:version <tag>` first (which
// appends <tag> to versions.json), then runs this script to repoint the
// channels. Run from the repo root: `node scripts/version-channels.mjs`.

import {readFileSync, writeFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionsPath = join(repoRoot, "website", "versions.json");
const outPath = join(repoRoot, "website", "versionChannels.json");

const STABLE_RE = /^v\d+\.\d+\.\d+$/;
const PRERELEASE_RE = /^v\d+\.\d+\.\d+-.+$/;

function channelOf(tag) {
  if (STABLE_RE.test(tag)) return "stable";
  if (PRERELEASE_RE.test(tag)) return "pre-release";
  return "other";
}

// `versions.json` lists snapshots newest-first (docusaurus prepends on cut).
const snapshots = existsSync(versionsPath)
  ? JSON.parse(readFileSync(versionsPath, "utf8"))
  : [];

const newestStable = snapshots.find((t) => channelOf(t) === "stable");
const newestPrerelease = snapshots.find((t) => channelOf(t) === "pre-release");

// `current` is always the in-development "latest (master)" channel.
//
// Path: once any snapshot is cut, `current` is served at `/next/` so it never
// collides at the site root with a cut version (the root is owned by the
// stable/pre-release `lastVersion`). Before the first snapshot exists there is
// no other version to own the root, and `current`'s `slug: /` intro page must
// stay at the root — so `current` keeps the root path until a snapshot lands.
const hasSnapshots = snapshots.length > 0;
const versions = {
  current: {
    label: "latest (master)",
    ...(hasSnapshots ? {path: "/next/"} : {}),
    banner: "unreleased",
  },
};

for (const tag of snapshots) {
  let label;
  let banner;
  if (tag === newestStable) {
    label = `stable (${tag})`;
    banner = "none";
  } else if (tag === newestPrerelease && !newestStable) {
    // Only surface the pre-release as the headline channel while no stable
    // exists; once a stable lands the pre-release is just an older snapshot.
    label = `pre-release (${tag})`;
    banner = "none";
  } else if (tag === newestPrerelease) {
    label = `pre-release (${tag})`;
    banner = "unmaintained";
  } else {
    label = tag;
    banner = "unmaintained";
  }
  versions[tag] = {label, banner};
}

// Default landing: newest stable, else newest pre-release, else master.
const lastVersion = newestStable ?? newestPrerelease ?? "current";

const out = {lastVersion, versions};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(
  `version-channels: lastVersion=${lastVersion}; ` +
    `${snapshots.length} snapshot(s): ${snapshots.join(", ") || "(none)"}`,
);
