Gemini Agent Guide

Project Summary

- TypeScript repo providing a Node.js CLI (`src/cli.ts`) and an Obsidian plugin (`src/main.ts`) for Google Docs ↔ Markdown sync.

How to Run

- Install deps: `npm install`
- Build: `npm run build`
- CLI usage: `npm run cli -- auth|pull|push|sync [...flags]`
- Plugin: copy `manifest.json` + `src/main.js` into vault plugin folder

Testing

- Unit: `npm test`
- Integration: `npm run test:integration` (run CLI `auth` first)

Conventions

- Keep modules small; align with existing naming
- Document changes in README when affecting user flows
- Do not add Go-specific content; this is a TS-only project

Docs

- Start with `PRODUCT_PRD.md`, `TECHNICAL_ARCHITECTURE.md`, and `DEVELOPMENT_PLAN.md`
