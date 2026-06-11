#!/usr/bin/env node
// Unit tests for the channel-assignment logic in version-channels.mjs
// (AAASM-2751). Run with: `node scripts/version-channels.test.mjs`.
//
// Focus: the pre-release GATE — the `pre-release (<tag>)` channel exists only
// when the newest pre-release is strictly ahead (semver) of the newest stable.

import {test} from "node:test";
import assert from "node:assert/strict";

import {
  computeChannels,
  compareSemver,
  channelOf,
} from "./version-channels.mjs";

// Helper: find which tag (if any) carries a `pre-release (...)` / `stable (...)`
// label.
function labelled(versions, prefix) {
  for (const [tag, v] of Object.entries(versions)) {
    if (tag === "current") continue;
    if (v.label.startsWith(prefix)) return tag;
  }
  return undefined;
}

test("compareSemver: pre-release sorts below its release", () => {
  assert.equal(compareSemver("v0.1.0-rc.1", "v0.1.0"), -1);
  assert.equal(compareSemver("v0.1.0", "v0.1.0-rc.1"), 1);
});

test("compareSemver: alpha < beta < rc", () => {
  assert.equal(compareSemver("v0.1.0-alpha.5", "v0.1.0-beta.1"), -1);
  assert.equal(compareSemver("v0.1.0-beta.2", "v0.1.0-rc.1"), -1);
  assert.equal(compareSemver("v0.1.0-alpha.5", "v0.1.0-alpha.6"), -1);
});

test("compareSemver: numeric pre-release ids compared numerically", () => {
  assert.equal(compareSemver("v0.1.0-alpha.2", "v0.1.0-alpha.10"), -1);
});

test("channelOf classifies stable vs pre-release", () => {
  assert.equal(channelOf("v0.0.2"), "stable");
  assert.equal(channelOf("v0.1.0-rc.1"), "pre-release");
});

// Scenario 1: pre-releases ahead of the only stable -> pre-release shown.
test("scenario 1: pre-release ahead of stable is the headline channel", () => {
  const snapshots = [
    "v0.1.0-rc.1",
    "v0.1.0-beta.2",
    "v0.1.0-beta.1",
    "v0.1.0-alpha.6",
    "v0.1.0-alpha.5",
    "v0.0.2",
  ];
  const {lastVersion, versions} = computeChannels(snapshots);

  assert.equal(labelled(versions, "pre-release ("), "v0.1.0-rc.1");
  assert.equal(versions["v0.1.0-rc.1"].label, "pre-release (v0.1.0-rc.1)");
  assert.equal(versions["v0.1.0-rc.1"].banner, "none");

  assert.equal(labelled(versions, "stable ("), "v0.0.2");
  assert.equal(versions["v0.0.2"].label, "stable (v0.0.2)");
  assert.equal(versions["v0.0.2"].banner, "none");

  // Superseded older pre-releases are plain archived snapshots.
  assert.equal(versions["v0.1.0-beta.2"].label, "v0.1.0-beta.2");
  assert.equal(versions["v0.1.0-beta.2"].banner, "unmaintained");

  assert.equal(lastVersion, "v0.0.2");
});

// Scenario 2: stable v0.1.0 lands -> it supersedes v0.1.0-rc.1, gate drops the
// pre-release label entirely.
test("scenario 2: stable superseding the pre-release drops the pre-release label", () => {
  const snapshots = [
    "v0.1.0",
    "v0.1.0-rc.1",
    "v0.1.0-beta.2",
    "v0.1.0-beta.1",
    "v0.1.0-alpha.6",
    "v0.1.0-alpha.5",
    "v0.0.2",
  ];
  const {lastVersion, versions} = computeChannels(snapshots);

  assert.equal(labelled(versions, "stable ("), "v0.1.0");
  assert.equal(versions["v0.1.0"].label, "stable (v0.1.0)");
  assert.equal(versions["v0.1.0"].banner, "none");

  // NO version carries the pre-release label.
  assert.equal(labelled(versions, "pre-release ("), undefined);

  // The superseded rc is archived (reachable, bare-tag, unmaintained banner).
  assert.equal(versions["v0.1.0-rc.1"].label, "v0.1.0-rc.1");
  assert.equal(versions["v0.1.0-rc.1"].banner, "unmaintained");

  // Older stable demoted to bare tag.
  assert.equal(versions["v0.0.2"].label, "v0.0.2");
  assert.equal(versions["v0.0.2"].banner, "unmaintained");

  assert.equal(lastVersion, "v0.1.0");
});

// Scenario 3: a NEW pre-release v0.2.0-alpha.1 lands ahead of stable v0.1.0 ->
// pre-release re-appears on the new snapshot, stable stays put.
test("scenario 3: new pre-release ahead of stable resurfaces the channel", () => {
  const snapshots = [
    "v0.2.0-alpha.1",
    "v0.1.0",
    "v0.1.0-rc.1",
    "v0.1.0-beta.2",
    "v0.1.0-beta.1",
    "v0.1.0-alpha.6",
    "v0.1.0-alpha.5",
    "v0.0.2",
  ];
  const {lastVersion, versions} = computeChannels(snapshots);

  assert.equal(labelled(versions, "pre-release ("), "v0.2.0-alpha.1");
  assert.equal(
    versions["v0.2.0-alpha.1"].label,
    "pre-release (v0.2.0-alpha.1)",
  );
  assert.equal(versions["v0.2.0-alpha.1"].banner, "none");

  assert.equal(labelled(versions, "stable ("), "v0.1.0");
  assert.equal(versions["v0.1.0"].label, "stable (v0.1.0)");

  // The old rc remains superseded (v0.1.0 > v0.1.0-rc.1).
  assert.equal(versions["v0.1.0-rc.1"].label, "v0.1.0-rc.1");

  assert.equal(lastVersion, "v0.1.0");
});

// No stable at all -> any pre-release is "ahead" and is shown + is lastVersion.
test("no stable: pre-release is shown and is the default landing", () => {
  const snapshots = ["v0.1.0-rc.1", "v0.1.0-beta.1"];
  const {lastVersion, versions} = computeChannels(snapshots);
  assert.equal(versions["v0.1.0-rc.1"].label, "pre-release (v0.1.0-rc.1)");
  assert.equal(lastVersion, "v0.1.0-rc.1");
});

// Empty -> current owns the root, no path override.
test("no snapshots: current is lastVersion and owns the root", () => {
  const {lastVersion, versions} = computeChannels([]);
  assert.equal(lastVersion, "current");
  assert.equal(versions.current.path, undefined);
});
