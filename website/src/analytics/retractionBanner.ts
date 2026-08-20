/**
 * Retracted-claim errata banner client module (AAASM-5676 / AAASM-5689).
 *
 * Owner-decided policy (recorded on AAASM-5676): frozen Docusaurus version
 * snapshots (`website/versioned_docs/version-<v>/`) are never rewritten when a
 * claim is retracted. Instead this module renders a visible, non-dismissible
 * notice on any page belonging to a version that contains a retracted claim,
 * so the retraction is visible however the reader arrived -- a direct old
 * URL, a search result, or the version picker -- not only on navigation.
 *
 * Like consentBanner.ts, this is dependency-free vanilla JS
 * (`document.createElement` + `textContent`, never `innerHTML`) so it has no
 * dependency on the docs theme bundle and stays CodeQL-clean.
 *
 * GRANULARITY: per-version, not per-page. Resolving a URL slug back to the
 * source Markdown path it was rendered from (Docusaurus's numeric-prefix
 * stripping, directory-index rules) is its own nontrivial problem, and
 * getting it wrong would show the WRONG notice on a page (or none) with no
 * visible symptom -- see scripts/generate-retraction-map.mjs's module
 * docstring. Determining which VERSION a page belongs to, by contrast, is
 * reliably knowable from the URL prefix alone (the same mapping
 * versionChannels.json already encodes), so that is the boundary this module
 * draws: if a version contains any retracted claim, every page in that
 * version shows the notice for that claim, not only the affected page.
 */
import "./retractionBanner.css";
import versionChannels from "../../versionChannels.json";
import { retractionsByVersion, retractionNoticesById } from "../generated/retraction-map";

const BASE_URL = "/node-sdk/";
const BANNER_ID = "aa-retraction-banner";

// Exported for tests/scripts/retraction-banner.test.ts; not otherwise used
// outside this module.
export function resolveVersion(pathname: string): string {
  const rest = pathname.startsWith(BASE_URL) ? pathname.slice(BASE_URL.length) : pathname;

  const currentPath = (versionChannels.versions as Record<string, { path?: string }>).current?.path;
  const currentPrefix = (currentPath ?? "/next/").replace(/^\/+/, "").replace(/\/+$/, "") + "/";
  if (rest.startsWith(currentPrefix)) {
    return "current";
  }

  for (const version of Object.keys(retractionsByVersion)) {
    if (version === "current" || version === versionChannels.lastVersion) continue;
    if (rest.startsWith(`${version}/`)) {
      return version;
    }
  }

  // No known non-default version prefix matched: this is the default-served
  // (lastVersion) tree, served at the base path with no version segment.
  return versionChannels.lastVersion;
}

function buildBanner(ids: string[]): HTMLElement {
  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "aa-retraction-banner";
  banner.setAttribute("role", "note");

  const icon = document.createElement("span");
  icon.className = "aa-retraction-banner__icon";
  icon.textContent = "⚠";
  banner.appendChild(icon);

  for (const id of ids) {
    const info = retractionNoticesById[id];
    if (!info) continue; // Stale id in the map; fail open on rendering, not silently on detection.

    const text = document.createElement("span");
    text.className = "aa-retraction-banner__text";
    text.textContent = `${info.notice} `;

    const link = document.createElement("a");
    link.className = "aa-retraction-banner__link";
    link.href = info.canonical;
    link.textContent = "See the corrected explanation";

    text.appendChild(link);
    banner.appendChild(text);
  }

  return banner;
}

function render(): void {
  const existing = document.getElementById(BANNER_ID);
  existing?.parentNode?.removeChild(existing);

  const version = resolveVersion(window.location.pathname);
  const ids = retractionsByVersion[version];
  if (!ids || ids.length === 0) return;

  const banner = buildBanner(ids);
  document.body.insertBefore(banner, document.body.firstChild);
}

if (typeof window !== "undefined") {
  // Initial full page load.
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
}

// Docusaurus's own client-module route-change hook (see
// gtagRouteTracker.ts's onRouteDidUpdate for the same pattern) -- re-run on
// every client-side navigation, since a version boundary is exactly the kind
// of transition Docusaurus does not hard-reload the page for.
export function onRouteDidUpdate(): void {
  render();
}
