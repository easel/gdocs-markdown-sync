Claude Agent Guide

Context

- Codebase: TypeScript (Bun CLI + Obsidian plugin)
- Primary tasks: docs edits, TypeScript changes, tests, and small build script tweaks

Key Commands

- Install: `bun install`
- Build: `bun run build`
- CLI: `bun run cli -- <cmd> [flags]` or `bun link` then `gdocs-markdown-sync <cmd>`
- Tests: `bun test`, `bun run test:integration` (requires auth)
- CI checks: `bun run check` (runs typecheck, lint, tests, format check)

Auth

- CLI uses PKCE; run `bun run cli auth` to generate tokens under `~/.config/gdocs-markdown-sync/`

Editing Rules

- Keep changes minimal and scoped
- Avoid introducing Go references or non-TS artifacts
- Update docs alongside behavior changes
- **ALWAYS run `bun run check` after any code changes to ensure CI passes**
- Auto-fix formatting: `bun run format` (required for CI)
- Fix linting: `bun run lint:fix` (check import order, unused vars, etc.)

References

- Product: `PRODUCT_PRD.md`
- Architecture: `TECHNICAL_ARCHITECTURE.md`
- Dev plan: `DEVELOPMENT_PLAN.md`
