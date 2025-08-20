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

Key Use Cases & User Stories

### Core Workflows
- Create Docs from Markdown, maintaining folder mapping
- Pull Docs to Markdown, preserving front matter
- Resolve conflicts via policy: prefer-doc, prefer-md; merge mode is experimental
- Continuous sync in editing sessions via polling

### CLI User Stories

**Authentication & Setup**
- As a semi-technical user, I can run `gdocs-markdown-sync auth` to authorize access to my Drive so the CLI can read/write documents in a folder I choose
- As a user with multiple Google accounts, I can pass `--profile work` to keep tokens separate per profile
- As a user, I can override the OAuth client ID via `GOOGLE_OAUTH_CLIENT_ID` environment variable for organizational use

**Document Operations**
- As a user, I can run `gdocs-markdown-sync push file.md --drive-folder <id>` to create a Google Doc in the target folder and have the tool record the `docId` in the file's YAML front matter
- As a user, I can modify `file.md` and push again to update the linked Doc using the stored `docId` and `revisionId` checks
- As a user, I can run `gdocs-markdown-sync pull --local-dir ./docs --drive-folder <id>` to export Docs to Markdown and update existing files by matching front matter or file names where unmapped

**Directory & Sync Operations**
- As a user, I can sync a whole directory recursively, preserving subfolders and maintaining folder structure in Drive
- As a user, I can run `gdocs-markdown-sync sync --poll-interval 30` to keep Docs and Markdown in sync continuously with configurable polling frequency
- As a user, I can use `--watch` mode for responsive sync during active editing sessions

**Safety & Control**
- As a user, I can select `--conflicts prefer-doc|prefer-md|merge` to resolve concurrent changes predictably
- As a user, I can add `--dry-run` to preview changes without modifying Docs or files, seeing exactly what operations would be performed
- As a user, I receive clear success/failure feedback with operation counts (created/updated/skipped/conflicted)
- As a user, I can rely on idempotent operations that safely handle repeated runs without unintended changes

**Error Handling & Recovery**
- As a user, I receive clear error messages with actionable guidance when operations fail
- As a user, I can rely on automatic retry logic for transient network failures without manual intervention
- As a user, I can trust that partial failures don't leave documents in inconsistent states

### Obsidian Plugin User Stories

**Plugin Setup & Configuration**
- As an Obsidian user, I can install the plugin and configure my Google Drive folder ID through a settings panel
- As an Obsidian user, I can set my base vault folder to limit sync scope to specific directories
- As an Obsidian user, I can configure OAuth credentials (Client ID/Secret) through plugin settings
- As an Obsidian user, I can choose conflict resolution policy through a dropdown in settings

**Authentication**
- As an Obsidian user, I can click "Start Auth Flow" in the Command Palette to authenticate with Google Drive
- As an Obsidian user, I can complete OAuth in my default browser and return to Obsidian seamlessly
- As an Obsidian user, I receive clear feedback when authentication succeeds or fails

**Sync Operations**
- As an Obsidian user, I can run "Sync with Google Docs" from the Command Palette for manual bidirectional sync
- As an Obsidian user, I can run "Pull from Google Docs" to import changes from Drive to my vault
- As an Obsidian user, I can run "Push to Google Docs" to upload vault changes to Drive
- As an Obsidian user, I can enable background polling to keep my vault automatically synced

**User Experience**
- As an Obsidian user, I receive non-intrusive notices about sync progress and completion
- As an Obsidian user, I can see operation summaries with counts of created/updated/skipped documents
- As an Obsidian user, I can rely on background sync that doesn't interfere with my writing workflow
- As an Obsidian user, I can trust that the plugin respects my conflict resolution preferences

### Acceptance Criteria
- **Front matter preservation**: `docId`, `revisionId`, `sha256` keys exist after first push/pull
- **Idempotency**: Repeated push/pull without changes results in no-ops
- **Clear exit codes**: Non-zero on errors or unresolved conflicts
- **State consistency**: Document associations maintained across operations

## Detailed Interface Specifications

