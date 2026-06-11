import {themes as prismThemes} from "prism-react-renderer";
import type {Config} from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

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
          // Documentation versioning (AAASM-2751).
          //
          // The in-progress docs under `../docs` are the `current` version and
          // track `master`. Until the first release snapshot is cut, `current`
          // is the only version; it is labelled "Next" and served at the site
          // root so the version dropdown renders and links resolve.
          //
          // At the v0.1.0 release, run `pnpm docusaurus docs:version v0.1.0`
          // (see ../docs/releasing.md). That freezes today's docs into
          // `website/versioned_docs/version-v0.1.0`, after which `v0.1.0`
          // becomes the default "latest" version and `current` keeps tracking
          // master under the "Next" label. Do NOT cut a snapshot before then.
          versions: {
            current: {
              label: "Next",
              path: "/",
            },
          },
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
