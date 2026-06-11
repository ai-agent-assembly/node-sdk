import {themes as prismThemes} from "prism-react-renderer";
import type {Config} from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// Channel-based version metadata (AAASM-2751). `lastVersion` (the default
// landing) and the per-version `label`/`path`/`banner` entries are regenerated
// by the release workflow (scripts/version-channels.mjs) each time a snapshot
// is cut, so they live in data, not inline. See ../docs/releasing.md.
import versionChannels from "./versionChannels.json";

const config: Config = {
  title: "@agent-assembly/sdk",
  tagline: "TypeScript and Node.js SDK for Agent Assembly",
  favicon: "img/favicon.png",

  future: {
    v4: true,
  },

  url: "https://ai-agent-assembly.github.io",
  baseUrl: "/node-sdk/",

  organizationName: "ai-agent-assembly",
  projectName: "node-sdk",

  onBrokenLinks: "throw",

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  themes: ["@docusaurus/theme-mermaid"],

  plugins: [
    [
      "docusaurus-plugin-typedoc",
      {
        entryPoints: ["../src/index.ts"],
        tsconfig: "../tsconfig.build.json",
        out: "../docs/api",
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
          editUrl: "https://github.com/ai-agent-assembly/node-sdk/tree/master/",
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
              href: "https://ai-agent-assembly.github.io/agent-assembly-docs/",
            },
            {
              label: "Python SDK",
              href: "https://ai-agent-assembly.github.io/python-sdk/",
            },
            {
              label: "Node SDK",
              href: "https://ai-agent-assembly.github.io/node-sdk/",
            },
            {
              label: "Go SDK",
              href: "https://ai-agent-assembly.github.io/go-sdk/",
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
              href: "https://ai-agent-assembly.github.io/agent-assembly-docs/",
            },
            {
              label: "Python SDK",
              href: "https://ai-agent-assembly.github.io/python-sdk/",
            },
            {
              label: "Node SDK",
              href: "https://ai-agent-assembly.github.io/node-sdk/",
            },
            {
              label: "Go SDK",
              href: "https://ai-agent-assembly.github.io/go-sdk/",
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
