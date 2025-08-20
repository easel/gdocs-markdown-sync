# Agent Guidelines

This repository implements a TypeScript CLI and an Obsidian plugin for synchronizing Google Docs with local Markdown. Keep changes minimal, tested, and clearly justified.

## Project Structure

- `src/cli.ts`: CLI entrypoint (compiled to `src/cli.js`, exposed as `gdocs-markdown-sync`).
- `src/main.ts`: Obsidian plugin entrypoint.
- `src/drive/*`: Drive/Docs API client and appProperties helpers.
- `src/fs/*`: front matter parsing/building and hashing.
- `src/auth/*`: OAuth (PKCE for CLI; standard OAuth for plugin).
- `scripts/auth-pkce.js`: helper to pre-seed tokens for tests.

## Build, Test, and Run

- `bun install` then `bun run build` to compile TS.
- CLI:
  - Dev: `bun run cli -- <command> [flags]`
  - Global (optional): `bun link` then `gdocs-markdown-sync <command> [flags]`
- Plugin: build with `bun run build`, then copy `manifest.json` and `dist/main.js` into your vault’s `.obsidian/plugins/google-docs-sync/`.
- Tests: `bun test`; integration tests: `bun run test:integration` after auth.

## Coding Style & Conventions

- TypeScript 5+, Bun runtime.
- Prefer small, focused modules; avoid stuttered names (e.g., `sync.Manager`, not `sync.SyncManager`).
- Errors: throw Error with clear message; include cause where helpful.
- Avoid side effects in library code; keep CLI I/O in `src/cli.ts`.

## CLI Interface

- Commands: `auth`, `pull`, `push`, `sync`.
- Flags:
  - `--drive-folder-id` (env: `DRIVE_FOLDER_ID`)
  - `--local-dir` (env: `LOCAL_DIR`)
  - `--watch`, `--poll-interval <seconds>`
  - `--conflicts prefer-doc|prefer-md|merge` (parsed; merge is experimental)

## Security

- Tokens saved to `~/.config/gdocs-markdown-sync/tokens-<profile>.json`.
- Minimal scopes: Drive/Docs read/write; do not log secrets.

## Architecture Summary

- Export Docs→Markdown and import Markdown→Docs.
- Preserve state with YAML front matter (docId, revisionId, sha256) and Drive `appProperties`.
- Poll for changes; conflict policy hook present in CLI and plugin (merge WIP).
