Technical Architecture

Overview

- Single TypeScript codebase powering a Node.js CLI and an Obsidian plugin.
- Shared building blocks for Drive/Docs API access, OAuth, front matter, and hashing.

Components

- CLI (`src/cli.ts`): Implements `auth`, `pull`, `push`, `sync` commands.
  - Auth: PKCE OAuth via `PKCEOAuthManager` → saves tokens to `~/.config/gdocs-markdown-sync/tokens-<profile>.json`.
  - Pull: Lists Docs in Drive folder → exports Markdown → writes files with YAML front matter.
  - Push: Reads Markdown files → parses front matter → creates/updates Docs → refreshes front matter.
  - Sync: Pull then push; optional polling with `--watch` and `--poll-interval`.

- Obsidian Plugin (`src/main.ts`):
  - UI: Settings tab (`src/settings.ts`) with Drive Folder ID, base vault folder, conflict policy, poll interval, and OAuth fields.
  - Auth: Standard OAuth flow via `OAuthManager` and token handling via `AuthManager`/`TokenLoader`.
  - Commands: Sync, Pull, Push, and Start Auth Flow exposed in Command Palette.
  - Polling: Background sync on interval if enabled.

- Drive Client (`src/drive/client.ts`):
  - `listDocsInFolder(folderId)` → Doc metadata (id, name, headRevisionId, etc.)
  - `exportDocMarkdown(fileId)` → Markdown string
  - `uploadMarkdownAsDoc(name, content, parentId?)` → creates Doc from Markdown
  - `updateDocMarkdown(fileId, content)` → updates Doc content
  - `getFile(fileId)` → fetches file with `headRevisionId`
  - `setAppProperties(fileId, props)` / `getAppProperties(fileId)`
  - `createFolder(...)`, `listFoldersInFolder(...)`, `deleteFile(fileId)` (supporting ops)

- Auth
  - CLI: `src/auth/PKCEOAuthManager.ts` implements PKCE (no client secret). Uses a default public client ID (overridable via `GOOGLE_OAUTH_CLIENT_ID`).
  - Plugin: `src/auth/OAuthManager.ts` supports client ID/secret supplied via settings or env. Tokens handled by `src/auth/TokenLoader.ts`.

- Front Matter & Hashing (`src/fs/frontmatter.ts`)
  - YAML front matter using `gray-matter` with keys: `docId`, `revisionId`, `sha256`. Unknown keys preserved and round-tripped.
  - SHA-256 hashing: Node crypto for CLI/tests; Web Crypto for browser/Obsidian.

CLI Surface

- Commands: `auth`, `pull`, `push`, `sync`.
- Flags:
  - `--drive-folder-id` (env `DRIVE_FOLDER_ID`)
  - `--local-dir` (env `LOCAL_DIR`)
  - `--watch`, `--poll-interval <seconds>`
  - `--conflicts prefer-doc|prefer-md|merge` (parsed; merge path exists but is not fully implemented)

State & Conflict Handling

- State is stored both in front matter (local) and Drive appProperties (remote) to support 3‑way merge designs.
- Current policy hook exists in CLI and plugin; `prefer-doc`/`prefer-md` are meaningful defaults; `merge` returns conflict markers placeholder pending full implementation.

Security

- Minimal scopes: Drive/Docs read/write only.
- Tokens stored locally in `~/.config/gdocs-markdown-sync/` (profile-aware). Do not commit tokens.

Packaging & Installation

- CLI: run via `npm run cli` or link globally with `npm link` (exposes `gdocs-markdown-sync`).
- Obsidian Plugin: build TS, then copy `manifest.json` and `src/main.js` to the plugin folder inside the vault.

Testing

- Bun's built-in test runner for unit/integration tests. Integration tests require prior auth (use `npm run cli auth` or `npm run auth:pkce`).

Notable Limitations

- Round-tripping of complex Docs constructs (comments, suggestions, drawings) is lossy.
- Merge policy is experimental; conflict handling is conservative by default.
