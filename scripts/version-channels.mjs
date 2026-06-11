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
//                                               no banner — BUT only when that
//                                               pre-release is strictly newer
//                                               (semver precedence) than the
//                                               newest stable.
//   - any older / superseded snapshot        -> label "<tag>", banner "unmaintained"
//
// The pre-release GATE (AAASM-2751): the `pre-release (<tag>)` channel exists
// ONLY IF the newest pre-release snapshot is strictly greater (by SEMVER
// precedence) than the newest stable snapshot. A `vX.Y.Z-<pre>` always sorts
// BELOW its own `vX.Y.Z`, so once the stable `vX.Y.Z` (or anything newer) is
// cut the now-superseded pre-release loses its headline channel and becomes a
// plain archived snapshot (bare-tag label + `unmaintained` banner). It stays in
// the version list (reachable), it just no longer carries the `pre-release`
// label and no channel points at it. With no stable at all, any pre-release is
// trivially "ahead" and is shown.
//
// `lastVersion` (the default landing) is the newest stable snapshot, falling
// back to the newest SHOWN pre-release, falling back to "current" when nothing
// qualifies.
//
// The release workflow runs `docusaurus docs:version <tag>` first (which
// appends <tag> to versions.json), then runs this script to repoint the
// channels. Run from the repo root: `node scripts/version-channels.mjs`.

import {readFileSync, writeFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const STABLE_RE = /^v\d+\.\d+\.\d+$/;
const PRERELEASE_RE = /^v\d+\.\d+\.\d+-.+$/;

export function channelOf(tag) {
  if (STABLE_RE.test(tag)) return "stable";
  if (PRERELEASE_RE.test(tag)) return "pre-release";
  return "other";
}

// Compact semver precedence comparator (no runtime dependency).
//
// Parses `vX.Y.Z[-pre]` (the leading `v` is optional, build metadata after `+`
// is ignored) and compares per the SemVer 2.0.0 precedence rules:
//   - major, then minor, then patch numerically;
//   - a version WITHOUT a pre-release ranks HIGHER than one WITH;
//   - pre-release identifiers compared left-to-right: numeric ids numerically,
//     alphanumeric ids lexically (ASCII), numeric < alphanumeric, and a longer
//     identifier set wins when all shared identifiers are equal.
// Returns -1 / 0 / 1.
function parseSemver(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(tag);
  if (!m) throw new Error(`not a semver tag: ${tag}`);
  const [, major, minor, patch, pre] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: pre ? pre.split(".") : [],
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  // No pre-release outranks a pre-release of the same X.Y.Z.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      const da = Number(ia);
      const db = Number(ib);
      if (da !== db) return da < db ? -1 : 1;
    } else if (na !== nb) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return na ? -1 : 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  if (pa.pre.length !== pb.pre.length) {
    return pa.pre.length < pb.pre.length ? -1 : 1;
  }
  return 0;
}

// Pick the highest tag (by semver precedence) of a given channel.
function newestOf(snapshots, channel) {
  let best;
  for (const tag of snapshots) {
    if (channelOf(tag) !== channel) continue;
    if (best === undefined || compareSemver(tag, best) > 0) best = tag;
  }
  return best;
}

// Pure channel-assignment computed from ALL snapshots every run. Returns the
// `{lastVersion, versions}` object written to versionChannels.json. `snapshots`
// is the versions.json array (newest-first, but order is irrelevant here — the
// newest stable / pre-release are resolved by semver precedence).
export function computeChannels(snapshots) {
  const newestStable = newestOf(snapshots, "stable");
  const newestPrerelease = newestOf(snapshots, "pre-release");

  // THE GATE: the newest pre-release is only surfaced as the `pre-release`
  // channel when it is strictly ahead (semver) of the newest stable. With no
  // stable, any pre-release is trivially ahead.
  const prereleaseShown =
    newestPrerelease !== undefined &&
    (newestStable === undefined ||
      compareSemver(newestPrerelease, newestStable) > 0)
      ? newestPrerelease
      : undefined;

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
    } else if (tag === prereleaseShown) {
      // The newest pre-release, and it is ahead of the newest stable (or no
      // stable exists). It is the headline pre-release channel. It carries no
      // banner when it is also the default landing (no stable), otherwise it is
      // a maintained-but-not-default channel and still gets no warning banner.
      label = `pre-release (${tag})`;
      banner = "none";
    } else {
      // Older stable, or a SUPERSEDED pre-release (one that the gate dropped),
      // or any other archived snapshot: a plain archived version.
      label = tag;
      banner = "unmaintained";
    }
    versions[tag] = {label, banner};
  }

  // Default landing: newest stable, else newest SHOWN pre-release, else master.
  const lastVersion = newestStable ?? prereleaseShown ?? "current";

  return {lastVersion, versions};
}

// Side effects only when run directly (not when imported by the test).
function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const versionsPath = join(repoRoot, "website", "versions.json");
  const outPath = join(repoRoot, "website", "versionChannels.json");

  // `versions.json` lists snapshots newest-first (docusaurus prepends on cut).
  const snapshots = existsSync(versionsPath)
    ? JSON.parse(readFileSync(versionsPath, "utf8"))
    : [];

  const out = computeChannels(snapshots);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `version-channels: lastVersion=${out.lastVersion}; ` +
      `${snapshots.length} snapshot(s): ${snapshots.join(", ") || "(none)"}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
