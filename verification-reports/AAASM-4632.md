# Verification — AAASM-4632 (node-sdk docs: editUrl missing `website/` segment)

**PR:** https://github.com/ai-agent-assembly/node-sdk/pull/282
**Branch:** `v0.0.1/AAASM-4632/fix/editurl_website_segment`

## Bug

Every doc page's generated "Edit this page" footer link 404'd because
`website/docusaurus.config.ts`'s `editUrl` pointed at the bare repo root
instead of the `website/` subdirectory the Docusaurus site's docs source
actually lives under. Fix: append `website/` to the `editUrl` base.

## Method

Installed and started the Docusaurus dev server for this worktree in
isolation (`cd website && pnpm install --ignore-workspace && pnpm start
--port 3132`, using Node 24 per the repo's `engines.node >=22` requirement),
then drove it with Playwright MCP.

## Validation performed

1. Navigated to `http://localhost:3132/node-sdk/` (Introduction page).
2. Found the "Edit this page" footer link and confirmed its rendered `href`
   now includes the `website/` segment:
   `https://github.com/ai-agent-assembly/node-sdk/tree/master/website/versioned_docs/version-0.0.1-rc.4/01-introduction/index.md`
   (`node-sdk-edit-this-page-link-after-fix.png`).
3. Clicked it — opened a new tab that landed on the real GitHub file view of
   that exact markdown source, rendering the same "Introduction" content
   shown on the docs page (`node-sdk-edit-link-target-github-after-fix.png`).
4. For contrast, navigated directly to the pre-fix (bare-root, no `website/`)
   form of the same URL and confirmed it is genuinely a GitHub 404 ("File not
   found · GitHub") — `node-sdk-edit-link-old-path-404-before-fix-reference.png`.
   This confirms the bug was real and the fix's target is a materially
   different, correct destination.

## Result

"Edit this page" click → real GitHub source file, matching the rendered doc.
No console errors introduced by the change itself. Confirmed working
end-to-end in a real browser, not just a static href check.
