// GENERATED FILE -- do not hand-edit.
// Regenerate with: node scripts/generate-retraction-map.mjs
// AAASM-5676 / AAASM-5689. See that script for what this maps and why.

export interface RetractionNotice {
  notice: string;
  canonical: string;
}

// version -> pagePath (relative to that version's docs root) -> retraction ids.
// Full page precision, for humans auditing which pages are affected. The
// runtime banner does NOT read this -- see retractionsByVersion below.
export const retractionMap: Record<string, Record<string, string[]>> = {
  "0.0.1-alpha.8.1": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-alpha.9": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-alpha.9.1": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-beta.1": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-beta.2": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-beta.3": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-beta.4": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-beta.5": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-rc.1": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-rc.2": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-rc.3": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-rc.4": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-rc.5": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "0.0.1-rc.6": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "v0.0.1-alpha.4": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "v0.0.1-alpha.6": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "v0.0.1-alpha.7": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  },
  "v0.0.1-alpha.8": {
    "04-guides/index.md": [
      "AAASM-5528-activation-claim"
    ]
  }
};

// version -> retraction ids present anywhere in that version. What
// retractionBanner.ts actually reads at runtime -- see this script's module
// docstring for why page-level precision isn't used client-side.
export const retractionsByVersion: Record<string, string[]> = {
  "0.0.1-alpha.8.1": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-alpha.9": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-alpha.9.1": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-beta.1": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-beta.2": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-beta.3": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-beta.4": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-beta.5": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-rc.1": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-rc.2": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-rc.3": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-rc.4": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-rc.5": [
    "AAASM-5528-activation-claim"
  ],
  "0.0.1-rc.6": [
    "AAASM-5528-activation-claim"
  ],
  "v0.0.1-alpha.4": [
    "AAASM-5528-activation-claim"
  ],
  "v0.0.1-alpha.6": [
    "AAASM-5528-activation-claim"
  ],
  "v0.0.1-alpha.7": [
    "AAASM-5528-activation-claim"
  ],
  "v0.0.1-alpha.8": [
    "AAASM-5528-activation-claim"
  ]
};

export const retractionNoticesById: Record<string, RetractionNotice> = {
  "AAASM-5528-activation-claim": {
    "notice": "This statement is factually incorrect and has been retracted: enabling an adapter alone does not activate governance -- in-process enforcement additionally needs a check-capable mode. See the corrected explanation for what activation actually requires.",
    "canonical": "https://docs.agent-assembly.com/node-sdk/next/guides#other-frameworks-experimental-auto-detected"
  }
};
