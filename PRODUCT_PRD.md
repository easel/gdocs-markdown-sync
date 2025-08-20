Product Requirements: gdocs-markdown-sync

Overview

- Purpose: Simple, reliable sync between Google Docs and Markdown for both terminal users (CLI) and Obsidian users (plugin), preserving associations via YAML front matter.
- Audience: PMs, tech writers, engineers who prefer Markdown but collaborate in Docs.
- Outcomes: Faster iteration, reproducibility, and docs-as-code workflows without bespoke scripts.

Problem Statement

- Teams write in Markdown while stakeholders collaborate in Google Docs; keeping both in sync is manual and error-prone.

Goals

- Easy auth: PKCE OAuth (no client secret) for CLI; OAuth for plugin
- One-shot push/pull; bidirectional sync with change detection and conflict policy
- Preserve associations with YAML front matter (Obsidian-compatible) and Drive appProperties
- Safe operations with clear logging and test coverage

Non-Goals

- Full-fidelity round-tripping of all Docs features (comments, suggestions, complex layouts)
- Hosted service; this is local tooling

Personas

- Semi-technical contributor: uses CLI with a few flags
- Obsidian user: clicks commands and configures settings panel
- Maintainer/automation: runs CLI in scripts/cron

Key Use Cases

- Create Docs from Markdown, maintaining folder mapping
- Pull Docs to Markdown, preserving front matter
- Resolve conflicts via policy: prefer-doc, prefer-md; merge mode is experimental
- Continuous sync in editing sessions via polling

Functional Requirements

- CLI commands: `auth`, `pull`, `push`, `sync`
- Flags/env: `--drive-folder-id` (env `DRIVE_FOLDER_ID`), `--local-dir` (env `LOCAL_DIR`), `--watch`, `--poll-interval`, `--conflicts`
- Token storage: `~/.config/gdocs-markdown-sync/tokens-<profile>.json`
- Front matter keys: `docId`, `revisionId`, `sha256`; additional keys preserved
- Drive appProperties used to store custom metadata

Non-Functional Requirements

- Reliability: consistent mappings, no silent clobbering
- Security: minimal scopes; do not log secrets
- Portability: macOS, Linux, Windows

Success Metrics

- <5 min to first push/pull
- Majority of common Docs round-trip without manual fixups
- High coverage across core logic and commands

Release Criteria (v1.0)

- PKCE OAuth in CLI; plugin OAuth via settings
- One-shot push/pull; sync with polling
- Front matter/appProperties mapping
- Basic conflict policies present; merge hook available (documented as experimental)
- Unit + integration tests for happy paths and common errors

Future

- Robust 3‑way merge and diff UX
- Drive changes API + local FS watch integration for lower latency
- Asset handling (images) strategy
- Prebuilt plugin packaging and CLI distribution docs

Assumptions

- Users can access the target Drive folder; plugin users enable community plugins
- Markdown dialect: CommonMark with YAML front matter

Risks

- Round-trip fidelity gaps; set expectations clearly in docs
- OAuth flow differences across OS/es and environments
