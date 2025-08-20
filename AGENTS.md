# Agent Guidelines

## Project Overview

TypeScript codebase implementing bidirectional Google Docs ↔ Markdown synchronization with dual deployment targets:

- **CLI Tool**: Node.js/Bun CLI with PKCE OAuth for command-line usage
- **Obsidian Plugin**: Browser-compatible plugin with standard OAuth for vault integration

## Core Architecture

- **Single codebase**: Shared TypeScript modules for both CLI and plugin
- **Unified APIs**: Drive/Docs client, OAuth managers, frontmatter parsing, and sync logic
- **State management**: YAML frontmatter (local) + Drive appProperties (remote) for 3-way merge
- **Network resilience**: Retry logic, timeouts, rate limiting, comprehensive error handling

## Quick Commands

### Development

```bash
bun install                    # Install dependencies
bun run build                  # Build all targets
bun run check                  # Run typecheck, lint, tests, format check (REQUIRED after changes)
bun run format                 # Auto-fix code formatting (required for CI)
bun run lint:fix              # Fix linting issues (import order, unused vars, etc.)
```

### CLI Usage

```bash
bun run cli -- auth                           # Authenticate with Google
bun run cli -- sync --drive-folder-id=<id>   # Two-way sync
bun run cli -- pull --local-dir=./docs       # Pull docs to markdown
bun run cli -- push --watch --poll-interval=30  # Push with polling

# After linking: bun link
gdocs-markdown-sync sync --drive-folder-id=<id>
```

### Testing

```bash
bun test                       # Unit tests
bun run test:integration      # Integration tests (requires auth)
```

### Plugin Deployment

```bash
# Build and package plugin for distribution
bun run package:plugin
# Creates dist/plugin.zip with main.js, manifest.json, and styles.css

# For development: Manual installation
bun run build:plugin
# Copy dist/main.js + dist/manifest.json + dist/styles.css to vault/.obsidian/plugins/google-docs-sync/
```

## CLI Interface

### Commands

- `auth`: PKCE OAuth flow, saves tokens to `~/.config/gdocs-markdown-sync/`
- `pull`: Export Google Docs to Markdown files with YAML frontmatter
- `push`: Upload Markdown files to Google Docs, create or update as needed
- `sync`: Pull then push; supports continuous sync with `--watch`

### Flags

- `--drive-folder-id <id>` (env: `DRIVE_FOLDER_ID`): Google Drive folder to sync
- `--local-dir <path>` (env: `LOCAL_DIR`): Local directory for Markdown files
- `--watch`: Enable continuous sync with polling
- `--poll-interval <seconds>`: Polling frequency for watch mode (default: 60)
- `--conflicts <policy>`: Conflict resolution - `prefer-doc|prefer-md|merge`

## Key File Structure

```
src/
├── cli.ts              # CLI entrypoint and command handling
├── main.ts             # Obsidian plugin entrypoint
├── drive/
│   ├── client.ts       # Google Drive/Docs API client
│   └── appProperties.ts # Drive metadata management
├── fs/
│   ├── frontmatter.ts  # YAML frontmatter parsing/serialization
│   └── hashing.ts      # Content hashing for change detection
├── auth/
│   ├── PKCEOAuthManager.ts  # CLI PKCE OAuth (no client secret)
│   ├── OAuthManager.ts      # Plugin standard OAuth
│   └── TokenLoader.ts       # Token storage and refresh
└── utils/
    ├── NetworkUtils.ts      # Retry logic, timeouts, rate limiting
    ├── ErrorUtils.ts        # Custom errors, correlation IDs
    ├── Logger.ts           # Structured logging with metrics
    └── Config.ts           # Centralized configuration
```

## Development Guidelines

### Code Quality

- **TypeScript 5+** with strict mode
- **Bun runtime** for CLI, browser-compatible for plugin
- **Minimal abstractions**: Keep modules focused and avoid over-engineering
- **Consistent naming**: Avoid stuttered names (e.g., `sync.Manager` not `sync.SyncManager`)
- **Error handling**: Custom error classes with correlation IDs and rich context

### Testing Requirements

- **Unit tests** for all business logic using Bun test runner
- **Integration tests** for API interactions (requires prior authentication via `bun run cli auth`)
- **Error scenario coverage** including network failures and rate limiting
- **CI compliance**: **ALWAYS run `bun run check` after any code changes to ensure CI passes**
  - This runs typecheck, lint, tests, and format check - all must pass

### Security & Performance

- **Minimal OAuth scopes**: Drive/Docs read/write only
- **Token security**: Store in `~/.config/gdocs-markdown-sync/`, never commit
- **Network resilience**: Exponential backoff, timeout handling, rate limiting protection
- **Logging safety**: Never log secrets or sensitive data

### State Management

- **Frontmatter**: `docId`, `revisionId`, `sha256` in YAML headers
- **Drive properties**: Metadata stored in Drive file appProperties
- **Conflict resolution**: Policy-based with prefer-doc/prefer-md defaults
- **3-way merge**: Compare local, remote, and last-known state

## Change Guidelines

### New Application Development Principles

**This is a NEW application under active development. When making changes:**

#### ✅ Forward Motion - Do This

