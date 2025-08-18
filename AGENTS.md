# Repository Guidelines

This repository implements a small Go CLI that synchronizes Google Docs and local Markdown, guided by SPEC.md. Keep changes minimal, tested, and clearly justified.

## Project Structure & Module Organization
- Expected layout:
  - `/cmd/gdocs-markdown-sync`: CLI entrypoint.
  - `/internal/drive`: Drive/Docs API access, appProperties helpers.
  - `/internal/sync`: change detection, 3‑way merge, conflict policy.
  - `/internal/fs`: file watching, front matter, hashing.
  - `/docs`: local mirror of Google Docs (Markdown).
  - `/testdata`: fixtures for API and import/export flows.
- Reference behavior and edge cases in `SPEC.md`.

## Build, Test, and Development Commands
- `go mod tidy`: ensure/go resolve modules (when `go.mod` exists).
- `go build ./cmd/gdocs-markdown-sync`: build the CLI.
- `go run ./cmd/gdocs-markdown-sync --poll-interval 5s`: run from source.
- `go test ./...`: run unit tests; `go test -cover ./...` for coverage.
- Example run with env:
  `GOOGLE_APPLICATION_CREDENTIALS=key.json DRIVE_FOLDER_ID=abc LOCAL_DIR=./docs go run ./cmd/gdocs-markdown-sync`.

## Coding Style & Naming Conventions
- Go 1.21+; format with `go fmt ./...` and check with `go vet ./...` before pushing.
- Packages: short, lower-case; avoid stutter (e.g., `sync.Manager`, not `sync.SyncManager`).
- Errors: wrap with `%w`; return sentinel errors from packages; no panics in library code.
- Filenames: `snake_case_test.go` for tests; OS/arch suffixes when required.

## Testing Guidelines
- Use standard `testing` with table-driven tests.
- Put file/HTTP fixtures under `/testdata` and keep them small.
- Name tests `TestXxx`; add `ExampleXxx` for public APIs.
- Target >80% coverage in `/internal/*` critical paths.

## Commit & Pull Request Guidelines
- Commits: imperative scope style, e.g., `sync: handle image assets` or `drive: retry on 429`.
- PRs: include purpose, linked issue, and before/after when behavior changes.
- Note changes to conflict policy, on-disk layout, or flags in the PR description.

## Security & Configuration Tips
- Credentials: use `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON); never commit secrets.
- Minimize OAuth scopes to required Drive/Docs read/write.
- Common env/flags: `DRIVE_FOLDER_ID`, `LOCAL_DIR`, `--conflicts prefer-doc|prefer-md|merge`.

## Architecture Overview
- Two watchers: Drive changes (poll/changes API) and local FS.
- Sync loop: export Docs→MD, import MD→Docs, store `revisionId`/`sha256` in appProperties/front matter for 3‑way merges.
