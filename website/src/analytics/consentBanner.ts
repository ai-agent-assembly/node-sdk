/**
 * Cookie-consent opt-in banner client module (AAASM-3554).
 *
 * GDPR-compliant opt-in gate for Google Analytics. The Consent-Mode default is
 * set to `denied` for every storage type by the head script in
 * `docusaurus.config.ts` *before* the first gtag hit, so no analytics cookie is
 * written until the visitor explicitly accepts here.
 *
 * This module is dependency-free vanilla JS: it builds the banner with
 * `document.createElement` + `textContent` (never `innerHTML`, to stay
 * CodeQL-clean) and wires Accept / Reject buttons that flip Consent Mode and
 * persist the choice in `localStorage`. Once a choice is stored the banner is
 * never shown again.
 */
import "./consentBanner.css";

// Shared with the head consent-default script in docusaurus.config.ts.
const STORAGE_KEY = "aa-analytics-consent";
const GRANTED = "granted";
const DENIED = "denied";
const BANNER_ID = "aa-consent-banner";

type Gtag = (...args: unknown[]) => void;

function getStoredChoice(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage can throw in private-mode / disabled-storage browsers.
    return null;
  }
}

function storeChoice(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Best-effort: if persistence fails the banner simply shows again later.
  }
}

function updateConsent(granted: boolean): void {
  const gtag = (window as unknown as { gtag?: Gtag }).gtag;
  if (typeof gtag === "function") {
    gtag("consent", "update", {
      analytics_storage: granted ? GRANTED : DENIED,
    });
  }
}

function removeBanner(): void {
  const existing = document.getElementById(BANNER_ID);
  existing?.parentNode?.removeChild(existing);
}

function makeButton(label: string, modifier: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `aa-consent-banner__button aa-consent-banner__button--${modifier}`;
  button.textContent = label;
  return button;
}

function renderBanner(): void {
  if (document.getElementById(BANNER_ID)) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "aa-consent-banner";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Cookie consent");

  const text = document.createElement("p");
  text.className = "aa-consent-banner__text";
  text.textContent =
    "We use Google Analytics to understand how the docs are used. Analytics " +
    "cookies stay off until you accept.";

  const actions = document.createElement("div");
  actions.className = "aa-consent-banner__actions";

  const accept = makeButton("Accept", "accept");
  const reject = makeButton("Reject", "reject");

  accept.addEventListener("click", () => {
    updateConsent(true);
    storeChoice(GRANTED);
    removeBanner();
  });

  reject.addEventListener("click", () => {
    updateConsent(false);
    storeChoice(DENIED);
    removeBanner();
  });

  actions.appendChild(accept);
  actions.appendChild(reject);
  banner.appendChild(text);
  banner.appendChild(actions);
  document.body.appendChild(banner);

  // Keyboard-accessible: move focus to the primary action so a keyboard user
  // can act on the banner immediately and Tab between the two buttons.
  accept.focus();
}

function init(): void {
  // A stored choice (granted or denied) means the visitor already opted in or
  // out — never show the banner again.
  if (getStoredChoice() !== null) {
    return;
  }
  renderBanner();
}

// Docusaurus client modules run in the browser only, but guard anyway so the
// SSG build (which imports this module) never touches `document`.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
