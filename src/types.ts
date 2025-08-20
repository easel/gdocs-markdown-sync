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
  other?: Record<string, string>;
}

export interface ConflictResolutionResult {
  mergedContent: string;
  hasConflicts: boolean;
  conflictMarkers: string[];
}
