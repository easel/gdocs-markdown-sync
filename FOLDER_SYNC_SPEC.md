# Folder Synchronization Specification

## Overview

This document specifies the folder synchronization architecture for the Google Docs Markdown Sync project. The system supports bidirectional synchronization between local filesystem directories and Google Drive folders, preserving nested folder structures and maintaining document relationships across both platforms.

## Architecture

### Core Components

1. **DriveAPI (`src/drive/DriveAPI.ts`)** - Google Drive folder operations
2. **LocalStorage Interface (`src/storage/`)** - Local filesystem abstraction
3. **SyncService (`src/sync/SyncService.ts`)** - High-level sync orchestration
4. **SyncOperations (`src/sync/SyncOperations.ts`)** - Plugin-specific sync logic

### Storage Implementations

- **FilesystemStorage** (`src/storage/FilesystemStorage.ts`) - CLI filesystem operations
- **ObsidianStorage** (`src/storage/ObsidianStorage.ts`) - Obsidian vault operations

## Folder Structure Mapping

### Local to Google Drive

```
Local Filesystem                    Google Drive
├── docs/                          ├── Base Folder (configured ID)
│   ├── project/                   │   ├── project/
│   │   ├── readme.md             │   │   └── readme (Google Doc)
│   │   └── specs/                 │   │   └── specs/
│   │       └── api.md            │   │       └── api (Google Doc)
│   └── notes.md                  │   └── notes (Google Doc)
```

### Key Principles

1. **Folder Hierarchy Preservation**: Nested folder structures are maintained identically between local and remote
2. **Relative Path Mapping**: Documents store their `relativePath` from the base sync folder
3. **Folder ID Tracking**: Each Google Drive folder has a unique ID that's used for parent-child relationships
4. **Base Folder Configuration**: Both CLI and plugin require a base Google Drive folder ID for sync scope

## Implementation Details

### Google Drive Folder Operations

#### Core Methods (DriveAPI.ts)

```typescript
// Resolve folder name or ID to actual Google Drive folder ID
async resolveFolderId(folderNameOrId: string): Promise<string>

// List all documents in folder and subfolders recursively  
async listDocsInFolder(folderId: string): Promise<DriveDocument[]>

// Create a folder in Google Drive
async createFolder(parentFolderId: string | null, folderName: string): Promise<{id: string, name: string}>

// Ensure nested folder structure exists
async ensureNestedFolders(relativePath: string, baseFolderId: string): Promise<string>
```

#### Shared Drive Support

The DriveAPI automatically detects and handles both My Drive and Shared Drive contexts:

- **My Drive**: Uses default `corpora: "user"` parameter
- **Shared Drives**: Automatically detects `driveId` and uses `corpora: "drive"` with required parameters:
  - `supportsAllDrives: true`
  - `includeItemsFromAllDrives: true`
  - `driveId: [detected-shared-drive-id]`

#### Enhanced Root Detection

The system uses multiple strategies to discover documents in folders:

1. **Standard parent query**: `'folderId' in parents and trashed=false`
2. **Broad document search**: Search all accessible docs, filter by parent
3. **Shortcut resolution**: Handle Google Drive shortcuts to documents
4. **Direct document search**: Find orphaned documents that should belong to folder
5. **Aggressive audit**: Complete Drive scan for comprehensive discovery

### Local Folder Operations  

#### Base Folder Configuration

Both CLI and Obsidian plugin support base folder restrictions:

**CLI**: `--local-dir <path>` or `LOCAL_DIR` environment variable
**Plugin**: `baseVaultFolder` setting in plugin configuration

#### Path Resolution

The storage implementations handle path resolution differently:

**FilesystemStorage** (CLI):
- Works with absolute filesystem paths  
- Resolves relative paths against configured local directory
- Uses Node.js `path` module for cross-platform compatibility

**ObsidianStorage** (Plugin):
- Works with Obsidian vault-relative paths
- Normalizes paths using Obsidian's `normalizePath()` 
- Handles base folder restrictions within vault scope

### Folder Creation Logic

#### When Folders Are Created

1. **Push Operation**: When local markdown files exist in subdirectories not present in Google Drive
2. **Nested Structure**: When `ensureNestedFolders()` is called for document placement
3. **Parent-Child Requirements**: Folders are created recursively from root to target

