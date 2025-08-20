Technical Architecture

## Design Philosophy

This architecture is specifically designed to support the product goals outlined in PRODUCT_PRD.md:
- **Dual deployment**: Single TypeScript codebase serving both CLI and Obsidian plugin users
- **Production reliability**: Enterprise-grade error handling, network resilience, and security
- **User experience focus**: Clear feedback, predictable behavior, and safe operations
- **Maintainability**: Shared components, comprehensive testing, and clean abstractions

## Overview

- Single TypeScript codebase powering a Bun CLI and an Obsidian plugin
- Shared building blocks for Drive/Docs API access, OAuth, front matter, and hashing
- Production-ready infrastructure: retry logic, error handling, logging, and configuration management

Components

- CLI (`src/cli.ts`): Implements `auth`, `pull`, `push`, `sync` commands.
  - Auth: PKCE OAuth via `PKCEOAuthManager` → saves tokens to `~/.config/gdocs-markdown-sync/tokens-<profile>.json`.
  - Pull: Lists Docs in Drive folder → exports Markdown → writes files with YAML front matter.
  - Push: Reads Markdown files → parses front matter → creates/updates Docs → refreshes front matter.
  - Sync: Pull then push; optional polling with `--watch` and `--poll-interval`.

- Obsidian Plugin (`src/main.ts`):
  - UI: Settings tab (`src/settings.ts`) with Drive Folder ID, base vault folder, conflict policy, poll interval, and OAuth fields.
  - Auth: Standard OAuth flow via `OAuthManager` and token handling via `AuthManager`/`TokenLoader`.
  - Commands: Sync, Pull, Push, and Start Auth Flow exposed in Command Palette.
  - Polling: Background sync on interval if enabled.

- Drive Client (`src/drive/client.ts`):
  - `listDocsInFolder(folderId)` → Doc metadata (id, name, headRevisionId, etc.)
  - `exportDocMarkdown(fileId)` → Markdown string
  - `uploadMarkdownAsDoc(name, content, parentId?)` → creates Doc from Markdown
  - `updateDocMarkdown(fileId, content)` → updates Doc content
  - `getFile(fileId)` → fetches file with `headRevisionId`
  - `setAppProperties(fileId, props)` / `getAppProperties(fileId)`
  - `createFolder(...)`, `listFoldersInFolder(...)`, `deleteFile(fileId)` (supporting ops)

- Auth
  - CLI: `src/auth/PKCEOAuthManager.ts` implements PKCE (no client secret). Uses a default public client ID (overridable via `GOOGLE_OAUTH_CLIENT_ID`).
  - Plugin: `src/auth/OAuthManager.ts` supports client ID/secret supplied via settings or env. Tokens handled by `src/auth/TokenLoader.ts`.

- Front Matter & Hashing (`src/fs/frontmatter.ts`)
  - YAML front matter using `gray-matter` with keys: `docId`, `revisionId`, `sha256`. Unknown keys preserved and round-tripped.
  - SHA-256 hashing: Node crypto for CLI/tests; Web Crypto for browser/Obsidian.

- Network Layer (`src/utils/NetworkUtils.ts`)
  - Retry logic with exponential backoff and jitter (default: 3 retries)
  - Configurable request timeouts (default: 30s) with AbortController cancellation
  - Rate limiting protection with `Retry-After` header support
  - Batch processing with configurable concurrency limits
  - Error classification: retry 5xx/timeouts, fail fast on 4xx client errors

- Error Handling (`src/utils/ErrorUtils.ts`)
  - Custom error classes: `BaseError`, `AuthenticationError`, `DriveAPIError`, `FileOperationError`, `SyncError`, `ValidationError`, `ConfigurationError`
  - Error correlation IDs for request tracking across operations
  - Rich error context with operation metadata, resource IDs, and file paths
  - `ErrorAggregator` for collecting and categorizing multiple errors
  - Error chaining with original error preservation

- Logging (`src/utils/Logger.ts`)
  - Multi-level logging: DEBUG, INFO, WARN, ERROR with environment-specific defaults
  - Contextual logging with correlation IDs and operation tracking
  - Multiple output formats: console (human-readable), JSON (structured), file
  - Performance metrics tracking: operation timing, error rates, success statistics
  - `OperationLogger` for long-running operation lifecycle management

- Configuration (`src/utils/Config.ts`)
  - Centralized configuration for network, logging, and sync settings
  - Environment variable integration with development/production profiles
  - Runtime configuration updates with validation
  - Type-safe configuration access with sensible defaults

## Implementation Status

### Current CLI Surface
- **Commands**: `auth`, `pull`, `push`, `sync` - all implemented
- **Core flags**: `--drive-folder-id`, `--local-dir`, `--profile`, `--conflicts` - functional
- **Advanced flags**: `--watch`, `--poll-interval` - implemented for CLI-specific workflows
- **Environment integration**: All major environment variables supported

