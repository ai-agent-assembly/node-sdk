import {themes as prismThemes} from "prism-react-renderer";
import type {Config} from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// Channel-based version metadata (AAASM-2751). `lastVersion` (the default
// landing) and the per-version `label`/`path`/`banner` entries are regenerated
// by the release workflow (scripts/version-channels.mjs) each time a snapshot
// is cut, so they live in data, not inline. See ../docs/releasing.md.
import versionChannels from "./versionChannels.json";

// Google Analytics + GDPR consent gating (AAASM-3554, fast-follow to
// AAASM-3552). We self-manage the gtag init instead of using preset-classic's
// `gtag` option so the Consent-Mode default-denied state is guaranteed to be
// in place BEFORE the first GA hit. See ./src/analytics/consentInit.ts.
import {
  GA_MEASUREMENT_ID,
  consentDefaultScript,
  gtagConfigScript,
} from "./src/analytics/consentInit";

const config: Config = {
  title: "@agent-assembly/sdk",
  tagline: "TypeScript and Node.js SDK for Agent Assembly",
  favicon: "img/favicon.png",

  future: {
    v4: true,
  },

  // Production docs origin. Docusaurus derives the emitted `<link
  // rel="canonical">` and OpenGraph `og:url` from `url` + `baseUrl`, so this
  // points at the custom docs domain the hub serves the module under
  // (https://docs.agent-assembly.com/node-sdk/...). The GitHub Pages
  // deployment (ai-agent-assembly.github.io/node-sdk/) keeps working as a
  // mirror because in-site routing is driven by `baseUrl`, not `url`.
  url: "https://docs.agent-assembly.com",
  baseUrl: "/node-sdk/",

  organizationName: "ai-agent-assembly",
  projectName: "node-sdk",

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  // Self-managed Google Analytics with Consent Mode v2 (AAASM-3554).
  //
  // These two <head> scripts replace preset-classic's `gtag` option. They are
  // injected in array order at the position of `<%~ it.headTags %>` in the SSG
  // template — i.e. before the deferred app bundle and before any GA hit:
  //
  //   1. consentDefaultScript — defines `dataLayer`/`gtag`, sets Consent-Mode
  //      default to DENIED for analytics + ads storage, then restores a stored
  //      opt-in. This MUST run first so GA writes no cookie until opt-in.
  //   2. the gtag.js loader (async) + gtagConfigScript — loads gtag and fires
  //      `gtag('config', ...)` (the first hit), which now respects the
  //      already-denied default above.
  //
  // Owning the whole init (rather than relying on `config.headTags`, which
  // Docusaurus appends AFTER plugin head tags) is what guarantees the
  // deny-before-hit ordering. The opt-in banner lives in clientModules below.
  headTags: [
    {
      tagName: "script",
      attributes: {},
      innerHTML: consentDefaultScript,
    },
    {
      tagName: "link",
      attributes: {
        rel: "preconnect",
        href: "https://www.google-analytics.com",
      },
    },
    {
      tagName: "link",
      attributes: {
        rel: "preconnect",
        href: "https://www.googletagmanager.com",
      },
    },
    {
      tagName: "script",
      attributes: {
        // headTags config validation requires string attribute values.
        async: "true",
        src: `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`,
      },
    },
    {
      tagName: "script",
      attributes: {},
      innerHTML: gtagConfigScript,
    },
  ],

  // Vanilla-JS opt-in cookie-consent banner + SPA page-view tracker
  // (AAASM-3554). The tracker replaces the route tracking we lose by not using
  // the preset `gtag` plugin.
  clientModules: [
    require.resolve("./src/analytics/gtagRouteTracker.ts"),
    require.resolve("./src/analytics/consentBanner.ts"),
    // "Was this page helpful? 👍 / 👎" doc feedback widget (AAASM-3555). A
    // client module rather than a DocItem/Footer swizzle: Docusaurus flags
    // wrap-swizzling that internal component as unsafe (`--danger` required).
    // The widget reuses the self-managed `window.gtag` from AAASM-3552/3554.
    require.resolve("./src/analytics/feedbackWidget.ts"),
  ],

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  themes: [
    "@docusaurus/theme-mermaid",
    // Offline/local search (AAASM-3550). Indexes the docs at build time and
    // ships a client-side search box — zero external service. Docs are served
    // at the site root (`routeBasePath: "/"`) and there is no blog, so point
    // the indexer at `/` and disable blog indexing. `hashed` adds a content
    // hash to the index URL for long-term browser caching.
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: "/",
        language: ["en"],
      },
    ],
  ],

  plugins: [
    [
      "docusaurus-plugin-typedoc",
      {
        entryPoints: ["../src/index.ts"],
        tsconfig: "../tsconfig.build.json",
        out: "../docs/06-api-reference/api",
        readme: "none",
        gitRemote: "remote",
        sidebar: {
          autoConfiguration: true,
          pretty: true,
        },
      },
    ],
  ],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          path: "../docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          // AAASM-4556: the autogenerated sidebar (`dirName: "."` in
          // sidebars.ts) walks every file under `path` above, so anything
          // that ever lands in `../docs/` becomes sidebar-eligible whether
          // or not it's meant to be published. Two known offenders, both
          // reproducible only in a contributor's local working tree (never
          // committed — `docs/api/` is gitignored, `docs/superpowers/` was
          // never added — so a clean CI checkout never has them, but a local
          // `pnpm build` after running an older/pre-migration doc generator,
          // or after an unrelated local tool drops scratch content into
          // `docs/`, would still leak them into that contributor's nav):
          //   - `docs/api/` — TypeDoc output from before the plugin's `out`
          //     was moved to `docs/06-api-reference/api/` (see the
          //     docusaurus-plugin-typedoc config below; "Nest generated
          //     TypeDoc output under API Reference section"), leaving this
          //     path a stale duplicate wherever a local checkout still has it.
          //   - `docs/superpowers/` — an internal design-spec scratch
          //     directory, not reader-facing content.
          // Exclude them at the content-docs level (not just the sidebar)
          // so they're skipped entirely rather than merely hidden.
          exclude: [
            // Docusaurus classic-preset defaults (must be repeated — setting
            // `exclude` overrides them rather than extending them).
            "**/_*.{js,cjs,jsx,ts,tsx,md,mdx}",
            "**/_*/**",
            "**/*.test.{js,cjs,jsx,ts,tsx}",
            "**/__tests__/**",
            // AAASM-4556 additions.
            "api/**",
            "superpowers/**",
          ],
          editUrl: "https://github.com/ai-agent-assembly/node-sdk/tree/master/",
          // Per-page git "Last updated" date + committer (AAASM-2747).
          // Docusaurus derives both from `git log` for each doc file, so the
          // publish-docs workflow checks out full history (`fetch-depth: 0`).
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
          // Channel-based documentation versioning (AAASM-2751).
          //
          // The docs site models three release "channels" on top of
          // Docusaurus' immutable version snapshots:
          //
          //   - `current` (the live `../docs`) tracks `master`. It is the
          //     "latest (master)" channel, served at `/next/` (NOT `/`) so it
          //     never collides at the root with a real cut version, and it
          //     carries the native `unreleased` banner.
          //   - the newest STABLE snapshot (tag `vX.Y.Z`) is the "stable"
          //     channel. It becomes `lastVersion` and is served at the base
          //     path (the default landing).
          //   - the newest PRE-RELEASE snapshot (tag `vX.Y.Z-...`) is the
          //     "pre-release" channel. When no stable exists yet it is the
          //     default landing instead.
          //
          // `lastVersion` defaults to the newest snapshot, falling back to
          // `current` when no snapshot exists. So today — before any snapshot
          // is cut — `current` is still served at the root even though its
          // own `path` is `/next/`, and the dropdown shows just
          // "latest (master)".
          //
          // Snapshots are cut by the RELEASE workflow
          // (`.github/workflows/release-node.yml`), which runs
          // `pnpm docusaurus docs:version <tag>` after a successful publish
          // and then regenerates `lastVersion` plus the per-version `label`s,
          // `path`s and `banner`s in `versionChannels.json` (via
          // scripts/version-channels.mjs). See ../docs/releasing.md.
          // Do NOT cut a snapshot or edit those fields by hand.
          lastVersion: versionChannels.lastVersion,
          versions: versionChannels.versions as Record<
            string,
            {
              label?: string;
              path?: string;
              banner?: "none" | "unreleased" | "unmaintained";
            }
          >,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
        // Google Analytics 4 is initialised via `headTags` above (AAASM-3554)
        // instead of preset-classic's `gtag` option, so the Consent-Mode
        // default-denied init is guaranteed to run before the first GA hit.
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "@agent-assembly/sdk",
      logo: {
        alt: "AI Agent Assembly",
        src: "img/logo.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        {
          type: "docsVersionDropdown",
          position: "right",
        },
        {
          type: "dropdown",
          label: "SDKs",
          position: "right",
          items: [
            {
              label: "Docs Hub",
              href: "https://docs.agent-assembly.com/",
            },
            {
              label: "Python SDK",
              href: "https://docs.agent-assembly.com/python-sdk/",
            },
            {
              label: "Node SDK",
              href: "https://docs.agent-assembly.com/node-sdk/",
            },
            {
              label: "Go SDK",
              href: "https://docs.agent-assembly.com/go-sdk/",
            },
          ],
        },
        {
          href: "https://github.com/ai-agent-assembly/node-sdk",
          label: "GitHub",
          position: "right",
        },
        {
          href: "https://www.npmjs.com/package/@agent-assembly/sdk",
          label: "npm",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Project",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/ai-agent-assembly/node-sdk",
            },
            {
              label: "npm package",
              href: "https://www.npmjs.com/package/@agent-assembly/sdk",
            },
            {
              label: "Issues",
              href: "https://github.com/ai-agent-assembly/node-sdk/issues",
            },
          ],
        },
        {
          title: "SDKs",
          items: [
            {
              label: "Docs Hub",
              href: "https://docs.agent-assembly.com/",
            },
            {
              label: "Python SDK",
              href: "https://docs.agent-assembly.com/python-sdk/",
            },
            {
              label: "Node SDK",
              href: "https://docs.agent-assembly.com/node-sdk/",
            },
            {
              label: "Go SDK",
              href: "https://docs.agent-assembly.com/go-sdk/",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Agent Assembly contributors. Licensed under Apache 2.0. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