### CLI Interface
- **Commands**: `auth`, `pull`, `push`, `sync`
- **Global Flags**: 
  - `--drive-folder-id <id>` (env: `DRIVE_FOLDER_ID`): Google Drive folder to sync
  - `--local-dir <path>` (env: `LOCAL_DIR`): Local directory for Markdown files  
  - `--profile <name>`: Token profile for multi-account support (default: "default")
  - `--conflicts <policy>`: Conflict resolution - `prefer-doc|prefer-md|merge`
  - `--dry-run`: Preview mode - show operations without executing
- **Sync-specific Flags**:
  - `--watch`: Enable continuous sync with file system monitoring
  - `--poll-interval <seconds>`: Polling frequency for sync operations (default: 60)
- **Output**: Structured operation summaries with counts and clear success/failure indication
- **Exit Codes**: 0 for success, non-zero for errors or unresolved conflicts

### Obsidian Plugin Interface
- **Settings Panel**:
  - Google Drive Folder ID (text input with validation)
  - Base Vault Folder (folder picker, defaults to vault root)  
  - Conflict Resolution Policy (dropdown: prefer-doc/prefer-md/merge)
  - Background Sync Settings (enable/disable toggle, poll interval slider)
  - OAuth Configuration (Client ID/Secret inputs with validation)
  - Authentication Status (connected/disconnected with re-auth button)
- **Command Palette Commands**:
  - "Google Docs Sync: Authenticate" (start OAuth flow)
  - "Google Docs Sync: Sync All" (bidirectional sync)
  - "Google Docs Sync: Pull from Drive" (import only)
  - "Google Docs Sync: Push to Drive" (export only)
- **User Feedback**: Non-intrusive notices with operation progress and completion status

## Functional Requirements

### Authentication & Security
- **OAuth Implementation**: PKCE flow for CLI (no client secret), standard OAuth for plugin
- **Token Management**: Secure local storage at `~/.config/gdocs-markdown-sync/tokens-<profile>.json`
- **Profile Support**: Multiple account isolation via named profiles
- **Minimal Scopes**: Request only necessary Google Drive and Docs permissions

### Document Synchronization
- **Metadata Preservation**: `docId`, `revisionId`, `sha256` in YAML frontmatter, additional keys preserved
- **State Tracking**: Dual storage in local frontmatter and Google Drive appProperties
- **Change Detection**: SHA-256 content hashing for efficient sync decisions
- **Folder Structure**: Maintain hierarchical organization between local directories and Drive folders

### Conflict Resolution
- **Policy-Based Resolution**: User-configurable conflict handling strategies
- **3-Way Merge Foundation**: Compare local, remote, and last-known state for intelligent merging
- **Conflict Markers**: Clear visual indicators for manual resolution when automatic merge fails
- **Safe Defaults**: Conservative conflict handling to prevent data loss

### Error Handling & Reliability
- **Network Resilience**: Automatic retry with exponential backoff for transient failures
- **Partial Failure Recovery**: Isolated error handling that doesn't halt entire operations
- **Clear Error Messages**: Actionable feedback with correlation IDs for troubleshooting
- **Operation Logging**: Comprehensive audit trail for sync operations

## Non-Functional Requirements

### Performance
- **Startup Time**: <5 seconds for first auth and sync operations
- **Sync Efficiency**: Change detection optimizations to minimize API calls
- **Background Operations**: Non-blocking sync that doesn't interfere with user workflow
- **Memory Usage**: Efficient processing of large document collections

### Reliability & Data Integrity
- **Idempotent Operations**: Safe to run multiple times without unintended side effects
- **Atomic Operations**: Document updates are all-or-nothing to prevent corruption
- **Backup Safety**: No silent data overwrites, clear conflict resolution paths
- **State Consistency**: Document associations maintained across all operations

### Security & Privacy
- **Minimal Attack Surface**: Request only necessary OAuth scopes
- **Local Token Storage**: No cloud-based credential storage, user-controlled access
- **Data Privacy**: No document content logging or external transmission beyond Google APIs
- **Audit Trail**: Operation logging without sensitive data exposure

### Platform Support
- **Operating Systems**: Native support for macOS, Linux, Windows
- **Runtime Requirements**: Node.js/Bun for CLI, browser environment for Obsidian plugin
- **Installation**: Simple package manager installation and plugin deployment

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
