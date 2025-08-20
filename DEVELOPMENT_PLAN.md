# Development Plan

This plan tracks next steps for the TypeScript CLI and Obsidian plugin.

## 1) Stabilize Core Sync

- CLI: tighten error handling in `pull`/`push` and improve messages
- Name sanitization parity between CLI and plugin
- Ensure front matter round-trips additional keys consistently

## 2) Conflict Policy & Merge

- Implement meaningful merge logic (3‑way) using `revisionId` + `sha256`
- Provide clear conflict markers and exit codes for unresolved conflicts
- Document conflict behaviors across CLI and plugin

## 3) Auth UX

- CLI: confirm PKCE default client ID override via env works across OSes
- Plugin: improve settings validation for client ID/secret and profile
- Shared: better token expiry refresh logs

## 4) Polling & Performance

- CLI: refine `--watch`/`--poll-interval` (jitter, backoff on errors)
- Plugin: background sync guardrails (skip overlapping runs)
- Consider Drive changes API for lower-latency pulls

## 5) Packaging & Docs

- Obsidian: add packaging script that copies `src/main.js` + `manifest.json` to a `dist/` plugin folder
- CLI: document `npm link` and un-link; explore npm publish
- Consolidate user docs and examples for common workflows

## 6) Testing & CI

- Expand integration coverage for edge cases (empty docs, large docs)
- Mock Drive where possible; keep real API tests opt-in
- Add coverage reporting and threshold for critical paths

## Deferred / Nice-to-Have

- Image/asset pipeline (Docs→MD and MD→Docs)
- GitHub Action for Docs→MD export-only
- Rich diff for merges and review flows
- Prebuilt plugin zip and release automation
