# Office 365 (Microsoft 365) Backend — DOCX Roundtrip Plan

Status: Proposed (agreed at high level)
Owner: gdocs-markdown-sync maintainers
Scope: CLI and Obsidian plugin (shared core)

## Goals

- Add an additional push/pull backend targeting Microsoft 365 via Microsoft Graph.
- Support OneDrive and SharePoint (document libraries) as storage targets.
- Enable multiple remotes per note (coexist with Google backend).
- Provide bidirectional sync using a DOCX-based, lossy roundtrip with clear conflict handling.

Non-goals (initially)

- Perfect fidelity with complex Word features (tracked changes, comments, advanced tables/styles).
- Merging changes inside DOCX; “merge” policy applies only to pure Markdown remotes.
- Image extraction on pull (planned for Phase 2).

## High-level Strategy

- For push: Markdown → HTML (remark + GFM) → DOCX (html→docx) → upload to Graph.
- For pull: DOCX → HTML (mammoth) → Markdown (rehype-remark or turndown + remark).
- Normalize Markdown on both ends (stable-v1 rules) to reduce drift and make diffs stable.
- Use Graph `eTag` for concurrency and store canonical Markdown `sha256` in a Drive open extension for change detection.

### Stable-v1 Normalization Rules

- Headings: ATX `#..######` only; no IDs.
- Lists: `-` for bullets; ordered lists restart at 1; task lists rendered as plain text (`[ ]`, `[x]`).
- Emphasis: `**bold**`, `*italic*`; limit nesting depth.
- Code: fenced blocks with language; inline code uses backticks.
- Links/Images: inline-style only; escape special URL chars; no reference links.
- Tables: GFM simple tables; left alignment only; drop merged cells.
- HTML: strip or escape raw HTML.
- Whitespace: one blank line between blocks; trim trailing spaces.

## Targets

- OneDrive (user): `/me/drive/root:/path/to/file.docx:/content`.
- SharePoint library: `/sites/{siteId}/drives/{driveId}/root:/path/to/file.docx:/content`.
- Small uploads: `PUT .../content` with optional `If-Match` precondition.
- Large uploads: create an upload session and chunk.

## Auth

- CLI: OAuth 2.0 PKCE; scopes `Files.ReadWrite.All` and `offline_access`.
- SharePoint libraries: add `Sites.ReadWrite.All` for cross-site reliability.
- Plugin: standard OAuth, mirroring existing Google flow.
- Token storage: reuse `~/.config/gdocs-markdown-sync/tokens-<profile>.json`, keys prefixed with `o365:`.

## Front Matter and Metadata

- Local front matter gains a `remotes: []` array (backwards-compatible with existing Google fields).
- Each remote entry:
  - `backend: "o365" | "google"`
  - `kind?: "docx" | "md"` (for o365; default `docx` in this plan)
  - `driveRef?: { scope: "me" | "site"; siteId?: string; driveId?: string; path: string }`
  - `itemId?: string`
  - `etag?: string`
  - `sha256?: string` (canonical Markdown hash)
- Remote metadata on `driveItem` via Graph Open Extensions:
  - `{ tool: "gdocs-markdown-sync", backend: "o365", kind: "docx", canonical: "stable-v1", sha256, toolVersion }`.
- Fallback if extensions blocked: sidecar file `.<name>.sync.json` stored alongside the DOCX.

## CLI and Plugin Changes

- Global flag: `--backend google|o365` (default remains `google`).
- O365 targeting:
  - OneDrive: `--o365-path "/Folder/Sub/file.docx"`
  - SharePoint: `--o365-site <siteId> --o365-drive <driveId> --o365-path "/Library/Sub/file.docx"`
- Format selection: `--o365-kind docx|md` (default `docx` for `--backend o365`).
- Commands: `auth --backend o365`, `push|pull|sync --backend o365 [o365 flags]`.
- Multiple remotes:
  - `sync` operates on selected backend or (optionally) all remotes; conflict prompts when needed.

## Conflict Handling

- Policies: `prefer-md`, `prefer-doc`, `merge`.
- DOCX (o365):
  - `prefer-md`: overwrite remote regardless of `eTag`; update `sha256` and extension.
  - `prefer-doc`: require `If-Match`; abort on mismatch and surface guidance.
  - `merge`: not supported for DOCX initially; user must resolve manually.

## Modules to Add

- `src/msgraph/client.ts`: Graph HTTP client (auth header, retries, 429/5xx backoff).
- `src/msgraph/drive.ts`: path resolution, item get/create/update, open extension CRUD.
- `src/convert/docx.ts`:
  - `mdToDocx(input, opts) → Uint8Array` (remark → HTML → html→docx)
  - `docxToMd(bytes, opts) → string` (mammoth → HTML → remark)
  - Applies stable-v1 normalization in both directions.
- `src/push/o365.ts` and `src/pull/o365.ts`: orchestrate conversion, upload/download, metadata, conflicts.
- `src/auth/o365.ts`: PKCE flow and token persistence keyed as `o365:<profile>`.
- `src/cli.ts`: route `auth/push/pull/sync` for `--backend o365` and parse new flags.

## Testing Plan

- Converters: snapshot tests for H1–H3, paragraphs, bold/italic/code (inline & block), lists, links, simple tables; prove idempotence under stable-v1.
- Graph ops (mocked): path resolution (me vs site/drive), uploads with `If-Match`, handle 409/412, open extension read/write; upload-session happy path.
- CLI: flag matrix parsing; defaults; conflict policy mapping.
- Integration (manual):
  - OneDrive and SharePoint document library end-to-end: push → web edit in Word → pull.

## Rollout / Milestones

1. Milestone 1 — Core DOCX sync
   - PKCE auth, OneDrive + SharePoint uploads, eTag checks, open extension metadata, multiple remotes in front matter.
2. Milestone 2 — Images & robustness
   - Extract embedded images on pull to `assets/<note-id>/img-<n>.<ext>` and rewrite Markdown; large-upload sessions; more drift guards.
3. Milestone 3 — Plugin settings/UI
   - Add O365 backend settings and per-note remote management in the Obsidian plugin.

## Open Choices

- SharePoint discovery: accept `siteId/driveId` initially; add hostname+path discovery later.
- Default behavior for `sync` with multiple remotes: operate all vs. backend-filtered (introduce `--all-remotes`?).
- Converter libraries: validate/lock versions for deterministic output across platforms.

## Security Considerations

- Least privilege scopes (`Files.ReadWrite.All`, `Sites.ReadWrite.All`, `offline_access`).
- Never log secrets or Authorization headers; redact tokens in debug.
- Support single-tenant client IDs and document admin consent needs.

## Acceptance Criteria (Phase 1)

- `bun run cli -- auth --backend o365` stores tokens.
- `bun run cli -- push --backend o365 --o365-path "/…/note.docx"` uploads DOCX with extension metadata.
- Web edit in Word increments `eTag`; `pull` detects and converts back to normalized Markdown.
- Front matter `remotes[]` updated with `itemId`, new `etag`, and `sha256`.
