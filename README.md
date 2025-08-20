# Google Docs Markdown Sync

A complete TypeScript solution for bidirectional synchronization between Google Docs and Markdown files, available as both a CLI tool and an Obsidian plugin.

## ✅ Production Ready Features

- **🔐 Secure PKCE OAuth 2.0** - No client secrets required!
- **🔄 Bidirectional Sync** - Pull from Google Docs, push Markdown back
- **⚔️ Intelligent Conflict Resolution** - Smart 3-way merge with automatic and manual resolution modes
- **📝 Frontmatter Integration** - Automatic docId/revision tracking
- **🚫 Ignore File Support** - `.gdocs-sync-ignore` with .gitignore syntax
- **🕐 Polling Support** - Continuous sync with configurable intervals
- **🧪 Comprehensive Testing** - 50+ unit tests + integration tests
- **💻 CLI Tool** - Standalone command-line interface
- **🔌 Obsidian Plugin** - Full vault integration

## Architecture

This project provides a **unified TypeScript codebase** that powers both:

1. **CLI Tool** (`gdocs-markdown-sync`) - Standalone sync utility
2. **Obsidian Plugin** - Vault-integrated sync with UI

Both use the **same PKCE OAuth flow** for secure authentication without exposing client secrets.

## Installation

### CLI Tool

#### Option 1: Use with npx (Recommended)

```bash
npx gdocs-markdown-sync --help
```

#### Option 2: Install globally

```bash
npm install -g gdocs-markdown-sync
gdocs-markdown-sync --help
```

### Obsidian Plugin

#### Option 1: Download from GitHub Releases (Recommended)

