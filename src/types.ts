export interface GoogleDocsSyncSettings {
  driveFolderId: string;
  baseVaultFolder?: string; // folder within the vault to mirror Drive content
  conflictPolicy: 'last-write-wins' | 'prefer-doc' | 'prefer-md' | 'merge';
  pollInterval: number; // in seconds
  clientId?: string;
  clientSecret?: string;
  profile?: string; // token profile name, default 'default'
  authToken?: string;
  // Background sync settings
  backgroundSyncEnabled?: boolean; // Enable/disable background sync
  backgroundSyncSilentMode?: boolean; // Reduce notifications for background operations
  // Move and delete handling
  syncMoves?: boolean; // Enable bidirectional move sync (default: true)
  deleteHandling?: 'archive' | 'ignore' | 'sync'; // How to handle deletions (default: 'archive')
  archiveRetentionDays?: number; // Days to keep archived files (default: 30)
  showDeletionWarnings?: boolean; // Show warnings for delete operations (default: true)
  // Cross-workspace document handling
  handleCrossWorkspaceDocs?: 'auto-relink' | 'warn' | 'skip'; // How to handle docs from different workspaces (default: 'auto-relink')
  // Google Sheets settings
  syncSheets?: boolean; // Enable Google Sheets sync (default: false)
  sheetStorageFormat?: 'auto' | 'markdown' | 'csv' | 'csvy' | 'base'; // How to store sheets locally (default: 'auto')
  maxSheetRowsForMarkdown?: number; // Max rows for markdown table format (default: 50)
  maxSheetRowsForCSVY?: number; // Max rows for CSVY format (default: 500)
  preserveSheetFormulas?: boolean; // Preserve formulas on Google Sheets (default: true)
}

export interface GoogleDocsSyncPluginData {
  authToken?: string;
  tokenExpiry?: number;
  refreshToken?: string;
}

export interface FrontMatter {
  docId?: string;
  revisionId?: string;
  sha256?: string;
  // Enhanced tracking for moves and sync state
  'google-doc-id'?: string;
  'google-doc-url'?: string;
  'google-doc-title'?: string;
  'last-synced'?: string;
  'last-sync-path'?: string; // Track file path at last sync for move detection
  'sync-revision'?: number; // Track sync state version
  'deletion-scheduled'?: string; // When file is scheduled for deletion
  other?: Record<string, any>;
}

export interface ConflictResolutionResult {
  mergedContent: string;
  hasConflicts: boolean;
  conflictMarkers: string[];
}

export interface SyncFileState {
  id: string; // google-doc-id
  localPath: string; // Current local file path
  remotePath: string; // Current remote path (derived from Drive folder structure)
  lastSyncPath?: string; // Path at last sync (for move detection)
  lastSyncRevision: number; // Sync state version
  isDeleted: boolean; // Whether file is marked for deletion
  deletedAt?: Date; // When deletion was detected
  movedFrom?: string; // Previous path if this is a move operation
  operationType?: 'none' | 'create' | 'update' | 'move' | 'delete'; // Pending operation
}

export interface MoveOperation {
  type: 'local-to-remote' | 'remote-to-local';
  fileId: string; // google-doc-id
  oldPath: string;
  newPath: string;
  timestamp: Date;
}

export interface DeleteOperation {
  type: 'local-delete' | 'remote-delete';
  fileId: string; // google-doc-id
  filePath: string;
  timestamp: Date;
  archivePath?: string; // Where the file was archived
}

export interface SyncOperation {
  id: string; // unique operation ID
  type: 'move' | 'delete' | 'create' | 'update';
  fileId: string; // google-doc-id
  source: 'local' | 'remote';
  details: MoveOperation | DeleteOperation | any;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  timestamp: Date;
  error?: string;
}

export interface SyncSummary {
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  archived: number;
  skipped: number;
  conflicted: number;
  errors: number;
  total: number;
  operations: SyncOperation[];
}
