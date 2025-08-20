Contributing

Thanks for helping improve gdocs-markdown-sync! This project is a TypeScript codebase that provides both a CLI and an Obsidian plugin to sync Google Docs with Markdown. Please keep changes minimal, well-tested, and clearly justified.

Development Setup

- Requirements: Bun (install with `brew install oven-sh/bun/bun` for macOS/Linux)
- Install deps: `bun install`
- Build: `bun run build`
- Run CLI locally: `bun run cli -- <cmd> [flags]`
- Link CLI globally (optional): `bun link` then `gdocs-markdown-sync <cmd>`
- Run tests: `bun test` (unit), `bun run test:integration` (after auth)

Coding Style

- TypeScript 5+; prefer small, focused modules
- Follow existing style; run formatter if configured by your editor
- Errors: throw with clear messages; include cause where helpful
- Tests: write Bun tests (table-driven pattern encouraged); target high coverage for critical paths

Commit/PR Guidelines

- Commit messages: imperative scope style, e.g., `cli: add pull progress` or `drive: retry 429`
- PRs: describe purpose, link issues, and note any behavior changes (conflict policy, flags, token storage)

Security

- Never commit secrets or tokens
- Use minimal scopes; avoid logging sensitive values
- CLI tokens are stored under `~/.config/gdocs-markdown-sync/`

Where to Start

- Product: see `PRODUCT_PRD.md`
- Architecture: see `TECHNICAL_ARCHITECTURE.md`
- Dev plan and milestones: see `DEVELOPMENT_PLAN.md`
