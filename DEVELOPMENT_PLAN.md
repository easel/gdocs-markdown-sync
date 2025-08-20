# Development Plan

## Alignment with Product Requirements

This development plan bridges the current technical implementation (detailed in TECHNICAL_ARCHITECTURE.md) with the complete product vision (defined in PRODUCT_PRD.md). All work items directly support achieving the user stories, acceptance criteria, and functional requirements outlined in the PRD.

## Current Implementation Status

### ✅ Production-Ready Foundation
The codebase provides a solid v1.0 foundation supporting core PRD requirements:

#### Technical Infrastructure (COMPLETE)
- **Dual architecture**: CLI (Bun/Node.js) and Obsidian plugin from shared TypeScript codebase
- **OAuth flows**: PKCE for CLI, standard OAuth for plugin with profile-aware token storage  
- **Network resilience**: Retry logic, timeouts, rate limiting, comprehensive error handling
- **Production tooling**: Full CI pipeline with typecheck, lint, tests, format checks
- **Structured logging**: Multi-level logging with correlation IDs and performance metrics
- **Configuration management**: Centralized config with environment integration

#### Core Functionality (FUNCTIONAL)
- **Bidirectional sync**: Google Docs ↔ Markdown with YAML frontmatter preservation
- **State management**: 3-way merge foundation using `docId`, `revisionId`, `sha256` + Drive appProperties
- **CLI commands**: `auth`, `pull`, `push`, `sync` all implemented and functional
- **Plugin integration**: Settings UI, Command Palette commands, background polling operational

## Priority Development Work

### 🔴 Critical - Production Readiness

#### 1. Conflict Resolution Implementation
**PRD Requirement**: "Resolve conflicts via policy: prefer-doc, prefer-md; merge mode" + "Clear visual indicators for manual resolution"
**Current Status**: Hooks exist, logic is placeholder stubs
- Replace conflict policy stubs with real 3-way merge using `revisionId` + `sha256`
- Implement `prefer-doc`/`prefer-md` with clear precedence rules per PRD acceptance criteria
- Create meaningful conflict markers for `merge` policy with user-actionable format
- Add comprehensive conflict scenario tests (unit + integration)

#### 2. Plugin Packaging & Distribution
**PRD Requirement**: "Simple package manager installation and plugin deployment"
**Current Status**: Build inconsistencies, manual deployment
- **Fix build target confusion**: Standardize on `dist/main.js` (not `src/main.js`) per architecture
- **Unified packaging**: Create `bun run package:plugin` that produces ready-to-install plugin folder
- **Documentation alignment**: Update all docs to reference consistent build artifacts
- **Release automation**: Plugin zip generation with GitHub releases

#### 3. Obsidian Plugin Auth UX
**PRD Requirement**: "Complete OAuth in my default browser and return to Obsidian seamlessly" + "Clear feedback when authentication succeeds or fails"
**Current Status**: Works but brittle, poor error handling
- Replace `child_process` browser opening with Obsidian's `openExternal()`
- Add in-app modal with clickable auth URL fallback for restrictive environments
- Implement robust token refresh error handling with "Re-authenticate" notices
- Settings validation: disable auth flow when Client ID/Secret missing per PRD interface specs

### 🟡 Important - Feature Completeness

#### 4. Background Sync Reliability
**Status**: Basic polling exists, needs guardrails
- **Reentrancy protection**: Prevent overlapping sync operations with proper locking
- **Error backoff**: Implement exponential backoff on Drive API failures
- **User control**: Settings toggle for background sync enable/disable
- **Performance optimization**: Debounce rapid file changes, batch operations

#### 5. CLI/Plugin Feature Parity
**PRD Requirement**: Core sync operations must be equivalent between CLI and plugin
**Current Status**: Plugin lacks some CLI feedback features
- **Operation summaries**: Show created/updated/skipped/conflicted counts in notices per PRD user stories
- **Better error reporting**: Surface Drive API errors and network issues clearly per PRD error handling requirements
- **Settings validation**: Ensure plugin settings validation matches CLI flag validation

#### 6. Code Consolidation & Maintainability
**Status**: Some duplication between CLI/plugin
- **Frontmatter utilities**: Plugin should use `src/fs/frontmatter.ts` instead of inline parsing
- **Name sanitization**: Ensure CLI and plugin use identical filename sanitization logic
- **Shared error handling**: Consolidate Drive client error handling patterns
- **Test coverage**: Expand integration tests for edge cases (empty docs, large docs, network failures)

### 🟢 Enhancement - Future Improvements

#### 7. Advanced Sync Features
- **Drive Changes API**: Replace polling with webhook-based change detection for lower latency
- **Selective sync**: Allow users to choose specific docs/folders within Drive folder
- **Conflict resolution UI**: Visual diff tool for manual merge decisions
- **Batch operations**: Optimize multiple file operations with concurrent processing

#### 8. Content & Asset Support
- **Image handling**: Preserve images in Docs ↔ MD workflows with asset management
- **Rich formatting**: Better handling of tables, lists, formatting preservation
- **Attachment support**: Sync linked files and embedded content
- **Comment preservation**: Maintain Google Docs comments in Markdown format

#### 9. Integration & Automation
- **GitHub Actions**: Automated Docs → MD export for documentation workflows
- **CI/CD integration**: Plugin for automated documentation sync in build pipelines
- **Webhook support**: Real-time sync triggers from Google Drive changes
- **Multiple vault support**: Obsidian plugin support for multiple vault configurations

#### 10. Developer Experience & Operations
- **NPM publication**: Publish CLI tool to npm registry for easy installation
- **Plugin marketplace**: Submit to Obsidian Community Plugins
- **Telemetry**: Optional usage analytics for understanding common workflows
- **Performance monitoring**: Built-in performance metrics and optimization insights

## Implementation Timeline

### Phase 1: Production Stability (2-3 weeks)
*Priority: Achieve PRD v1.0 release criteria*
1. Conflict resolution implementation (PRD: conflict policies functional)
2. Plugin packaging standardization (PRD: simple deployment)
3. Obsidian auth UX improvements (PRD: seamless OAuth flow)
4. Background sync guardrails (PRD: non-blocking operations)

### Phase 2: Feature Completeness (2-3 weeks) 
*Priority: Complete PRD functional requirements*
1. CLI/Plugin feature parity (PRD: equivalent user experiences)
2. Code consolidation (Architecture: shared component usage)
3. Comprehensive testing (PRD: high coverage requirement)

### Phase 3: Advanced Features (Ongoing)
*Priority: PRD "Future" section + enhanced user experience*
1. Advanced sync capabilities (PRD: robust 3-way merge)
2. Content & asset support (PRD: image handling strategy)  
3. Integration & automation (PRD: Drive changes API)
4. Developer experience improvements (Architecture: NPM publication)

## Success Criteria

- **Reliability**: Zero data loss in conflict scenarios, robust error recovery
- **User Experience**: Clear error messages, intuitive conflict resolution, smooth auth flow
- **Performance**: Sub-second sync for typical document sizes, efficient polling
- **Maintainability**: Single source of truth for shared logic, comprehensive test coverage
- **Distribution**: Easy installation for both CLI and plugin users

## Risk Mitigation

- **Backward compatibility**: Careful migration of token storage and frontmatter formats
- **Google API limits**: Implement proper rate limiting and quota management  
- **Platform differences**: Test auth flows across different OS environments
- **Data integrity**: Comprehensive testing of edge cases and error scenarios

---

*This plan consolidates remaining work from the original development plan and Obsidian plugin evaluation. Focus on production readiness before adding new features.*