User Stories

- Auth via OAuth: As a semi-technical user, I can run `gdocs-markdown-sync --auth` to authorize access to my Drive so the CLI can read/write documents in a folder I choose.
- Push new Doc: As a user, I can run `gdocs-markdown-sync push file.md --drive-folder <id>` to create a Google Doc in the target folder and have the tool record the `docId` in the file's YAML front matter.
- Push update: As a user, I can modify `file.md` and push again to update the linked Doc using the stored `docId` and `revisionId` checks.
- Pull update: As a user, I can run `gdocs-markdown-sync pull --local-dir ./docs --drive-folder <id>` to export Docs to Markdown and update existing files by matching front matter or file names where unmapped.
- Directory sync: As a user, I can sync a whole directory recursively, preserving subfolders.
- Conflict handling: As a user, I can select `--conflicts prefer-doc|prefer-md|merge` to resolve concurrent changes predictably.
- Dry run: As a user, I can add `--dry-run` to preview changes without modifying Docs or files.
- Watch mode: As a user, I can run `gdocs-markdown-sync sync --poll-interval 5s` to keep Docs and Markdown in sync continuously.

Profiles & Safety

- Profiles: As a user with multiple Google accounts, I can pass `--profile work` to keep tokens separate per profile.
- First run: As a cautious user, I can run with `--dry-run` to review planned creates/updates before applying changes.

Acceptance Criteria Notes

- Front matter fields: `docId`, `revisionId`, `sha256` keys exist after first push/pull
- Idempotency: repeated push/pull without changes results in no-ops
- Clear exit codes: non-zero on errors or unresolved conflicts
