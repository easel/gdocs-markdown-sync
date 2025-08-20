Contributing

Thanks for helping improve gdocs-markdown-sync! This project is a TypeScript codebase that provides both a CLI and an Obsidian plugin to sync Google Docs with Markdown. Please keep changes minimal, well-tested, and clearly justified.

Development Setup

### Prerequisites

- **Bun**: Install with `brew install oven-sh/bun/bun` (macOS/Linux) or `npm install -g bun`
- **Obsidian**: For plugin development (download from https://obsidian.md)
- **Google OAuth Client**: Required for manual auth testing (see Manual Testing section)

### Initial Setup

```bash
# Install dependencies
bun install

# Run type checking
bun run typecheck

# Run linting and formatting
bun run lint
bun run format
```

## Building

### CLI Build

```bash
# Build CLI
bun run build:cli

# Run locally without global install  
bun run cli -- <command> [flags]

# Link globally (optional)
bun link
gdocs-markdown-sync <command>
```

### Plugin Build

```bash
# Build Obsidian plugin
bun run build:plugin

# Package plugin for distribution
bun run package:plugin

# Files created:
# - dist/main.js (plugin entry point)
# - dist/manifest.json (plugin manifest)
# - dist/styles.css (plugin styles)
# - dist/plugin.zip (installable package)
```

### Plugin Installation for Testing

1. **Manual Installation**: 
   ```bash
   # After building
   cp dist/main.js dist/manifest.json dist/styles.css /path/to/vault/.obsidian/plugins/gdocs-markdown-sync/
   ```

2. **Or install from ZIP**:
   - Extract `dist/plugin.zip` to vault's plugins directory
   - Enable "Google Docs Sync" in Obsidian Settings > Community Plugins

## Testing

### Automated Tests

```bash
# Unit tests (fast, no auth required)
bun test

# Run specific test suites
bun test src/auth/auth.test.ts          # OAuth/PKCE tests
bun test src/sync/ConflictResolver.test.ts  # Conflict resolution
bun test src/fs/frontmatter.test.ts     # YAML processing

# Integration tests (requires authentication - see Manual Testing)
bun run test:integration

# Test with coverage report
bun run test:coverage
```

### Manual Testing (Required for OAuth Flows)

**⚠️ Important**: OAuth authentication flows cannot be fully tested with automated tests and require manual verification.

#### Prerequisites for Manual Testing

1. **Google Cloud OAuth Client** (for auth testing):
   ```bash
   # Option 1: Use default public client (easier)
   # No setup required - uses built-in public OAuth client
   
   # Option 2: Create your own OAuth client (for org testing)
   # 1. Go to Google Cloud Console
   # 2. Create/select project
   # 3. Enable Google Drive API and Google Docs API  
   # 4. Create OAuth 2.0 credentials (Desktop Application type)
   # 5. Note Client ID and Client Secret
   ```

2. **Test Google Drive folder**:
   ```bash
   # Create a dedicated test folder in Google Drive
   # Note the folder ID from the URL: https://drive.google.com/drive/folders/FOLDER_ID
   ```

#### CLI Manual Testing

```bash
# 1. Test CLI authentication (PKCE with localhost callback)
gdocs-markdown-sync auth

# Expected flow:
# - Browser opens automatically
# - User approves OAuth consent 
# - Browser redirects to localhost (automatic)
# - CLI shows "Authentication successful!"
# - Tokens saved to ~/.config/gdocs-markdown-sync/tokens-default.json

# 2. Test CLI with custom profile  
gdocs-markdown-sync auth --profile work

# 3. Test basic CLI operations
echo "# Test Document" > test.md
gdocs-markdown-sync push test.md --drive-folder-id YOUR_FOLDER_ID
gdocs-markdown-sync pull --drive-folder-id YOUR_FOLDER_ID --local-dir ./test-output

# 4. Test conflict resolution
# Edit the Google Doc in browser, then:
echo "Local changes" >> test.md  
gdocs-markdown-sync sync test.md --drive-folder-id YOUR_FOLDER_ID --conflicts prefer-md
```

#### Plugin Manual Testing

```bash
# 1. Install and enable plugin in Obsidian (see Plugin Installation above)

# 2. Test plugin authentication (PKCE with out-of-band)
```

**Plugin Auth Flow Testing**:
1. Open Obsidian Settings > Community Plugins > Google Docs Sync
2. Configure OAuth settings:
   - Client ID: (leave blank to use default or enter your own)
   - Client Secret: (leave blank to use default or enter your own)  
   - Drive Folder ID: YOUR_FOLDER_ID
3. Click "Start Authentication"
4. **Expected flow**:
   - Browser opens to Google OAuth page
   - User approves consent
   - Google shows success page with authorization code
   - **User manually copies the code**
   - Return to Obsidian and paste code in modal
   - Plugin shows "Authentication successful!"
   - Tokens saved in Obsidian plugin data

**Plugin Sync Testing**:
1. Create a markdown file in your vault
2. Open Command Palette (Cmd/Ctrl+P)
3. Run "Google Docs Sync: Push to Drive"
4. Verify document appears in Google Drive
5. Edit the document in Google Drive
6. Run "Google Docs Sync: Pull from Drive"  
7. Verify changes appear in Obsidian

**Plugin Settings Testing**:
1. Test conflict resolution policies (prefer-doc, prefer-md, merge)
2. Test background sync enable/disable
3. Test authentication status display
4. Test "Clear Authentication" button

#### Manual Test Checklist

**CLI Authentication**:
- [ ] Fresh auth with `gdocs-markdown-sync auth` 
- [ ] Auth with custom profile `--profile test`
- [ ] Auth with custom client ID via `GOOGLE_OAUTH_CLIENT_ID=your_id`
- [ ] Token refresh on expiry
- [ ] Multiple profiles isolated correctly

**Plugin Authentication**:  
- [ ] Fresh auth through plugin settings
- [ ] Auth with default OAuth client (no config needed)
- [ ] Auth with custom OAuth client (configured in settings)
- [ ] Manual code copy/paste flow works smoothly
- [ ] Authentication status displays correctly
- [ ] Clear authentication and re-auth

**Core Sync Operations**:
- [ ] CLI push (creates new Google Doc)  
- [ ] CLI pull (imports from Google Docs)
- [ ] Plugin push via Command Palette
- [ ] Plugin pull via Command Palette  
- [ ] Background sync in plugin
- [ ] Frontmatter preservation (docId, revisionId, sha256)

**Conflict Resolution**:
- [ ] prefer-doc policy (CLI and plugin)
- [ ] prefer-md policy (CLI and plugin)  
- [ ] merge policy with conflict markers
- [ ] Manual conflict resolution workflow

**Error Scenarios**:
- [ ] Invalid OAuth code pasted
- [ ] Network failures during auth
- [ ] Token expiry handling
- [ ] Missing Google Doc (404 errors)
- [ ] Rate limiting (429 errors)
- [ ] Invalid folder permissions

#### Integration Test Setup

For automated integration tests, you need valid authentication:

```bash
# First authenticate via CLI
gdocs-markdown-sync auth

# Then run integration tests  
bun run test:integration

# Integration tests will use the CLI tokens you just created
```

## Development Workflow

### Making Changes

```bash
# 1. Make your changes
# 2. Run full validation suite
bun run typecheck && bun run lint && bun run format && bun test

# 3. Test specific builds
bun run build:cli && bun run build:plugin

# 4. Manual testing (see above sections)

# 5. Check final coverage  
bun run test:coverage
```

### Debugging

**CLI Debugging**:
```bash
# Enable debug logging
DEBUG=true bun run cli -- <command>

# Or with more verbose output
VERBOSE=true bun run cli -- <command>
```

**Plugin Debugging**:
- Open Obsidian Developer Tools (Cmd/Ctrl+Shift+I)
- Check console for plugin logs
- Network tab shows OAuth requests
- Plugin logs include correlation IDs for tracing

**OAuth Flow Debugging**:
- Check browser Network tab during auth
- Verify PKCE challenge/verifier generation  
- Validate token exchange requests
- Check token storage locations:
  - CLI: `~/.config/gdocs-markdown-sync/tokens-*.json`
  - Plugin: Obsidian plugin data (not directly accessible)

### Common Development Tasks

**Adding New OAuth Features**:
1. Update both CLI (`UnifiedOAuthManager`) and Plugin (`plugin-main.ts`) flows
2. Add tests to `src/auth/auth.test.ts`
3. Update documentation in `TECHNICAL_ARCHITECTURE.md`
4. Manual testing required for both flows

**Testing Network Changes**:
- Run against real Google APIs (integration tests)
- Test rate limiting and error scenarios
- Verify retry logic with network interruptions

**Adding New Sync Features**:
- Update `ConflictResolver` and `SyncService` 
- Add unit tests for conflict scenarios
- Test with real documents in manual testing
- Verify frontmatter preservation

## Coding Style

- TypeScript 5+; prefer small, focused modules
- Follow existing style; run formatter if configured by your editor
- Errors: throw with clear messages; include cause where helpful
- Tests: write Bun tests (table-driven pattern encouraged); target high coverage for critical paths
- OAuth: Always test both CLI and Plugin flows manually
- Security: Never commit real tokens; use correlation IDs in logs

Commit/PR Guidelines

- Commit messages: imperative scope style, e.g., `cli: add pull progress` or `drive: retry 429`
- PRs: describe purpose, link issues, and note any behavior changes (conflict policy, flags, token storage)

## Security

### OAuth Security Model

- **Public OAuth Client**: The project uses intentionally committed OAuth credentials for desktop/plugin use
- **PKCE Protection**: Both CLI and plugin use Proof Key for Code Exchange for security
- **No Secret Security**: Client secret is public by design (Google's desktop app model)
- **Correlation IDs**: Use correlation IDs in logs, never full tokens or sensitive data

### Development Security

- **Never commit real user tokens**: Only the public OAuth client credentials are committed
- **Use minimal scopes**: Request only necessary Google Drive/Docs permissions
- **Token storage locations**:
  - CLI: `~/.config/gdocs-markdown-sync/tokens-*.json` (user access only)
  - Plugin: Obsidian plugin data (sandboxed)
- **Security scanner exceptions**: Use `gitleaks:allow` comments for public OAuth credentials

### Security Testing

When testing OAuth flows:
- Use dedicated test Google accounts (not production data)
- Test with minimal Drive folder permissions
- Verify tokens are properly isolated by profile
- Test token refresh and expiry scenarios

Where to Start

- Product: see `PRODUCT_PRD.md`
- Architecture: see `TECHNICAL_ARCHITECTURE.md`
- Dev plan and milestones: see `DEVELOPMENT_PLAN.md`
