# CRUSH.md

Agent quick-reference for this TypeScript repo.

## Build, Test, and Run

- Install deps: `bun install`
- Build all: `bun run build`
- Run CLI: `bun run cli -- <cmd> [flags]`
- Link CLI globally (optional): `bun link` then `gdocs-markdown-sync <cmd>`
- Build plugin: `bun run build:plugin`, then copy `manifest.json` + `dist/main.js` to vault plugin folder
- Tests: `bun test`; integration: `bun run test:integration` (requires auth)

## Style & Quality

- TypeScript 5+, Node 18+
- Format via editorconfig/Prettier if configured; keep code consistent with surrounding style
- Keep modules small; avoid unnecessary abstractions
- Errors: throw with clear messages; wrap underlying messages using `cause` where helpful

## Scope & Constraints

- Do not introduce Go/other-language artifacts
- Avoid changing build scripts unless requested; prefer documenting accurate steps
- Keep changes minimal and focused; add tests when touching logic paths

## Common CLI Flags

- `--drive-folder-id` (env `DRIVE_FOLDER_ID`)
- `--local-dir` (env `LOCAL_DIR`)
- `--watch`, `--poll-interval <seconds>`
- `--conflicts prefer-doc|prefer-md|merge` (merge is experimental)
