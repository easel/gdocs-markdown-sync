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
bun run build                  # Safe build: check + build + verify (DEFAULT - RECOMMENDED)
bun run build:unsafe           # Build without checks (use only when debugging build issues)
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

**IMPORTANT: Plugin directory name is `google-docs-sync` (from manifest.json ID)**

```bash
# Deploy to synaptiq_ops vault (includes automatic typecheck validation)
bun run deploy:synaptiq
# OR
make deploy-synaptiq

# Build is safe by default - no need for additional checks
bun run build && bun run deploy:synaptiq

# Build and package plugin for distribution
bun run package:plugin
# Creates dist/plugin.zip with main.js, manifest.json, and styles.css

# For development: Manual installation
bun run build:plugin
# Copy dist/* to vault/.obsidian/plugins/google-docs-sync/
# Note: plugin.js gets renamed to main.js during build
```

### Build System

- `bun run build` - **SAFE BUILD**: Full quality checks + CLI + plugin + verification (DEFAULT)
- `bun run build:unsafe` - Direct build without safety checks (debugging only)
- `bun run build:cli` - CLI only (no safety checks)
- `bun run build:plugin` - Plugin only (no safety checks)
- Deployment always shows version being deployed and verifies after copy

### Troubleshooting Builds

If you see version mismatches:

1. Run `bun run build` (safe build with all checks)
2. Check `dist/manifest.json` has correct version
3. Deploy with `bun run deploy:synaptiq` for automatic verification

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

### AI Agent Best Practices

#### Parallel Execution Strategy

**CRITICAL**: Always use parallel subagents when fixing multiple independent issues or performing multiple searches to maximize performance.

```
❌ BAD: Sequential fixes (slow)
- Fix error A, wait for completion
- Fix error B, wait for completion
- Fix error C, wait for completion

✅ GOOD: Parallel fixes (fast)
- Launch 3 subagents simultaneously:
  - Agent 1: Fix error A
  - Agent 2: Fix error B
  - Agent 3: Fix error C
```

**When to use parallel subagents:**

- Fixing multiple TypeScript errors across different files
- Searching for multiple patterns or concepts
- Implementing multiple independent features
- Running multiple test suites
- Analyzing different parts of the codebase

**Example parallel task distribution:**

```
TypeScript errors to fix:
- Auth module errors → Subagent 1
- Drive API errors → Subagent 2
- Plugin UI errors → Subagent 3
- Type definition errors → Subagent 4
```

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

## Type Safety and Build Quality

### Zero-Tolerance TypeScript Policy

**CRITICAL**: With TypeScript available, there is NO excuse for deploying code with missing methods or type errors that could be caught at compile time.

#### Mandatory Pre-Build Checks

Before any deployment, ALL of these must pass without errors:

```bash
bun run typecheck    # TypeScript compilation check (MUST be error-free)
bun run lint         # Code quality and import order
bun run test         # Unit and integration tests
bun run format:check # Code formatting consistency
```

Or use the consolidated command:

```bash
bun run check        # Runs all checks above
```

#### Build Pipeline Safeguards

1. **Type checking in prebuild**: Build scripts MUST run TypeScript validation
2. **Deploy verification**: Never deploy without running type check first
3. **Error visibility**: TypeScript errors are treated as build failures, not warnings

#### Case Study: Missing Method Runtime Error

**The Problem**:

- Runtime error: `this.authManager.getTokenStorage is not a function`
- Location: `plugin-main.ts:329`
- Root cause: `PluginAuthManager` class missing `getTokenStorage()` method

**What TypeScript Caught**:

```bash
$ bun run typecheck
src/plugin-main.ts(329,43): error TS2339: Property 'getTokenStorage' does not exist on type 'PluginAuthManager'.
```

**The Gap**: Build process didn't enforce TypeScript checking, allowing a compile-time error to become a runtime failure.

#### Type Safety Requirements

1. **Explicit interfaces**: Define clear contracts between modules

   ```typescript
   interface TokenStorage {
     getTokens(): Credentials | null;
     save(credentials: Credentials): Promise<void>;
     clear(): Promise<void>;
   }
   ```

2. **Public method signatures**: All public methods MUST have explicit return types

   ```typescript
   // ❌ Bad - implicit return type
   getTokenStorage() {
     return this.tokenStorage;
   }

   // ✅ Good - explicit return type
   getTokenStorage(): TokenStorage {
     return this.tokenStorage;
   }
   ```

3. **Cross-module boundaries**: Use interfaces to define contracts
   ```typescript
   // Define what the auth manager must provide
   interface AuthManager {
     getTokenStorage(): TokenStorage;
     isAuthenticated(): boolean;
     getAuthClient(): Promise<any>;
   }
   ```

#### Testing for Type Safety

1. **Unit tests for all public APIs**: Every public method must have tests
2. **Type contract tests**: Verify interfaces match between modules
3. **Integration tests for critical paths**: Test the full authentication flow
4. **Mock validation**: Ensure mocks match real implementations

#### Forbidden Practices

- **Never use `// @ts-ignore`** without explicit code review approval
- **Never deploy with TypeScript errors** - fix them, don't suppress them
- **Never bypass type checking** in build scripts
- **Never commit code** that fails `bun run check`

#### Enhanced Build Scripts

The build process now MUST include:

1. **Pre-build validation**: Type check before any compilation
2. **Build verification**: Ensure all outputs are type-safe
3. **Pre-deploy checks**: Final validation before deployment

#### Developer Workflow

```bash
# Before starting work
bun run check                    # Ensure clean starting state

# During development
bun run typecheck               # Frequent type checking
bun run test                    # Run tests for changed code

# Before committing
bun run check                   # All checks must pass
bun run build                   # Safe build with full verification (RECOMMENDED)

# Before deploying
bun run deploy:synaptiq         # Deploy with automatic typecheck validation
```

#### Recovery Protocol

When encountering TypeScript errors:

1. **Fix immediately**: Don't work around, fix the root cause
2. **Update tests**: Ensure tests cover the fixed functionality
3. **Verify comprehensively**: Run full check suite
4. **Document if needed**: Add to this guide if it reveals a pattern

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