#### Creation Process

```typescript
async ensureNestedFolders(relativePath: string, baseFolderId: string): Promise<string> {
  // 1. Split path into components: "project/specs" → ["project", "specs"]
  // 2. Start from baseFolderId and traverse/create each level
  // 3. Cache folder IDs to avoid duplicate API calls
  // 4. Return final folder ID for document creation
}
```

#### Folder Caching

The DriveAPI maintains a `folderCache` Map to optimize folder lookups:
- Key: Folder path string
- Value: Google Drive folder ID
- Prevents redundant API calls during batch operations

### Conflict Resolution

#### Folder-Level Conflicts

1. **Duplicate Folder Names**: Google Drive allows multiple folders with same name in same parent
2. **Path Resolution**: System uses folder IDs, not names, for authoritative identification
3. **Local vs Remote Structure**: Conflicts resolved based on `conflictPolicy` setting

#### Document Placement Conflicts

1. **Orphaned Documents**: Documents found in wrong folders are flagged for user review
2. **Missing Folders**: Local folders without Drive counterparts trigger folder creation
3. **Permission Issues**: Access denied folders are logged but don't block sync

### Recursive Synchronization

#### Document Discovery

```typescript
// Recursively finds all documents in folder tree
private async listDocsRecursive(
  folderId: string, 
  allDocs: DriveDocument[], 
  currentPath: string,
  context: ErrorContext
): Promise<void>
```

The recursive discovery:
1. Lists all files in current folder
2. Identifies subfolders and documents  
3. Recursively processes subfolders
4. Builds relative paths for each document
5. Handles pagination for large folders

#### Local File Discovery

```typescript
// Example from folder-sync.integration.test.ts
async function findMarkdownFiles(localPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(localPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subFiles = await findMarkdownFiles(fullPath); // Recursive
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}
```

## Edge Cases and Error Handling

### Permission Issues

1. **Insufficient Drive Permissions**: User lacks access to target folders
2. **Shared Drive Access**: User not member of shared drive
3. **Folder Creation Rights**: User can read but not create folders

**Handling**: Log warnings, continue with accessible content, surface permission errors to user

### Path Length Limitations

1. **Google Drive Limits**: Folder path length restrictions
2. **Filesystem Limits**: Windows path length limitations  
3. **Obsidian Limits**: Vault path restrictions

**Handling**: Truncate paths intelligently, warn user of modifications

### Circular References

1. **Symbolic Links**: Local filesystem symlinks creating cycles
2. **Shortcut Loops**: Google Drive shortcuts creating circular references

**Handling**: Track visited paths, detect cycles, skip problematic paths with warnings

### Large Folder Hierarchies

1. **API Rate Limiting**: Too many folder operations trigger rate limits
2. **Memory Usage**: Large folder trees consume excessive memory
3. **Sync Performance**: Deep hierarchies slow down sync operations

**Handling**: Batch operations, implement exponential backoff, paginate large folder contents

## Configuration Examples

### CLI Usage

```bash
# Sync specific local directory to Drive folder
gdocs-markdown-sync sync --drive-folder-id="1TYOD7xWenfVRrwYXqUG2KP9rpp5Juvjn" --local-dir="./docs"

# Recursive sync with watch mode
gdocs-markdown-sync sync --watch --poll-interval=30 --drive-folder-id="1TYOD7xWenfVRrwYXqUG2KP9rpp5Juvjn"

# Environment variable configuration
export DRIVE_FOLDER_ID="1TYOD7xWenfVRrwYXqUG2KP9rpp5Juvjn"
export LOCAL_DIR="./project-docs"
gdocs-markdown-sync sync
```

### Plugin Configuration

```typescript
interface GoogleDocsSyncSettings {
  driveFolderId: string;           // Target Google Drive folder ID
  baseVaultFolder: string;         // Limit sync to vault subfolder
  conflictPolicy: 'prefer-doc' | 'prefer-md' | 'merge';
  pollInterval: number;            // Background sync frequency
}
```

### Sample Folder Structure