- **Replace, don't supplement**: When changing functionality, replace the old implementation entirely
- **Update all tests**: Modify existing tests to reflect new behavior, don't create parallel test suites
- **Clean implementation**: Single source of truth for each feature - no `_legacy`, `_old`, or `_new` suffixes
- **Comprehensive updates**: When changing an API or data structure, update ALL consumers immediately
- **Do the hard thing**: Fix broken functionality properly rather than working around it

#### ❌ Legacy Patterns - Avoid These

- **Dual implementations**: No `oldFunction()` and `newFunction()` living side-by-side
- **Test accumulation**: No keeping old tests for removed functionality
- **Compatibility layers**: No adapters or bridges unless absolutely necessary for external constraints
- **Deferred cleanup**: No leaving broken/deprecated code "for later removal"

### Backward Compatibility Analysis

**Before making breaking changes, identify these critical constraint areas:**

#### 🔴 High-Risk Breaking Changes (Analyze Carefully)

- **Token storage format**: Changes to `~/.config/gdocs-markdown-sync/tokens-*.json` structure
- **YAML frontmatter schema**: Modifications to `docId`, `revisionId`, `sha256` fields or format
- **Drive appProperties**: Changes to metadata keys or value formats stored in Google Drive
- **CLI command signatures**: Modifications to command names, required flags, or output formats
- **Configuration file structure**: Changes to settings schema or environment variable names

#### 🟡 Medium-Risk Changes (Document Migration Path)

- **File system layout**: Changes to default directory structures or file naming
- **Network API contracts**: Modifications to Google Drive/Docs API usage patterns
- **Plugin manifest**: Changes affecting Obsidian plugin installation or permissions

#### 🟢 Low-Risk Changes (Safe to Modify)

- **Internal APIs**: Function signatures, class structures, module organization
- **Implementation details**: Algorithm improvements, error handling, logging
- **Development tooling**: Build processes, test infrastructure, linting rules
- **Documentation**: README, guides, inline comments

### Rigorous Problem Solving

**When encountering issues, follow this approach:**

1. **Investigate root cause**: Don't treat symptoms, fix underlying problems
2. **Prove test validity**: Before removing/ignoring tests, demonstrate they test obsolete behavior
3. **Fix comprehensively**: Address the core issue across the entire codebase
4. **Validate thoroughly**: Ensure solution works for all use cases, not just the immediate problem

**Forbidden shortcuts:**

- "Let's just remove this broken test"
- "We can ignore this edge case"
- "This only affects legacy users"
- "The old code path is rarely used"

### Scope Constraints

- **TypeScript only**: No Go, Python, or other language artifacts
- **Forward-focused changes**: Favor simplicity and clean implementation over compatibility
- **Build stability**: Avoid changing build scripts unless explicitly requested
- **Documentation sync**: Update relevant docs alongside behavior changes
- **Minimal scope**: Keep changes focused and well-justified, avoid unnecessary modifications

### Testing Protocol

1. **Replace tests**: Update existing tests for modified behavior, don't create parallel suites
2. **Comprehensive coverage**: Ensure all code paths work with new implementation
3. **Integration verification**: Test end-to-end workflows with changes
4. **Prove test validity**: Before removing tests, demonstrate they test obsolete functionality
5. **Full validation**: Run `bun run check` before committing changes

### Error Handling Standards

- **Structured errors**: Use custom error classes with correlation IDs
- **Context preservation**: Include operation details, resource IDs, file paths
- **Error aggregation**: Collect multiple errors for batch operations
- **User-friendly messages**: Clear, actionable error descriptions

## Authentication Flow

### CLI (PKCE OAuth)

1. Run `bun run cli auth` to start OAuth flow
2. Browser opens to Google consent screen
3. Tokens saved to `~/.config/gdocs-markdown-sync/tokens-<profile>.json`
4. Automatic token refresh on subsequent CLI usage

### Plugin (Standard OAuth)

1. Configure client ID/secret in Obsidian plugin settings
2. Use "Start Auth Flow" command in Command Palette
3. Complete OAuth in browser, return to Obsidian
4. Tokens managed by AuthManager/TokenLoader

## Common Patterns

### Network Requests

```typescript
import { NetworkUtils } from './utils/NetworkUtils.js';

const response = await NetworkUtils.fetchWithRetry(url, options, {
  timeout: 30000,
  retryConfig: { maxRetries: 3, initialDelayMs: 1000 },
});
```

### Error Handling

```typescript
import { DriveAPIError, ErrorUtils } from './utils/ErrorUtils.js';

const operation = ErrorUtils.withErrorContext(
  async () => {
    /* operation */
  },
  { operation: 'sync-docs', folderId: 'abc123' },
);
```

### Logging

```typescript
import { createLogger } from './utils/Logger.js';

const logger = createLogger({ operation: 'document-sync' });
const op = logger.startOperation('process-files');
op.info('Processing 42 documents...');
op.success('All documents processed');
```

## References

- **Product Requirements**: `PRODUCT_PRD.md`
- **Technical Architecture**: `TECHNICAL_ARCHITECTURE.md`
- **Development Plan**: `DEVELOPMENT_PLAN.md`
- **Contributing Guidelines**: `CONTRIBUTING.md`

---

_This unified guide serves all AI agents (Claude, Gemini, Codex, etc.) working with this codebase. Keep changes minimal, test thoroughly, and maintain consistency with existing patterns._
