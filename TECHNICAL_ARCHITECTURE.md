Technical Architecture

## Design Philosophy

This architecture is specifically designed to support the product goals outlined in PRODUCT_PRD.md:

- **Dual deployment**: Single TypeScript codebase serving both CLI and Obsidian plugin users
- **Production reliability**: Enterprise-grade error handling, network resilience, and security
- **User experience focus**: Clear feedback, predictable behavior, and safe operations
- **Maintainability**: Shared components, comprehensive testing, and clean abstractions

## Overview

- Single TypeScript codebase powering a Bun CLI and an Obsidian plugin
- **Unified shared components**: Drive/Docs API access, OAuth, frontmatter processing, error handling, and utilities
- **Eliminated code duplication**: Both CLI and plugin use identical implementations for core functionality
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

- **Unified OAuth Architecture** (`src/auth/`)
  - **Two-Flow Design**: CLI uses localhost callback, Plugin uses out-of-band manual code entry
  - **Shared PKCE Implementation**: Both flows use Proof Key for Code Exchange for enhanced security
  - **Common Token Exchange**: Shared logic via `UnifiedOAuthManager.exchangeCodeForTokens()`
  - **Storage Isolation**: CLI uses filesystem, Plugin uses Obsidian's data store

- **Unified Front Matter & Hashing** (`src/fs/frontmatter.ts`)
  - **Single source of truth**: Both CLI and plugin use shared frontmatter processing
  - YAML front matter using `gray-matter` with keys: `docId`, `revisionId`, `sha256`. Unknown keys preserved and round-tripped.
  - **Cross-platform SHA-256**: Bun crypto (CLI), Node.js crypto (fallback), Web Crypto (browser/Obsidian)
  - **Robust parsing**: Advanced YAML parsing with error recovery and sanitization

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
- **Conflict resolution**: `--conflicts prefer-doc|prefer-md|merge` with intelligent 3-way merge
- **Safety features**: `--dry-run` for preview mode without making changes
- **Advanced flags**: `--watch`, `--poll-interval` - implemented for CLI-specific workflows
- **Environment integration**: All major environment variables supported

### Current Plugin Features

- **Settings UI**: Drive folder ID, base vault folder, conflict policy, OAuth config - implemented
- **Commands**: Sync, Pull, Push, Start Auth Flow - all functional in Command Palette
- **Background sync**: Basic polling implementation with reentrancy guard
- **Unified error handling**: Now uses shared ErrorUtils with proper error classification and aggregation
- **Consistent filename handling**: Uses shared sanitization logic identical to CLI
- **Status**: Usable for basic workflows, now more reliable with shared components

## State Management & Conflict Resolution

### Current Implementation

- **Dual state storage**: Front matter (local) + Drive appProperties (remote) for 3-way merge foundation
- **Change detection**: SHA-256 content hashing for efficient sync decisions
- **Conflict policies**: `prefer-doc`/`prefer-md`/`merge` fully implemented with intelligent resolution
- **3-way merge**: Complete implementation using revisionId + sha256 comparison for accurate conflict detection
- **Smart conflict resolution**: Automatic resolution for non-conflicting changes, policy-based resolution for true conflicts
- **Manual conflict support**: Clear conflict markers with user guidance when automatic resolution fails

### Architecture Design

- **3-way merge foundation**: Compare local, remote, and last-known state using `revisionId` + `sha256`
- **Metadata preservation**: `docId`, `revisionId`, `sha256` keys with additional frontmatter key preservation
- **Safe defaults**: Conservative conflict handling to prevent data loss
- **Extensible design**: Policy pattern allows for future conflict resolution strategies

Security & Reliability

### OAuth Architecture & Security

#### PKCE Implementation Details

Both CLI and Plugin use PKCE (Proof Key for Code Exchange) with Google's OAuth2 endpoint:

**PKCE Generation**:
- **Verifier**: 32 bytes of cryptographically secure random data, base64url encoded
- **Challenge**: SHA-256 hash of verifier, base64url encoded  
- **CLI**: Uses Node.js `crypto` module (`randomBytes`, `createHash`)
- **Plugin**: Uses Web Crypto API (`crypto.getRandomValues`, `crypto.subtle.digest`)

```typescript
// Example PKCE challenge generation (Plugin)
const array = new Uint8Array(32);
crypto.getRandomValues(array);
const codeVerifier = btoa(String.fromCharCode.apply(null, Array.from(array)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
const codeChallenge = btoa(String.fromCharCode.apply(null, Array.from(hashArray)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
```

#### Two Authentication Flows

**CLI Flow (Localhost Callback)**:
- Redirect URI: `http://localhost:<random-port>/callback`
- Process: Starts Express server → Opens browser → Google redirects back → Automatic code capture
- Implementation: `UnifiedOAuthManager.startNodeAuthFlow()`
- User Experience: Fully automatic after browser approval

**Plugin Flow (Out-of-Band)**:
- Redirect URI: `urn:ietf:wg:oauth:2.0:oob` 
- Process: Opens browser → User approves → Google shows code → User copies/pastes into plugin
- Implementation: `plugin-main.ts` `generateAuthUrl()` + `handleAuthCallback()`
- User Experience: Manual code copy/paste (required due to Obsidian sandbox)

#### Public OAuth Client Configuration

**Important Security Note**: The OAuth client uses the "public client" model where credentials are intentionally committed:

```typescript
// PUBLIC OAuth Client - Intentionally committed for desktop/plugin use
// Google requires client_secret even with PKCE (non-standard requirement)
// Security scanner exception: not a leaked secret, this is a public client
// gitleaks:allow
const PUBLIC_CLIENT_ID = '181003307316-5devin5s9sh5tmvunurn4jh4m6m8p89v.apps.googleusercontent.com';
// gitleaks:allow  
const CLIENT_SECRET = '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';
```

