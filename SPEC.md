Short answer: there’s no great off-the-shelf bidirectional MD↔︎Google Docs dir mirrorer rn. One-way is easy. Two-way is doable with a tiny service (Go is fine) using the Drive/Docs APIs—just mind conflicts + images.

What exists (and how far it gets)
	•	Native MD import/export in Docs (UI): Docs can open .md and download as .md. Useful signal that the backend supports Markdown now.  ￼ ￼
	•	Drive API now supports Markdown export: official export MIME list includes text/markdown for Google Docs. (This is the key enabler.)  ￼
	•	Confirmed programmatic MD↔︎Doc with Drive/API & Apps Script (samples for both directions).  ￼ ￼ ￼
	•	One-way pipelines:
	•	Google Docs → Markdown via add-on (Docs to Markdown / Pro). Good UX, no sync.  ￼ ￼
	•	Google Docs folder → GitHub MD via GH Action (scheduled/export-only).  ￼
	•	StackEdit works with Drive, but that’s MD↔︎Drive files, not Docs format.  ￼

Practical plan: build a tiny syncer (Go)

Core idea: treat Google Docs as the source of truth for “.gdoc” files in a Drive folder; mirror to a local MD tree; also watch local MD changes and import to Docs.

APIs & events
	•	Watch Drive folder using Changes API or poll files.list with q=''<folderId> in parents and mimeType="application/vnd.google-apps.document" and trashed=false' + pageToken. Export on changes.  ￼
	•	Export Docs → MD with files.export(fileId, 'text/markdown'). Write to dir/<sanitized-title>.md.  ￼
	•	Import MD → Docs by uploading markdown and asking Drive to convert to a Google Doc (Drive supports MD import; Apps Script samples show both ways). Implementation options:
	•	files.create (multipart) with metadata mimeType:"application/vnd.google-apps.document" and media part text/markdown.
	•	Or upload as text/markdown then “Open with Google Docs” via files.copy/export path. (Apps Script samples show direct convert.)  ￼ ￼

State & conflict handling
	•	Use Drive appProperties on the Doc to store: sourcePath, last synced mdSha256, and last synced Doc revisionId. On MD files, add YAML frontmatter with gdocId, gdocLink, and last revisionId. This lets you do 3-way merges instead of clobbering. (Docs “suggesting” & comments don’t round-trip—expect loss; decide policy.)
	•	Conflict policy:
	•	If both changed since last sync → run git-style 3-way merge on the MD; then re-import to Docs (accept you’ll lose comments/suggestions), or flag for manual resolution.

Images & embeds
	•	Docs→MD export: verify how images come through (inline links vs assets). If assets come as links, fetch them and rewrite paths; if a ZIP is required (like HTML export), you’ll need a small asset fetcher. (Official MD export exists but asset handling isn’t well-documented—test & adapt.)  ￼

Skeleton (Go)
	•	SDK: google.golang.org/api/drive/v3 (and optionally docs/v1 if you want fine-grained formatting).
	•	Local FS watch: fsnotify.
	•	Hashing: sha256 of MD content; store in appProperties + frontmatter.
	•	Map: gdocId ↔︎ mdPath via appProperties.sourcePath.
	•	Rate limits: batch with exponential backoff.

CLI UX sketch

gdoc-md-sync \
  --drive-folder <FOLDER_ID> \
  --local-dir ./docs \
  --include '**/*.md' \
  --poll-interval 5s \
  --conflicts {prefer-doc|prefer-md|merge}

If you don’t want to build:
	•	Docs → MD only: use Drive API export (cron) or the GH Action to push to your repo; that covers most “docs-as-code” workflows.  ￼ ￼
	•	MD → Docs only: run a job that uploads changed .md and converts them (Drive API + text/markdown). The Apps Script/Drive samples already show the conversion; wiring it to a folder listener is minimal glue.  ￼ ￼

Caveats (be real)
	•	Round-tripping is lossy: comments, suggestions, page styles, some tables/lists can degrade. Pandoc workarounds are worse than native MD export/import now, but still not perfect. Test on your nastiest docs before committing.  ￼ ￼
	•	Images/Drawings need extra handling in MD export. Plan an asset pipeline.  ￼

If you want, I’ll sketch the Go repo layout + the exact Drive API calls and a minimal working loop you can paste into a project.
