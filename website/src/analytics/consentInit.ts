/**
 * Consent-Mode v2 default-denied bootstrap for Google Analytics (AAASM-3554).
 *
 * This string is injected verbatim as the `innerHTML` of the FIRST `headTags`
 * <script> in `docusaurus.config.ts`, ahead of the gtag.js loader and the
 * `gtag('config', ...)` hit. Running it first is what makes the site
 * GDPR-compliant: analytics/ads storage is denied by default, so gtag writes
 * no cookie until the visitor opts in via the banner.
 *
 * Order of operations in the snippet (all before the first GA hit):
 *   1. init `window.dataLayer` and the `gtag` shim
 *   2. `gtag('consent','default', {... 'denied'})` for analytics + ads storage
 *   3. re-apply a previously stored opt-in (`localStorage['aa-analytics-consent']
 *      === 'granted'`) via `gtag('consent','update', ...)`
 *
 * We deliberately do NOT use preset-classic's `gtag` option here: Docusaurus
 * appends `config.headTags` AFTER plugin-injected head tags, so a separate
 * head entry could not be guaranteed to precede the preset's `gtag('config')`
 * hit. By owning the whole init we get a deterministic deny-before-hit order.
 * The gtag.js loader and `gtag('config')` call live in the SECOND head script.
 */

/** GA4 Measurement ID (public, not a secret). */
export const GA_MEASUREMENT_ID = "G-6FHQKGLDE4";

/** localStorage key shared with the consent banner client module. */
export const CONSENT_STORAGE_KEY = "aa-analytics-consent";

/**
 * Consent-Mode default: deny analytics + advertising storage before any hit,
 * then restore a stored opt-in. Runs synchronously in <head>.
 */
export const consentDefaultScript = `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  'analytics_storage': 'denied',
  'ad_storage': 'denied',
  'ad_user_data': 'denied',
  'ad_personalization': 'denied'
});
try {
  if (window.localStorage.getItem('${CONSENT_STORAGE_KEY}') === 'granted') {
    gtag('consent', 'update', { 'analytics_storage': 'granted' });
  }
} catch (e) {}
`;

/**
 * gtag.js loader bootstrap. Runs AFTER {@link consentDefaultScript}, so the
 * default-denied consent state is already in `dataLayer` before `config` fires
 * the first hit. `anonymize_ip` mirrors the previous preset configuration.
 */
export const gtagConfigScript = `
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}', { 'anonymize_ip': true });
`;