### Current Plugin Features
- **Settings UI**: Drive folder ID, base vault folder, conflict policy, OAuth config - implemented
- **Commands**: Sync, Pull, Push, Start Auth Flow - all functional in Command Palette
- **Background sync**: Basic polling implementation with reentrancy guard
- **Status**: Usable for basic workflows, needs UX refinement

## State Management & Conflict Resolution

### Current Implementation
- **Dual state storage**: Front matter (local) + Drive appProperties (remote) for 3-way merge foundation
- **Change detection**: SHA-256 content hashing for efficient sync decisions
- **Conflict policies**: `prefer-doc`/`prefer-md` implemented as meaningful defaults
- **Merge support**: Hook exists but returns placeholder conflict markers (requires full implementation)

### Architecture Design
- **3-way merge foundation**: Compare local, remote, and last-known state using `revisionId` + `sha256`
- **Metadata preservation**: `docId`, `revisionId`, `sha256` keys with additional frontmatter key preservation
- **Safe defaults**: Conservative conflict handling to prevent data loss
- **Extensible design**: Policy pattern allows for future conflict resolution strategies

Security & Reliability

### Security Model
- **Minimal OAuth scopes**: Request only necessary permissions for Drive/Docs operations
  - `drive`: Access to Google Drive files and folders
  - `drive.file`: Read/write access to files created by the application
  - `documents`: Read/write access to Google Docs content
- **Token storage**: Locally stored at `~/.config/gdocs-markdown-sync/tokens-<profile>.json`
  - Profile-aware for multiple account support (`default` profile used when unspecified)
  - File permissions restricted to user access only
  - **Never commit tokens to version control**
- **Credential security**: 
  - CLI uses PKCE OAuth (no client secret required)
  - Plugin supports client ID/secret configuration in settings
  - Automatic token refresh with secure error handling
- **Data privacy**: 
  - No document contents logged or transmitted except to Google APIs
  - Prefer hashed document IDs in logs where practical
  - No full headers or sensitive data in logging output
- **Profile isolation**: Multiple accounts supported via named profiles for organizational separation

### Vulnerability Reporting
- Report security issues via GitHub issues with minimal public details
- Maintainers will provide secure communication channel for sensitive details
- Follow responsible disclosure practices

### Network Resilience
- Exponential backoff with jitter to prevent thundering herd effects
- Configurable request timeouts (default: 30s) with proper cancellation
- Rate limiting protection with `Retry-After` header compliance
- Error classification: retry 5xx/timeouts, fail fast on 4xx client errors

### Error Recovery & Monitoring
- Comprehensive error handling with context preservation and correlation tracking
- Structured logging with correlation IDs for request tracing across operations
- Performance monitoring: operation metrics, success rates, and timing analytics
- Memory-efficient metrics collection with automatic cleanup

### Configuration Security
- Type-safe configuration validation with environment-specific profiles
- Environment variable support for sensitive configuration (OAuth client IDs)
- Runtime configuration validation with sensible secure defaults
- No secrets stored in configuration files or committed to repository

## Technology Stack

### Runtime & Build System
- **TypeScript 5+**: Strict mode with comprehensive type safety
- **Bun**: Primary runtime for CLI, build system, and test runner
- **Node.js compatibility**: Ensures broad compatibility for CLI distribution

### Key Libraries & APIs
- **Google APIs**: Drive v3 and Docs v1 for document operations
- **OAuth Implementation**: Custom PKCE and standard OAuth flows
- **YAML Processing**: `gray-matter` for frontmatter parsing with unknown key preservation
- **Cryptography**: Node.js crypto (CLI) and Web Crypto (browser) for SHA-256 hashing
- **HTTP Client**: Native `fetch` with custom retry and timeout wrapper

### Development Tooling
- **Testing**: Bun test runner with unit and integration test suites
- **Linting**: ESLint with TypeScript integration for code quality
- **Formatting**: Prettier for consistent code style
- **CI/CD**: GitHub Actions with comprehensive validation pipeline

## Build & Deployment

### CLI Distribution
- **Development**: `bun run cli -- <command>` for local development
- **Global installation**: `bun link` → `gdocs-markdown-sync` binary
- **Package structure**: Built to `dist/` with proper module resolution
- **Future**: NPM publication for wider distribution

### Obsidian Plugin Distribution  
- **Build target**: `dist/main.js` with Obsidian external dependencies
- **Manual installation**: Copy `manifest.json` + `dist/main.js` to vault plugin folder
- **Future**: Community plugin marketplace submission with automated packaging

### Testing Infrastructure
- **Unit tests**: Comprehensive coverage of business logic with Bun test runner
- **Integration tests**: Real Google API integration requiring prior authentication
- **Mocking**: Obsidian API mocks for plugin-specific functionality testing
- **CI validation**: Automated typecheck, lint, test, and format verification

Notable Limitations

- Round-tripping of complex Docs constructs (comments, suggestions, drawings) is lossy.
- Merge policy is experimental; conflict handling is conservative by default.
