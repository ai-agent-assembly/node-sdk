/**
 * "Was this page helpful? 👍 / 👎" feedback widget (AAASM-3555).
 *
 * Appended to the bottom of every documentation page's <article>. On a click it
 * fires a GA4 `feedback` event through the self-managed gtag set up in
 * AAASM-3552/3554 (`window.gtag`), then swaps the buttons for an
 * acknowledgement. A 👎 also reveals a link to a pre-filled GitHub issue so the
 * visitor can tell us what to improve.
 *
 * Why a clientModules injector rather than a swizzle of `@theme/DocItem/Footer`:
 * Docusaurus flags a wrap-swizzle of DocItem/Footer as "unsafe to perform"
 * (internal component, `--danger` required, likely to break on theme upgrades).
 * This injector follows the same `onRouteDidUpdate` client-module pattern the
 * site already uses for analytics (gtagRouteTracker.ts) and stays decoupled
 * from internal theme component shapes.
 *
 * The whole widget is built with `document.createElement` + `textContent`
 * (never `innerHTML` of dynamic data) to stay CodeQL-clean.
 */
import "./feedbackWidget.css";

type Gtag = (...args: unknown[]) => void;

const WIDGET_ID = "aa-doc-feedback";
const ISSUE_BASE = "https://github.com/ai-agent-assembly/node-sdk/issues/new";

// Minimal shape of the history `Location` Docusaurus passes to client-module
// route hooks. Declared locally to avoid a direct `history` type dependency.
interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

/** Send the GA4 feedback event, guarding on a usable gtag. Consent Mode gates
 *  storage automatically, so we fire regardless of the visitor's choice. */
function sendFeedback(value: 1 | 0): void {
  const gtag = (window as unknown as {gtag?: Gtag}).gtag;
  if (typeof gtag === "function") {
    gtag("event", "feedback", {
      value,
      page_path: window.location.pathname,
    });
  }
}

/** Build the pre-filled "improve this page" GitHub issue URL for 👎. */
function improveIssueUrl(): string {
  const title = `Docs feedback: ${encodeURIComponent(
    window.location.pathname,
  )}`;
  const body = encodeURIComponent(
    `Page: ${window.location.href}\n\nWhat could be improved?\n`,
  );
  return `${ISSUE_BASE}?labels=docs,feedback&title=${title}&body=${body}`;
}

/** Replace the widget's contents with the post-click acknowledgement. */
function showAcknowledgement(widget: HTMLElement, positive: boolean): void {
  while (widget.firstChild) {
    widget.removeChild(widget.firstChild);
  }

  const ack = document.createElement("p");
  ack.className = "feedbackWidget__ack";
  ack.textContent = "Thanks for your feedback!";
  widget.appendChild(ack);

  if (!positive) {
    const improve = document.createElement("a");
    improve.className = "feedbackWidget__improve";
    improve.href = improveIssueUrl();
    improve.target = "_blank";
    improve.rel = "noopener";
    improve.textContent = "Tell us what we can improve →";
    widget.appendChild(improve);
  }
}

function makeButton(
  label: string,
  ariaLabel: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "feedbackWidget__button";
  button.setAttribute("aria-label", ariaLabel);
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/** Build the full widget element. */
function buildWidget(): HTMLElement {
  const widget = document.createElement("div");
  widget.id = WIDGET_ID;
  widget.className = "feedbackWidget";

  const heading = document.createElement("p");
  heading.className = "feedbackWidget__heading";
  heading.textContent = "Was this page helpful?";
  widget.appendChild(heading);

  const buttons = document.createElement("div");
  buttons.className = "feedbackWidget__buttons";

  buttons.appendChild(
    makeButton("👍", "Yes, this page was helpful", () => {
      sendFeedback(1);
      showAcknowledgement(widget, true);
    }),
  );
  buttons.appendChild(
    makeButton("👎", "No, this page was not helpful", () => {
      sendFeedback(0);
      showAcknowledgement(widget, false);
    }),
  );

  widget.appendChild(buttons);
  return widget;
}

/** Mount the widget at the bottom of the current doc page's <article>, once. */
function mountWidget(): void {
  if (typeof document === "undefined") {
    return;
  }
  // Only on doc pages: Docusaurus renders docs inside <article>. Skip pages
  // (e.g. 404, search) that have no <article>, and never mount twice.
  const article = document.querySelector("article");
  if (!article || document.getElementById(WIDGET_ID)) {
    return;
  }
  article.appendChild(buildWidget());
}

export function onRouteDidUpdate({
  location,
  previousLocation,
}: {
  location: RouteLocation;
  previousLocation: RouteLocation | null;
}): void {
  // Mount on first load and after every client-side navigation. The DOM has
  // re-rendered by this hook, so a stale widget from the previous route is
  // gone and `mountWidget` re-adds a fresh one for the new <article>.
  if (
    previousLocation &&
    location.pathname === previousLocation.pathname &&
    location.search === previousLocation.search &&
    location.hash === previousLocation.hash
  ) {
    return;
  }
  // Defer a tick so the new route's <article> is in the DOM.
  setTimeout(mountWidget);
}
