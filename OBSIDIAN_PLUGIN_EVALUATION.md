Obsidian Plugin Evaluation

Scope

- Evaluate the current Obsidian plugin implementation against the repository’s product/docs: README.md, PRODUCT_PRD.md, TECHNICAL_ARCHITECTURE.md, USER_STORIES.md, and DEVELOPMENT_PLAN.md.
- Identify completeness, gaps, and suggest next steps.

Summary
The repository contains a fairly complete TypeScript Obsidian plugin scaffold alongside a CLI. The plugin entry point (src/main.ts) implements:

- Settings UI (src/settings.ts) for: Drive Folder ID, Base Vault Folder, Conflict Policy, Poll Interval, OAuth (Client ID/Secret, Profile) with an Auth button.
- OAuth/auth token handling via AuthManager (src/drive/auth.ts) and OAuthManager (src/auth/OAuthManager.ts) + TokenLoader (profile-aware token storage).
- Drive client (src/drive/client.ts) with real Google APIs for listing/exporting/updating/uploading Docs and appProperties.
- Core flows: pull (Docs → MD) and push (MD → Docs) including front matter parse/build, SHA256, revisionId refresh, property round-trip via appProperties, and basic file naming sanitization.
- Commands: Sync, Pull, Push, and Start Auth Flow.
- Background polling with interval scheduling and reentrancy guard (isSyncing flag).

Overall completeness vs docs

- Product PRD / User stories alignment:
  - OAuth: Implemented (standard OAuth; PKCE is used on CLI side). Uses local express callback + system browser open. Tokens are stored under ~/.config/gdocs-markdown-sync/ and are profile-aware. ✓
  - Pull/Push directory sync: Implemented for entire vault or constrained to Base Vault Folder. ✓
  - Front matter keys (docId, revisionId, sha256) populated and round-tripped; unknown keys preserved under other and saved to Drive appProperties. ✓
  - Conflict policies: Hooks exist (prefer-doc, prefer-md, merge) but logic is placeholder; merge returns conflict markers stub. Partial.
  - Watch/polling: Implemented via interval-based background sync (pollInterval). ✓
  - Dry run: Not present in plugin (CLI user story includes it; plugin does not expose dry-run). Missing.
  - Errors/UX: Notices and console logs exist, but limited validation and user guidance. Partial.

Technical details and risks

- OAuth in Obsidian: OAuthManager starts a local express server on an ephemeral port and attempts to open a system browser. This can work on desktop, but:
  - Obsidian’s environment and sandbox permissions vary; some systems may block port binding or child_process open. Fallback UX is a printed URL but no in-app webview or link. Consider an in-app modal with a clickable link and pin code flow or using Obsidian’s openExternal.
  - Token refresh implemented; errors lead to re-auth requirement. Reasonable for v0.
- Build/packaging inconsistency:
  - package.json builds to dist/ (bun build src/main.ts --outdir ./dist) and includes build:plugin copying manifest.json/styles.css to dist/.
  - README and CRUSH mention copying src/main.js to the plugin folder, while AGENTS.md recommends copying dist/main.js. The repo already contains a compiled src/main.js (checked in), which can cause confusion.
  - Suggest standardizing on dist/ as the output for plugin packaging and updating docs accordingly, or remove dist usage and consistently reference src/main.js if you intend to commit build artifacts (not recommended).
- Missing fs helpers folder mentioned in docs (src/fs/\*). There is src/fs/frontmatter.ts used for tests, while plugin re-implements parsing/building inline. Consider consolidating.
- Tests: A number of unit and integration tests exist, with test mocks for Obsidian. Not all plugin paths are covered (e.g., settings validation, polling guardrails, Drive failures). Integration tests rely on prior auth.

Gaps and recommended next steps (prioritized)

1. Packaging and Docs cleanup

- Choose a single packaging target for the plugin (dist/main.js). Update README and CRUSH to instruct copying dist/main.js instead of src/main.js. Update build:plugin script to ensure manifest.json and styles.css are placed alongside dist/main.js. Optionally add a package script: npm run package:plugin that produces a ready-to-install folder (dist/plugin/ or dist/google-docs-sync/).
- Remove committed build artifacts (src/main.js) if present, and add appropriate .gitignore to avoid future confusion. Alternatively, clearly mark src/main.js as generated and unify instructions.

2. Conflict policy implementation

- Implement meaningful prefer-doc and prefer-md behaviors in processPushOperation/processPullOperation or a dedicated conflict module. At minimum:
  - When revisionId mismatch is detected, fetch remote/export MD and compare hashes; apply policy to select source of truth and update the other.
  - For merge, implement a simple 3-way merge using revisionId as base and produce conflict markers with sections, surfacing a notice and possibly opening the file.
- Add tests around conflict scenarios.

3. Auth UX improvements for Obsidian

- Wrap browser open with Obsidian’s openExternal or provide a clickable URL in a modal.
- Improve error surfaces during OAuth and token refresh. Consider a “Re-authenticate” notice/action when token refresh fails.
- Validate Client ID/Secret/Profile fields in settings (disable Start Auth Flow if invalid).

4. Background sync guardrails

- Debounce/suppress overlapping runs more rigorously: track last run time, skip if a run is already scheduled and in progress, add backoff on Drive errors.
- Add a toggle to enable/disable background polling in settings (e.g., pollInterval = 0 to disable, but make it explicit and discoverable).

5. Consolidate front matter utilities

- Use src/fs/frontmatter.ts in the plugin instead of re-implementing parse/build to ensure consistent behavior with CLI/tests. This also centralizes SHA256 logic to pick Web Crypto within Obsidian.

6. Feature parity with CLI user stories in Plugin

- Add “Dry run” mode for Push/Pull/Sync in plugin (checkbox in settings or temporary command palette variants) to preview actions without mutations.
- Provide directory-level sync previews and small summaries in notices (created/updated/skipped/conflicted counts).

7. Testing and CI

- Extend unit tests to cover settings changes, polling scheduling, and DriveClient error paths.
- Add e2e tests (with Obsidian mocked) for basic pull/push flows and conflict policy selection.
- Keep integration tests opt-in, with instructions to pre-auth using CLI.

8. Security and permissions

- Verify minimal Drive scopes are used. Evaluate risk around storing Client Secret in settings; recommend relying on PKCE in plugin as well if feasible, to avoid secrets.

Quick actionable tasks

- Update docs: README.md and CRUSH.md to consistently reference dist/main.js (or standardize on dist/ and remove src/main.js build artifact). Add a dedicated “Packaging the Obsidian plugin” section with a one-liner npm run build:plugin and copy step.
- Wire the plugin to use src/fs/frontmatter.ts helpers to avoid divergence.
- Add settings validation and disable Start Auth when required fields are missing.
- Add a settings toggle "Enable background sync" (maps to pollInterval>0) and ensure stopPolling() is called when disabled.

Status conclusion

- The Obsidian plugin is a solid v0 scaffold with real Drive integration. It is usable for simple pull/push if auth works in the user’s environment. The biggest gaps are conflict resolution (beyond stubs), packaging/doc consistency, and auth UX robustness within Obsidian. Addressing these will bring it much closer to a reliable day-to-day tool.