```
Obsidian Vault                     Google Drive Folder
├── sync-folder/                  ├── (Base Folder ID: 1ABC...XYZ)
│   ├── project-1/               │   ├── project-1/
│   │   ├── overview.md          │   │   ├── overview (Doc)
│   │   ├── architecture/        │   │   └── architecture/
│   │   │   └── system.md        │   │       └── system (Doc)  
│   │   └── docs/                │   │   └── docs/
│   │       └── api.md           │   │       └── api (Doc)
│   └── project-2/               │   └── project-2/
│       └── readme.md            │       └── readme (Doc)
```

## Testing Strategy

### Unit Tests

1. **Folder ID Resolution**: Test `resolveFolderId()` with various inputs
2. **Path Normalization**: Verify cross-platform path handling
3. **Cache Behavior**: Validate folder cache prevents redundant API calls
4. **Error Conditions**: Test permission failures, invalid folder IDs

### Integration Tests

1. **End-to-End Folder Sync**: Real Google Drive folder operations
2. **Nested Structure Creation**: Test deep folder hierarchy creation
3. **Large Folder Performance**: Benchmark operations on folders with many files
4. **Shared Drive Compatibility**: Verify shared drive detection and operations

### Test Configuration

```typescript
// Integration test configuration (folder-sync.integration.test.ts)
const FOLDER_ID = process.env.FOLDER_SYNC_FOLDER_ID || '1TYOD7xWenfVRrwYXqUG2KP9rpp5Juvjn';
const LOCAL_PATH = process.env.FOLDER_SYNC_LOCAL_PATH || '../synaptiq_ops';
const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true';
```

### Running Bidirectional Sync Tests

The comprehensive folder sync integration test is available at `src/folder-sync-bidirectional.integration.test.ts`:

```bash
# Run the full bidirectional sync test suite
RUN_INTEGRATION_TESTS=true bun test src/folder-sync-bidirectional.integration.test.ts

# Run with a specific profile
RUN_INTEGRATION_TESTS=true ITEST_PROFILE=myprofile bun test src/folder-sync-bidirectional.integration.test.ts
```

This test suite validates:
- **Local-to-Remote Sync**: Complex nested structures, folder creation, document upload
- **Remote-to-Local Sync**: Document export, local file creation with frontmatter
- **Bidirectional Updates**: Concurrent modifications, conflict detection
- **Edge Cases**: Empty folders, deep nesting (5+ levels), special characters
- **Content Integrity**: Round-trip content preservation, SHA256 validation

### Test Scenarios

1. **Empty Folder Sync**: Sync operations on empty folders
2. **Deep Nesting**: Folders nested 5+ levels deep
3. **Special Characters**: Folder names with Unicode, spaces, symbols
4. **Concurrent Access**: Multiple sync operations on same folder
5. **Network Failures**: Folder operations with connection issues

## Performance Considerations

### Optimization Strategies

1. **Folder Caching**: Cache folder ID lookups to reduce API calls
2. **Batch Operations**: Group multiple folder creations into batches
3. **Lazy Loading**: Only traverse folders when documents are present
4. **Parallel Processing**: Create folders concurrently where possible

### Monitoring

1. **API Call Metrics**: Track folder-related Drive API usage
2. **Cache Hit Rates**: Monitor folder cache effectiveness  
3. **Operation Timing**: Measure folder creation and traversal performance
4. **Error Rates**: Track folder operation failure rates

### Scalability Limits

1. **Folder Depth**: Practical limit ~10 levels deep
2. **Files Per Folder**: Recommend <1000 files per folder for performance
3. **Total Folders**: Monitor memory usage for large folder counts
4. **API Quotas**: Respect Google Drive API rate limits and quotas

## Security Considerations

### Permission Model

1. **Least Privilege**: Request minimal Drive permissions required
2. **Scope Validation**: Verify user has access to target folders  
3. **Folder Isolation**: Restrict operations to configured base folder
4. **Audit Trail**: Log all folder creation and modification operations

### Data Privacy

1. **Folder Structure**: Preserve folder organization as user intent
2. **Access Logging**: Don't log sensitive folder/file names in plain text
3. **Error Messages**: Avoid exposing folder IDs in user-facing errors
4. **Cleanup**: Provide options to remove created folders during uninstall

---

This specification serves as the authoritative reference for folder synchronization behavior in the Google Docs Markdown Sync project. All implementations should conform to these specifications to ensure consistent behavior across CLI and Obsidian plugin deployments.