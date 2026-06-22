/**
 * SPA page-view tracker for the self-managed gtag setup (AAASM-3554).
 *
 * Because we no longer use preset-classic's built-in `gtag` plugin (so we can
 * guarantee the Consent-Mode default-denied init runs before the first hit —
 * see `docusaurus.config.ts`), we also lose that plugin's route-change
 * page-view tracking. This client module restores it with the same behaviour:
 * on every client-side navigation it sends an updated `page_path` and a
 * `page_view` event. Consent Mode still gates whether GA stores anything, so
 * this is safe to fire regardless of the visitor's choice.
 */
type Gtag = (...args: unknown[]) => void;

// Minimal shape of the history `Location` Docusaurus passes to client-module
// route hooks. Declared locally to avoid a direct `history` type dependency.
interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

export function onRouteDidUpdate({
  location,
  previousLocation,
}: {
  location: RouteLocation;
  previousLocation: RouteLocation | null;
}): void {
  if (
    !previousLocation ||
    (location.pathname === previousLocation.pathname &&
      location.search === previousLocation.search &&
      location.hash === previousLocation.hash)
  ) {
    return;
  }

  // Defer to the next tick so react-helmet-async has updated the document
  // title before we report the page view (mirrors the upstream gtag plugin).
  setTimeout(() => {
    const gtag = (window as unknown as { gtag?: Gtag }).gtag;
    if (typeof gtag === "function") {
      gtag(
        "set",
        "page_path",
        location.pathname + location.search + location.hash,
      );
      gtag("event", "page_view");
    }
  });
}