1. Go to the [Releases page](https://github.com/user/gdocs-markdown-sync/releases)
2. Download `obsidian-google-docs-sync.zip` from the latest `plugin-v*` release
3. Extract to your vault's `.obsidian/plugins/google-docs-sync/` directory
4. Enable the plugin in Obsidian Settings → Community Plugins

#### Option 2: Build from source

See the [Development Setup](#development-setup) section below.

## Quick Start

### 1. Authentication (One-time setup)

```bash
# Secure PKCE OAuth flow - no client secrets needed!
gdocs-markdown-sync auth
```

### 2A. Use as CLI Tool

```bash
# Pull Google Docs to local Markdown files
gdocs-markdown-sync pull --drive-folder-id <folder-id> --local-dir ./docs

# Push local Markdown files to Google Docs
gdocs-markdown-sync push --drive-folder-id <folder-id> --local-dir ./docs

# Bidirectional sync
gdocs-markdown-sync sync --drive-folder-id <folder-id> --local-dir ./docs

# Continuous sync (every 5 minutes)
gdocs-markdown-sync sync --drive-folder-id <folder-id> --local-dir ./docs --watch
```

### 2B. Use as Obsidian Plugin

After installation (see above), enable "Google Docs Sync" in Obsidian → Settings → Community Plugins, then configure your Google Drive settings in the plugin settings.

## Commands Reference

### CLI Commands

- `auth` - Start PKCE OAuth authentication flow
- `pull` - Export Google Docs to Markdown files
- `push` - Upload/update Markdown files as Google Docs
- `sync` - Bidirectional sync (pull + push)

### CLI Flags

- `--drive-folder-id <id>` - Google Drive folder ID to sync
- `--local-dir <path>` - Local directory for Markdown files
- `--watch` - Enable continuous sync mode
- `--poll-interval <seconds>` - Custom polling interval (default: 300s)
- `--conflicts <policy>` - Conflict resolution: prefer-doc|prefer-md|merge

## Conflict Resolution

The system provides intelligent conflict resolution using 3-way merge technology that compares local changes, remote changes, and the last known sync state to make smart decisions about how to handle conflicts.

### Conflict Detection

The system automatically detects four types of scenarios:

1. **No Conflict** - Files are identical or no changes since last sync
2. **Local Only** - Only the local Markdown file has changes (auto-resolves with push)
3. **Remote Only** - Only the Google Doc has changes (auto-resolves with pull)
4. **Both Changed** - Both files have changes since last sync (requires policy resolution)

### Resolution Policies

Choose how conflicts are resolved with the `--conflicts` flag:

#### `prefer-doc` (Default)

```bash
gdocs-markdown-sync sync --conflicts prefer-doc --drive-folder "My Docs" --local-dir ./docs
```

- Always uses the Google Doc version when conflicts occur
- Local changes are overwritten with remote content
- Safe choice when Google Docs is the primary editing location

#### `prefer-md`

```bash
gdocs-markdown-sync sync --conflicts prefer-md --drive-folder "My Docs" --local-dir ./docs
```

- Always uses the Markdown file version when conflicts occur
- Remote Google Doc is updated with local content
- Good choice when local Markdown files are the primary editing location

#### `merge`

```bash
gdocs-markdown-sync sync --conflicts merge --drive-folder "My Docs" --local-dir ./docs
```

- Attempts intelligent automatic merging of non-conflicting changes
- Successfully merges when one version extends the other (e.g., added paragraphs)
- Falls back to conflict markers for manual resolution when automatic merge isn't possible

### Manual Resolution

When automatic merging fails, the system creates clear conflict markers in your Markdown files:

```markdown
Your content here...

<<<<<<< LOCAL (Modified: 2023-01-01T10:00:00Z)
This is the local version of the conflicting section.
=======

> > > > > > > REMOTE (Modified: 2023-01-01T11:00:00Z)
> > > > > > > This is the Google Doc version of the conflicting section.
> > > > > > > END CONFLICT (Generated: 2023-01-01T12:00:00Z)

More content here...
```

To resolve:

1. Edit the file to choose which version to keep (or combine them)
2. Remove all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
3. Run sync again - the system will detect the resolved conflict and proceed

### Preview Mode

Use `--dry-run` to see what changes would be made without actually modifying files:

```bash
gdocs-markdown-sync sync --dry-run --conflicts merge --drive-folder "My Docs" --local-dir ./docs
```

## Ignore Files

Create a `.gdocs-sync-ignore` file in your vault root to exclude files from sync. Uses the same syntax as `.gitignore`:

```bash
# Ignore Obsidian system files
.obsidian/
.trash/

# Ignore temporary files
*.tmp
*~

# Ignore drafts and templates
drafts/
templates/

# Ignore private notes
private/
*.private.md

# But keep important template
!templates/main-template.md

# Ignore all log files anywhere
**/*.log

# Ignore test directories
**/test/**
```

### Supported Patterns

- `*.ext` - Ignore all files with extension
- `folder/` - Ignore entire directories
- `**/pattern` - Match in any subdirectory
- `!pattern` - Negate (don't ignore) specific files
- `#` - Comments and empty lines are ignored
- `/pattern` - Match only at vault root

The ignore functionality works with both the CLI tool and Obsidian plugin.

## Testing

### Unit Tests (50+ tests)

```bash
bun test              # All tests
bun run test:unit     # Unit tests only
```

### Integration Tests (Real Google Drive API)

```bash
# First authenticate
gdocs-markdown-sync auth

# Then run integration tests
bun run test:integration
```

## Security

✅ **PKCE OAuth 2.0**: No client secrets stored or required  
✅ **Secure Token Storage**: Tokens saved locally in `~/.config/gdocs-markdown-sync/`  
✅ **Scoped Permissions**: Only requests necessary Google Drive/Docs permissions  
✅ **Local Operation**: No data sent to third-party servers

## Development Setup

For contributors or users who want to build from source:

```bash
git clone <repo-url>
cd gdocs-markdown-sync
bun install
bun run build
```

### Development Commands

```bash
# Run all checks (typecheck, lint, test, format)
bun run check

# Build CLI
bun run build:cli

# Build Obsidian plugin
bun run build:plugin

# Package plugin for distribution (creates dist/plugin.zip)
bun run package:plugin

# Run in development mode
bun run dev
```

## Development

This project uses modern TypeScript with comprehensive testing:

- **TypeScript 5.0+** with strict type checking
- **Bun test** for fast unit testing
- **Real API integration tests** with automatic cleanup
- **ESLint + Prettier** for code quality
- **Shared codebase** between CLI and plugin

### Project Structure

```
src/
├── auth/          # OAuth authentication (PKCE)
├── drive/         # Google Drive API client
├── fs/            # File system utilities
├── cli.ts         # CLI entry point
├── main.ts        # Obsidian plugin entry point
└── types.ts       # Shared TypeScript types
```

## Authentication Setup

- Prerequisites:
  - Enable “Google Drive API” and “Google Docs API” in your Google Cloud project (APIs & Services → Library).
  - Configure an OAuth consent screen (External is fine); add your Google account to Test users.
- CLI (PKCE):
  - No client secret required. Optionally set `GOOGLE_OAUTH_CLIENT_ID` to override the default public client ID.
  - Run `gdocs-markdown-sync auth`. Tokens are saved to `~/.config/gdocs-markdown-sync/tokens-<profile>.json`.
- Obsidian Plugin (OAuth):
  - Create a Desktop App OAuth client (Credentials → Create Credentials → OAuth client ID → Desktop App).
  - Enter the Client ID/Secret in the plugin settings, then click “Start Auth Flow”.
- Troubleshooting:
  - redirect_uri_mismatch: ensure the Desktop App client type; loopback redirect is set programmatically.
  - access_denied/restricted scope: verify APIs enabled and consent screen configured.
  - 404/403 on files: ensure the signed-in account has access to the Drive folder and Docs.

## Releases

This project uses GitHub Actions to automatically publish releases:

### Creating a CLI Release

```bash
git tag cli-v1.2.3
git push origin cli-v1.2.3
```

This will automatically publish to npm and create a GitHub release.

### Creating an Obsidian Plugin Release

```bash
git tag plugin-v1.2.3
git push origin plugin-v1.2.3
```

This will create a GitHub release with the plugin zip file.

## Contributing

Contributions welcome! See `CONTRIBUTING.md` for setup, style, and testing guidelines.

## License

ISC License - see LICENSE file for details.