**Why This Is Secure**:
- Google's OAuth app configured as "Desktop Application" type
- PKCE provides code injection protection (the real security)
- Client secret is public by design (desktop app model)
- No additional security from secret obfuscation in this architecture

#### Token Storage & Management

- **CLI Storage**: Filesystem at `~/.config/gdocs-markdown-sync/tokens-<profile>.json`
- **Plugin Storage**: Obsidian plugin data store via `ObsidianTokenStorage`
- **Profile Support**: Multiple account isolation (`default`, `work`, etc.)
- **Automatic Refresh**: Tokens refreshed 5 minutes before expiry
- **Permissions**: CLI files restricted to user access only

#### Security Features

- **Minimal OAuth scopes**: Request only necessary permissions for Drive/Docs operations
  - `https://www.googleapis.com/auth/documents`: Read/write access to Google Docs content
  - `https://www.googleapis.com/auth/drive.file`: Read/write access to files created by application
- **Data privacy**:
  - No document contents logged or transmitted except to Google APIs
  - Correlation IDs in logs (not full tokens or sensitive data)
  - No full headers or response bodies in logging output
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
- **OAuth Implementation**: Custom PKCE flows with dual environment support
- **YAML Processing**: `gray-matter` for frontmatter parsing with unknown key preservation  
- **Cryptography**: Node.js crypto (CLI) and Web Crypto API (browser) for PKCE and SHA-256 hashing
- **HTTP Client**: Native `fetch` with custom retry and timeout wrapper

### Development Tooling

- **Testing**: Bun test runner with comprehensive OAuth and PKCE test coverage
- **Linting**: ESLint with TypeScript integration for code quality
- **Formatting**: Prettier for consistent code style
- **CI/CD**: GitHub Actions with comprehensive validation pipeline

#### OAuth Testing Coverage

Comprehensive test suite in `src/auth/auth.test.ts` covers:

- **PKCE Generation Tests**: 
  - Verifier generation (32-byte cryptographically secure, base64url encoded)
  - Challenge generation (SHA-256 hash of verifier, base64url encoded)  
  - Entropy validation (different verifiers on each generation)
  - Format validation (no padding, proper character set)

- **OAuth URL Construction Tests**:
  - CLI flow URL validation (localhost callback redirect)
  - Plugin flow URL validation (out-of-band redirect)
  - Parameter encoding validation (special characters handled correctly)
  - Required parameter presence (client_id, PKCE challenge, scopes)

- **Token Exchange Tests**:
  - Request body structure validation (all required OAuth parameters)
  - Success response handling (access_token, refresh_token, expires_in)
  - Error response handling (invalid_grant, error descriptions)
  - Expiry date calculation and validation

- **Storage Integration Tests**:
  - Plugin storage isolation (ObsidianTokenStorage)
  - Profile separation (multiple account support)
  - Token persistence and retrieval

## Build & Deployment

### CLI Distribution

- **Development**: `bun run cli -- <command>` for local development
- **Global installation**: `bun link` → `gdocs-markdown-sync` binary
- **Package structure**: Built to `dist/` with proper module resolution
- **NPM publication**: Automated registry publication for simplified installation and updates

### Obsidian Plugin Distribution

- **Build target**: `dist/main.js` with Obsidian external dependencies
- **Standardized packaging**: `bun run package:plugin` creates ready-to-install `dist/plugin.zip`
- **Manual installation**: Copy `dist/main.js` + `dist/manifest.json` + `dist/styles.css` to vault plugin folder
- **Automated releases**: GitHub Actions generates plugin releases with consistent packaging
- **Community plugin marketplace**: Submission process for official Obsidian plugin directory

### Testing Infrastructure

- **Unit tests**: Comprehensive coverage of business logic with Bun test runner
- **Integration tests**: Real Google API integration requiring prior authentication
- **Mocking**: Obsidian API mocks for plugin-specific functionality testing
- **CI validation**: Automated typecheck, lint, test, and format verification

### Operations & Monitoring (Future)

- **Usage analytics**: Optional telemetry for understanding common workflows and optimization opportunities
- **Performance monitoring**: Built-in performance metrics and optimization insights with detailed operation timing
- **CI/CD integration**: Plugin for automated documentation sync in build pipelines and GitHub Actions workflows
- **Advanced debugging**: Detailed logging UI matching CLI verbose mode for troubleshooting complex sync scenarios

## Code Consolidation (Latest)

### Eliminated Duplications

- **Frontmatter Processing**: Plugin migrated from inline YAML parsing to shared `src/fs/frontmatter.ts`
- **Filename Sanitization**: Both CLI and plugin use identical `SyncUtils.sanitizeFileName` logic
- **Error Handling**: Plugin now uses shared `ErrorUtils` with proper error classification and correlation IDs
- **SHA-256 Computation**: Consolidated to single cross-platform implementation in `src/fs/frontmatter.ts`
- **Markdown Sanitization**: Plugin now uses `SyncUtils.sanitizeMarkdownForGoogleDrive` for consistency

### Shared Components Architecture

- **Single Source of Truth**: Critical utilities have unified implementations
- **Cross-Platform Compatibility**: Shared code works in Node.js, Bun, and browser environments
- **Consistent Error Handling**: Same error patterns and correlation across CLI and plugin
- **Maintainability**: Changes to core logic automatically benefit both interfaces

### Backward Compatibility

- Deprecated functions marked with warnings but still functional for transition period
- Plugin fallback mechanisms ensure robustness during migration
- No breaking changes to existing user configurations or workflows

Notable Limitations

- Round-tripping of complex Docs constructs (comments, suggestions, drawings) is lossy.
- Merge policy is experimental; conflict handling is conservative by default.
