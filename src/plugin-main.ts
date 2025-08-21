import { Plugin, TFile, Notice, Menu, WorkspaceLeaf, MarkdownView, Modal } from 'obsidian';

import { PluginAuthManager } from './auth/PluginAuthManager';
import { UnifiedOAuthManager } from './auth/UnifiedOAuthManager';
import { DriveAPI, GoogleDocInfo } from './drive/DriveAPI';
import { parseFrontMatter, buildFrontMatter } from './fs/frontmatter';
import { GoogleDocsSyncSettingsTab } from './settings';
import { SyncErrorClassifier } from './sync/BackgroundSyncErrors';
import { BackgroundSyncManager } from './sync/BackgroundSyncManager';
import { ConflictResolver } from './sync/ConflictResolver';
import { SyncService, createSyncService } from './sync/SyncService';
import { SyncStatusManager } from './sync/SyncStatusManager';
import { SyncUtils, FrontMatter } from './sync/SyncUtils';
import { GoogleDocsSyncSettings as ImportedSettings, SyncFileState, MoveOperation } from './types';
import { ErrorUtils, BaseError } from './utils/ErrorUtils';
import { getBuildVersion, VERSION_INFO } from './version';

// Ensure version info is available at runtime
const PLUGIN_VERSION = getBuildVersion();
const PLUGIN_VERSION_DETAILS = VERSION_INFO;

interface GoogleDocsSyncSettings extends ImportedSettings {
  // Plugin-specific extensions can be added here
}

interface SyncState {
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
  hasLocalMove: boolean;
  hasRemoteMove: boolean;
  hasLocalDelete: boolean;
  hasRemoteDelete: boolean;
  localMoveFrom?: string;
  remoteMoveFrom?: string;
  deleteReason?: 'local-deleted' | 'remote-deleted' | 'remote-trashed';
  remoteDeletedAt?: Date;
}

interface OperationSummary {
  created: number;
  updated: number;
  skipped: number;
  conflicted: number;
  errors: number;
  total: number;
}

interface EnhancedNotice {
  notice: Notice;
  update: (message: string) => void;
  hide: () => void;
}

// DEPRECATED: Use src/fs/frontmatter.ts instead
// This function is kept for backward compatibility but will be removed
function parseBasicYaml(frontmatterText: string): Record<string, any> {
  console.warn('parseBasicYaml is deprecated, use parseFrontMatter from src/fs/frontmatter.ts');
  // Fallback to old implementation for now
  const frontmatter: Record<string, any> = {};
  const lines = frontmatterText.split('\n');
  let currentKey: string | null = null;
  let currentValue = '';
  let inMultiline = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    // Check for key-value pattern
    const colonIndex = trimmedLine.indexOf(':');
    if (colonIndex > 0 && !inMultiline) {
      // Save previous key if exists
      if (currentKey) {
        frontmatter[currentKey] = parseYamlValue(currentValue.trim());
      }

      currentKey = trimmedLine.substring(0, colonIndex).trim();
      currentValue = trimmedLine.substring(colonIndex + 1).trim();

      // Check if this is a multiline value
      inMultiline = currentValue.includes('|') || currentValue.includes('>');
      if (inMultiline) {
        currentValue = currentValue.replace(/[|>]/, '').trim();
      }
    } else if (inMultiline && currentKey) {
      // Continue multiline value
      currentValue += '\n' + line;
    }
  }

  // Save last key
  if (currentKey) {
    frontmatter[currentKey] = parseYamlValue(currentValue.trim());
  }

  return frontmatter;
}

function parseYamlValue(value: string): any {
  if (!value) return '';

  // Handle quoted strings
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Handle booleans
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Handle numbers
  if (/^-?\d+\.?\d*$/.test(value)) {
    return value.includes('.') ? parseFloat(value) : parseInt(value);
  }

  // Handle arrays (basic)
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

// DEPRECATED: Use src/fs/frontmatter.ts instead
// This function is kept for backward compatibility but will be removed
function serializeBasicYaml(obj: Record<string, any>, indent = ''): string {
  console.warn('serializeBasicYaml is deprecated, use buildFrontMatter from src/fs/frontmatter.ts');
  // Fallback to old implementation for now
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result += `${indent}${key}: null\n`;
    } else if (typeof value === 'boolean') {
      result += `${indent}${key}: ${value}\n`;
    } else if (typeof value === 'number') {
      result += `${indent}${key}: ${value}\n`;
    } else if (typeof value === 'string') {
      // Handle multiline strings
      if (value.includes('\n')) {
        result += `${indent}${key}: |\n`;
        const lines = value.split('\n');
        for (const line of lines) {
          result += `${indent}  ${line}\n`;
        }
      } else if (
        value.includes(':') ||
        value.includes('#') ||
        value.includes('[') ||
        value.includes(']') ||
        value.includes('{') ||
        value.includes('}')
      ) {
        // Quote strings with special characters
        result += `${indent}${key}: "${value.replace(/"/g, '\\"')}"\n`;
      } else {
        result += `${indent}${key}: ${value}\n`;
      }
    } else if (Array.isArray(value)) {
      result += `${indent}${key}:\n`;
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          result += `${indent}  -\n`;
          result += serializeBasicYaml(item, indent + '    ');
        } else {
          result += `${indent}  - ${item}\n`;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      result += `${indent}${key}:\n`;
      result += serializeBasicYaml(value, indent + '  ');
    }
  }

  return result;
}

class ChangeDetector {
  private plugin: GoogleDocsSyncPlugin;

  constructor(plugin: GoogleDocsSyncPlugin) {
    this.plugin = plugin;
  }

  async detectChanges(file: TFile): Promise<SyncState> {
    const metadata = await this.plugin.getGoogleDocsMetadata(file);
    if (!metadata) {
      return { 
        hasLocalChanges: false, 
        hasRemoteChanges: false,
        hasLocalMove: false,
        hasRemoteMove: false,
        hasLocalDelete: false,
        hasRemoteDelete: false
      };
    }

    const lastSynced = new Date(metadata.lastSynced);
    const localMtime = new Date(file.stat.mtime);

    // Check for local changes (file modified after last sync)
    const hasLocalChanges = localMtime > lastSynced;

    // Check for remote changes and deletions
    let hasRemoteChanges = false;
    let hasRemoteDelete = false;
    let deleteReason: 'remote-deleted' | 'remote-trashed' | undefined;
    let remoteDeletedAt: Date | undefined;

    try {
      if (metadata.id) {
        const driveAPI = await this.plugin.getAuthenticatedDriveAPI();
        
        // Check if the Google Doc still exists
        const fileInfo = await driveAPI.getFile(metadata.id);
        
        if (!fileInfo) {
          // File completely deleted
          hasRemoteDelete = true;
          deleteReason = 'remote-deleted';
          remoteDeletedAt = new Date();
        } else if (fileInfo.trashed) {
          // File moved to trash
          hasRemoteDelete = true;
          deleteReason = 'remote-trashed';
          remoteDeletedAt = new Date(fileInfo.modifiedTime);
        } else {
          // File exists, check for normal changes
          hasRemoteChanges = await this.plugin.hasRemoteChanges(metadata.id, metadata.lastSynced);
        }
      }
    } catch (error) {
      console.warn('Failed to check remote file status:', error);
    }

    // Check for local move (file path changed since last sync)
    const hasLocalMove = metadata.lastSyncPath && metadata.lastSyncPath !== file.path;
    const localMoveFrom = hasLocalMove ? metadata.lastSyncPath : undefined;

    // Check for remote move (only if file still exists)
    let hasRemoteMove = false;
    let remoteMoveFrom: string | undefined;
    
    // TODO: Temporarily disable remote move detection due to false positives
    // The issue is comparing actual Google Doc names with calculated expected names
    // which don't always match (especially for files with spaces/special chars)
    try {
      if (false && this.plugin.settings.syncMoves && metadata.id && !hasRemoteDelete) {
        const driveAPI = await this.plugin.getAuthenticatedDriveAPI();
        
        // Get relative path from the base drive folder
        const baseFolderId = await this.plugin.resolveDriveFolderId();
        const currentRemotePath = await driveAPI.getFilePath(metadata.id, baseFolderId);
        const expectedRemotePath = this.plugin.calculateExpectedRemotePath(file.path);
        
        console.log(`Move detection for ${file.path}: current="${currentRemotePath}", expected="${expectedRemotePath}"`);
        
        if (currentRemotePath !== expectedRemotePath) {
          hasRemoteMove = true;
          remoteMoveFrom = currentRemotePath;
          console.log(`Move detected: "${currentRemotePath}" → "${expectedRemotePath}"`);
        }
      }
    } catch (error) {
      console.warn('Failed to check for remote move:', error);
    }

    // Local delete detection (file exists in our tracking but not in vault)
    // This will be handled at a higher level during sync enumeration

    return { 
      hasLocalChanges, 
      hasRemoteChanges,
      hasLocalMove,
      hasRemoteMove,
      hasLocalDelete: false, // Will be set during sync enumeration
      hasRemoteDelete,
      localMoveFrom,
      remoteMoveFrom,
      deleteReason,
      remoteDeletedAt
    };
  }
}

export default class GoogleDocsSyncPlugin extends Plugin {
  settings!: GoogleDocsSyncSettings;
  private changeDetector!: ChangeDetector;
  private syncService!: SyncService;
  public backgroundSyncManager!: BackgroundSyncManager;
  public syncStatusManager!: SyncStatusManager;
  private headerActions: Map<string, HTMLElement> = new Map();
  private statusBarItem!: HTMLElement;
  private updateTimeout: number | null = null;
  private currentOperations: Map<string, EnhancedNotice> = new Map();
  private authManager!: PluginAuthManager;
  private driveAPICache: { api: DriveAPI; timestamp: number } | null = null;
  private readonly DRIVE_API_CACHE_TTL = 60000; // 1 minute cache
  private workspaceInfo: { 
    email: string; 
    displayName: string; 
    domain: string; 
    lastVerified: Date;
    folderAccess?: {
      folderId: string;
      folderName: string;
      documentCount: number;
    };
  } | null = null;
  async onload() {
    console.log(`🚀 Loading Google Docs Sync plugin ${PLUGIN_VERSION}`);
    console.log(`📊 Plugin Details: version=${PLUGIN_VERSION_DETAILS.version}, commit=${PLUGIN_VERSION_DETAILS.commit}, dirty=${PLUGIN_VERSION_DETAILS.isDirty}, buildTime=${PLUGIN_VERSION_DETAILS.buildTime}`);

    await this.loadSettings();

    // Initialize auth manager with plugin instance for token storage
    this.authManager = new PluginAuthManager(this.settings.profile, this);

    // Register OAuth callback handler for iOS client redirect using centralized config
    const tokenStorage = this.authManager.getTokenStorage();
    const tempOAuthManager = new UnifiedOAuthManager(tokenStorage, { isPlugin: true });
    const protocolPath = tempOAuthManager.getProtocolHandlerPath();
    
    if (protocolPath) {
      this.registerObsidianProtocolHandler(protocolPath, 
        async (params) => {
          await this.handleOAuthCallback(params);
        });
    }

    // Verify workspace and token validity on startup
    await this.verifyWorkspaceAndToken();

    this.changeDetector = new ChangeDetector(this);
    this.syncService = createSyncService(this.settings);

    // Add settings tab
    this.addSettingTab(new GoogleDocsSyncSettingsTab(this.app, this));

    // Initialize background sync manager and status manager
    this.syncStatusManager = new SyncStatusManager();
    this.backgroundSyncManager = new BackgroundSyncManager(
      this.app,
      this.syncService,
      this.settings,
      {
        enabled: this.settings.backgroundSyncEnabled === true,
        silentMode: this.settings.backgroundSyncSilentMode === true,
      },
    );

    // Add status bar item for overall sync status
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('Google Docs Sync');
    this.statusBarItem.addClass('google-docs-status');
    this.statusBarItem.onClickEvent(async () => {
      console.log('🖱️ Status bar clicked, starting sync...');
      try {
        await this.syncAllDocuments();
      } catch (error) {
        console.error('❌ Sync failed:', error);
        new Notice(`Sync failed: ${error.message}`);
      }
    });

    // Connect status bar to sync status manager
    this.syncStatusManager.setStatusBarElement(this.statusBarItem);

    // Add context menu to status bar item
    this.registerDomEvent(this.statusBarItem, 'contextmenu', (evt) => {
      evt.preventDefault();
      this.showStatusBarMenu(evt);
    });

    // Add commands
    this.addCommand({
      id: 'push-all-docs',
      name: 'Push all documents to Google Docs',
      callback: () => this.pushAllDocs(),
    });

    this.addCommand({
      id: 'pull-all-docs',
      name: 'Pull all documents from Google Docs',
      callback: () => this.pullAllDocs(),
    });

    this.addCommand({
      id: 'sync-current-doc',
      name: 'Smart sync current document',
      callback: () => this.smartSyncCurrentDoc(),
    });

    this.addCommand({
      id: 'toggle-background-sync',
      name: 'Toggle background sync',
      callback: () => this.toggleBackgroundSync(),
    });

    this.addCommand({
      id: 'force-background-sync',
      name: 'Force background sync now',
      callback: () => this.forceBackgroundSync(),
    });

    this.addCommand({
      id: 'sync-all-documents',
      name: 'Sync all documents (bidirectional)',
      callback: () => this.syncAllDocuments(),
    });

    this.addCommand({
      id: 'show-sync-status',
      name: 'Show sync status',
      callback: () => this.showSyncStatus(),
    });

    this.addCommand({
      id: 'show-trash',
      name: 'Show Sync Trash',
      callback: () => this.showTrashFolder(),
    });

    this.addCommand({
      id: 'empty-trash',
      name: 'Empty Sync Trash',
      callback: () => this.emptyTrash(),
    });

    this.addCommand({
      id: 'restore-from-trash',
      name: 'Restore File from Trash',
      callback: () => this.showRestoreModal(),
    });

    this.addCommand({
      id: 'clean-cross-workspace-links',
      name: 'Clean Cross-Workspace Document Links',
      callback: () => this.cleanCrossWorkspaceLinks(),
    });

    this.addCommand({
      id: 'migrate-misplaced-folders',
      name: 'Migrate Misplaced Folders to Correct Location',
      callback: () => this.migrateMisplacedFolders(),
    });

    this.addCommand({
      id: 'diagnose-workspace-access',
      name: 'Diagnose Workspace & Document Access',
      callback: () => this.diagnoseWorkspaceAccess(),
    });

    this.addCommand({
      id: 'switch-to-document-folder',
      name: 'Switch to Folder Where Documents Are Located',
      callback: () => this.switchToDocumentFolder(),
    });

    // Add context menu items
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.addContextMenuItems(menu, file);
        }
      }),
    );

    // Monitor active leaf changes to manage header action
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        this.updateHeaderAction(leaf);
      }),
    );

    // Monitor layout changes (new tabs, split views)
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        // Delay to let DOM settle
        setTimeout(() => {
          const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (activeLeaf) {
            this.updateHeaderAction(activeLeaf.leaf);
          }
        }, 50);
      }),
    );

    // Monitor file opens
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && file.extension === 'md') {
          setTimeout(() => {
            const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeLeaf) {
              this.updateHeaderAction(activeLeaf.leaf);
            }
          }, 100);
        }
      }),
    );

    // File change monitoring for background sync
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.backgroundSyncManager.queueFile(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          // Delay to allow frontmatter to be added
          setTimeout(() => {
            this.backgroundSyncManager.queueFile(file);
          }, 1000);
        }
      }),
    );

    // Initial header action setup
    setTimeout(() => {
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    }, 100);

    // Setup plugin integration for background sync
    this.backgroundSyncManager.setPluginIntegration({
      performSmartSync: async (file: TFile) => {
        try {
          await this.performSmartSync(file);
        } catch (error) {
          // Convert to classified sync error
          const syncError = SyncErrorClassifier.classifyError(error as Error, {
            operation: 'background_sync',
            filePath: file.path,
          });
          this.syncStatusManager.handleSyncError(syncError, file.name);
          throw syncError;
        }
      },
      hasGoogleDocsMetadata: (file: TFile) => {
        return !!this.getGoogleDocsMetadataSync(file);
      },
    });

    // Start background sync
    if (this.settings.backgroundSyncEnabled === true) {
      this.backgroundSyncManager.start();
    }

    new Notice(`Google Docs Sync plugin loaded (${PLUGIN_VERSION})`);
  }

  /**
   * Verify workspace and token validity on startup
   * Logs workspace information to help diagnose authentication issues
   */
  private async verifyWorkspaceAndToken(): Promise<void> {
    try {
      console.log('🔐 Verifying workspace and token validity...');
      
      // Get authenticated Drive API instance
      const driveAPI = await this.getAuthenticatedDriveAPI();
      
      // Test basic API access by getting user info from Drive
      console.log('📊 Testing Drive API access...');
      const testResponse = await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
        headers: {
          'Authorization': `Bearer ${driveAPI.getAccessToken()}`,
        },
      });
      
      if (testResponse.ok) {
        const userInfo = await testResponse.json();
        console.log('✅ Authentication successful!');
        console.log(`👤 Authenticated as: ${userInfo.user?.displayName || 'Unknown'} (${userInfo.user?.emailAddress || 'Unknown email'})`);
        
        // Store workspace information
        const email = userInfo.user?.emailAddress || 'Unknown email';
        const displayName = userInfo.user?.displayName || 'Unknown';
        const domain = email.includes('@') ? email.split('@')[1] : 'Unknown domain';
        
        this.workspaceInfo = {
          email,
          displayName,
          domain,
          lastVerified: new Date()
        };
        
        console.log(`🏢 Workspace Domain: ${domain}`);
        console.log(`🆔 Workspace Email: ${email}`);
        
        // Test access to configured folder if available
        if (this.settings.driveFolderId && this.settings.driveFolderId.trim() !== '') {
          try {
            console.log(`📁 Testing access to configured folder: ${this.settings.driveFolderId}`);
            const folderInfo = await driveAPI.getFile(this.settings.driveFolderId);
            console.log(`✅ Folder accessible: "${folderInfo.name || 'Unnamed folder'}" (${this.settings.driveFolderId})`);
            console.log(`📊 Folder metadata:`, {
              id: folderInfo.id,
              name: folderInfo.name,
              parents: folderInfo.parents || [],
              mimeType: folderInfo.mimeType,
              modifiedTime: folderInfo.modifiedTime,
              driveId: folderInfo.driveId
            });
            
            // Store folder access information
            if (this.workspaceInfo) {
              this.workspaceInfo.folderAccess = {
                folderId: this.settings.driveFolderId,
                folderName: folderInfo.name || 'Unnamed folder',
                documentCount: 0 // Will be updated below
              };
            }
            
            // Test specific document search within this folder
            console.log(`🔍 Testing document search within folder...`);
            try {
              const testDocs = await driveAPI.listDocsInFolder(this.settings.driveFolderId);
              console.log(`📄 Found ${testDocs.length} documents in folder via listDocsInFolder`);
              
              // Update document count
              if (this.workspaceInfo?.folderAccess) {
                this.workspaceInfo.folderAccess.documentCount = testDocs.length;
              }
              
              // Search specifically for "The Synaptitudes"
              console.log(`🎯 Searching specifically for "The Synaptitudes" document...`);
              const searchResults = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent('name contains "Synaptitudes"')}&fields=files(id,name,parents,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
                headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
              });
              const searchData = await searchResults.json();
              console.log(`🔎 Search results for "Synaptitudes":`, searchData.files || []);
              
              // Investigate specific documents mentioned in logs that have wrong parents
              console.log(`🔍 Investigating specific documents with wrong parent IDs...`);
              const problematicDocIds = [
                '1mb9LbmIddZJMG8qwQfwwTRA0L5P9qS2oRceNEncrPHY', // AGENTS
                '1axapQBfsY45J3QaKf_CjJL0xZMZN9Hf6VovSWDFZNa4', // README
                '18dEGqLFKfAIYl7p4z_2nb9s8cGNuvGcvWE0AG4JO4Ec', // obsidian-google-docs-workflow
                '1oO6tSfJx4CZ3hYd0a4v-xg-kBazkXafd-gL6w1lSwY4', // SECURITY
              ];
              await driveAPI.investigateDocumentParents(problematicDocIds);
              
            } catch (searchError) {
              console.warn(`⚠️ Error during document search:`, searchError);
            }
            
          } catch (error) {
            console.warn(`⚠️  Cannot access configured folder ${this.settings.driveFolderId}:`, error);
            console.log('💡 This may indicate the folder is in a different workspace or the folder ID is incorrect');
            
            // Additional diagnostic - try to understand the error better
            if (error instanceof Error) {
              console.log(`🔍 Error details:`, {
                message: error.message,
                name: error.name,
                stack: error.stack?.split('\n').slice(0, 3)
              });
            }
          }
        } else {
          console.log('ℹ️  No Drive folder configured yet');
        }
        
      } else {
        console.error('❌ Authentication failed:', testResponse.status, testResponse.statusText);
        console.log('💡 Token may be invalid or expired. Try reauthenticating in plugin settings.');
      }
      
    } catch (error) {
      console.error('❌ Workspace verification failed:', error);
      console.log('💡 This may indicate authentication issues. Check plugin settings and reauth if needed.');
    }
  }

  async onunload() {
    console.log(`🛑 Unloading Google Docs Sync plugin ${PLUGIN_VERSION}`);

    // Stop and cleanup background sync
    if (this.backgroundSyncManager) {
      this.backgroundSyncManager.destroy();
    }

    // Clean up header actions
    this.headerActions.forEach((action, _fileId: string) => {
      if (action && action.parentNode) {
        action.parentNode.removeChild(action);
      }
    });
    this.headerActions.clear();
  }

  async loadSettings() {
    const DEFAULT_SETTINGS: GoogleDocsSyncSettings = {
      driveFolderId: '',
      baseVaultFolder: '',
      conflictPolicy: 'last-write-wins',
      pollInterval: 60,
      backgroundSyncEnabled: false,
      backgroundSyncSilentMode: false,
      // Move and delete handling defaults
      syncMoves: true, // Enable bidirectional move sync by default
      deleteHandling: 'archive', // Archive deletes by default (safe)
      archiveRetentionDays: 30, // Keep archived files for 30 days
      showDeletionWarnings: true, // Show warnings for delete operations
      // Public OAuth Client - Intentionally committed for desktop/plugin use
      // gitleaks:allow
      clientId: '181003307316-5devin5s9sh5tmvunurn4jh4m6m8p89v.apps.googleusercontent.com',
      // gitleaks:allow
      clientSecret: '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',
    };

    this.settings = Object.assign(DEFAULT_SETTINGS, await this.loadData());

    // Validate settings after loading
    this.validateSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);

    // Update sync service with new settings
    this.syncService = createSyncService(this.settings);

    // Update auth manager profile if changed
    if (this.authManager) {
      this.authManager = new PluginAuthManager(this.settings.profile, this);
    }

    // Update background sync manager settings
    if (this.backgroundSyncManager) {
      this.backgroundSyncManager.updateSettings(this.settings, {
        enabled: this.settings.backgroundSyncEnabled === true,
        silentMode: this.settings.backgroundSyncSilentMode === true,
      });
    }
  }

  updateHeaderAction(leaf: WorkspaceLeaf | null): void {
    // Throttle rapid calls - cancel previous update if still pending
    if (this.updateTimeout) {
      window.clearTimeout(this.updateTimeout);
    }

    this.updateTimeout = window.setTimeout(async () => {
      // BRUTALLY remove ALL sync actions with multiple selectors
      const selectors = [
        '[aria-label*="Google Docs Sync"]',
        '.sync-icon',
        '[title*="Google Docs Sync"]',
        '[data-sync-action="true"]',
        'div[class*="sync"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach((element) => {
          try {
            // Only remove if it looks like our sync action
            if (
              element.getAttribute('aria-label')?.includes('Google Docs') ||
              element.classList.contains('sync-icon') ||
              element.getAttribute('data-sync-action') === 'true'
            ) {
              element.remove();
            }
          } catch (e) {
            // Ignore errors
          }
        });
      }

      // Clear our tracking
      this.headerActions.clear();

      // Small delay to ensure DOM is clean
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now add exactly ONE action to the current active view if it's markdown
      if (leaf?.view?.getViewType() === 'markdown' && (leaf.view as MarkdownView).file) {
        const markdownView = leaf.view as MarkdownView;
        const file = markdownView.file;
        if (file) {
          const syncState = await this.changeDetector.detectChanges(file);
          const headerAction = markdownView.addAction(
            'sync',
            'Google Docs Sync',
            async (_evt: MouseEvent) => {
              await this.performSmartSync(file);
            },
          );

          // Add multiple identifiers for cleanup
          headerAction.addClass('sync-icon');
          headerAction.setAttribute('data-sync-action', 'true');
          headerAction.setAttribute('data-plugin', 'google-docs-sync');

          // Update icon based on sync state
          this.updateHeaderActionIcon(headerAction, syncState);

          // Store reference
          this.headerActions.set(file.path, headerAction);
        }
      }

      this.updateTimeout = null;
    }, 100); // 100ms debounce
  }

  updateHeaderActionIcon(action: HTMLElement, syncState: SyncState): void {
    // Remove existing classes
    action.classList.remove('sync-none', 'sync-local', 'sync-remote', 'sync-both', 'sync-move');

    const hasContentChanges = syncState.hasLocalChanges || syncState.hasRemoteChanges;
    const hasMoves = syncState.hasLocalMove || syncState.hasRemoteMove;
    const hasBothContentChanges = syncState.hasLocalChanges && syncState.hasRemoteChanges;
    const hasBothMoves = syncState.hasLocalMove && syncState.hasRemoteMove;

    // Build status message
    let statusParts: string[] = [];
    if (syncState.hasLocalChanges) statusParts.push('local changes');
    if (syncState.hasRemoteChanges) statusParts.push('remote changes');
    if (syncState.hasLocalMove) statusParts.push('local move');
    if (syncState.hasRemoteMove) statusParts.push('remote move');

    if (hasBothContentChanges || hasBothMoves || (hasContentChanges && hasMoves)) {
      action.classList.add('sync-both');
      action.setAttribute('aria-label', `Conflicts: ${statusParts.join(', ')}`);
    } else if (hasMoves && !hasContentChanges) {
      action.classList.add('sync-move');
      action.setAttribute('aria-label', `Move detected: ${statusParts.join(', ')}`);
    } else if (syncState.hasLocalChanges || syncState.hasLocalMove) {
      action.classList.add('sync-local');
      action.setAttribute('aria-label', `Push: ${statusParts.join(', ')}`);
    } else if (syncState.hasRemoteChanges || syncState.hasRemoteMove) {
      action.classList.add('sync-remote');
      action.setAttribute('aria-label', `Pull: ${statusParts.join(', ')}`);
    } else {
      action.classList.add('sync-none');
      action.setAttribute('aria-label', 'No changes to sync');
    }
  }

  async performSmartSync(file: TFile): Promise<void> {
    // No notice for individual file sync - status bar shows progress

    try {
      // Validate settings before proceeding
      if (!this.settings.driveFolderId || this.settings.driveFolderId.trim() === '') {
        throw new Error('Google Drive folder not configured. Please set the Drive folder ID in plugin settings.');
      }

      // Get current file content and metadata
      const content = await this.app.vault.read(file);
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);

      // Get authentication
      const authClient = await this.authManager.getAuthClient();
      const driveAPI = new DriveAPI(authClient.credentials.access_token);

      // Find or create the Google Doc using folder-based strategy
      const googleDocInfo = await this.findOrCreateGoogleDoc(file, driveAPI, frontmatter);
      
      if (!googleDocInfo) {
        throw new Error('Failed to find or create Google Doc');
      }

      // Update frontmatter with Google Doc information and enhanced tracking
      let updatedFrontmatter = frontmatter;
      const isNewLink = !frontmatter['google-doc-id'] || frontmatter['google-doc-id'] !== googleDocInfo.id;
      const pathChanged = frontmatter['last-sync-path'] && frontmatter['last-sync-path'] !== file.path;
      
      if (isNewLink || pathChanged) {
        const currentRevision = (frontmatter['sync-revision'] || 0) + 1;
        
        updatedFrontmatter = {
          ...frontmatter,
          'google-doc-id': googleDocInfo.id,
          'google-doc-url': `https://docs.google.com/document/d/${googleDocInfo.id}/edit`,
          'google-doc-title': googleDocInfo.name,
          'last-synced': new Date().toISOString(),
          'last-sync-path': file.path, // Track current path for move detection
          'sync-revision': currentRevision, // Increment sync revision
        };
        
        if (isNewLink) {
          console.log(`Linked ${file.path} to Google Doc: ${googleDocInfo.id}`);
        } else if (pathChanged) {
          console.log(`File moved: ${frontmatter['last-sync-path']} → ${file.path}`);
        }
      }

      // Get remote content
      const remoteContent = await driveAPI.exportDocument(googleDocInfo.id);
      const remoteRevision = await this.getDocumentRevision(googleDocInfo.id, driveAPI);

      // Status shown in status bar, no popup notice

      // Get actual file modification time
      const fileStats = await this.app.vault.adapter.stat(file.path);
      const localModificationTime = fileStats?.mtime || Date.now();

      // Perform intelligent sync with conflict resolution
      const syncResult = await this.syncService.syncDocument(
        markdown,
        updatedFrontmatter,
        remoteContent,
        remoteRevision,
        new Date().toISOString(), // remote modifiedTime
        { localModificationTime }
      );

      if (!syncResult.result.success) {
        throw new Error(syncResult.result.error || 'Sync failed');
      }

      // Apply changes based on sync result
      let shouldUpdateLocal = false;
      let shouldUpdateRemote = false;
      let finalContent = content;

      switch (syncResult.result.action) {
        case 'pull':
          // Update local file with remote content
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(
            updatedFrontmatter,
            syncResult.updatedContent || remoteContent,
          );
          shouldUpdateLocal = true;
          break;

        case 'push':
          // Update remote doc with local content
          shouldUpdateRemote = true;
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
          shouldUpdateLocal = updatedFrontmatter !== frontmatter; // Update local if frontmatter changed
          break;

        case 'merge':
          // Apply merged content to both local and remote
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(
            updatedFrontmatter,
            syncResult.updatedContent || markdown,
          );
          shouldUpdateLocal = true;
          shouldUpdateRemote = true;
          break;

        case 'no_change':
          // Just update frontmatter if needed
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
          shouldUpdateLocal = updatedFrontmatter !== frontmatter;
          break;
      }

      // Check if we need to update frontmatter (for newly linked docs)
      const frontmatterChanged = JSON.stringify(updatedFrontmatter) !== JSON.stringify(frontmatter);
      
      // Apply local changes
      if (shouldUpdateLocal || frontmatterChanged) {
        if (frontmatterChanged && !shouldUpdateLocal) {
          // Just update frontmatter, keep existing content
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
        }
        await this.app.vault.modify(file, finalContent);
        console.log(`📝 Updated local file: ${file.path}`);
      }

      // Apply remote changes
      if (shouldUpdateRemote) {
        await driveAPI.updateDocument(googleDocInfo.id, syncResult.updatedContent || markdown);
      }

      // Log conflict markers for debugging (removed intrusive popup)
      if (syncResult.result.conflictMarkers && syncResult.result.conflictMarkers.length > 0) {
        console.log('Sync conflicts detected:', syncResult.result.conflictMarkers);
      }

      // Update header action
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      const normalizedError = ErrorUtils.normalize(error as any, {
        operation: 'smart-sync',
        resourceName: file.name,
        filePath: file.path,
      });
      // Only show notice for sync errors
      new Notice(`❌ Sync failed: ${normalizedError.message}`, 5000);
      console.error('Smart sync failed:', normalizedError);
    }
  }

  addContextMenuItems(menu: Menu, file: TFile): void {
    const metadata = this.getGoogleDocsMetadataSync(file);

    if (metadata) {
      menu.addItem((item: any) => {
        item
          .setTitle('Push to Google Docs')
          .setIcon('upload')
          .onClick(() => this.pushSingleFile(file));
      });

      menu.addItem((item: any) => {
        item
          .setTitle('Pull from Google Docs')
          .setIcon('download')
          .onClick(() => this.pullSingleFile(file));
      });

      menu.addItem((item: any) => {
        item
          .setTitle('Smart sync with Google Docs')
          .setIcon('sync')
          .onClick(() => this.performSmartSync(file));
      });
    } else {
      menu.addItem((item: any) => {
        item
          .setTitle('Create Google Doc')
          .setIcon('file-plus')
          .onClick(() => this.createGoogleDocFromFile(file));
      });
    }
  }

  private syncCancelled = false;
  private syncInProgress = false;
  private currentSyncStatus = {
    isRunning: false,
    progress: { current: 0, total: 0 },
    operation: '',
    startTime: 0,
  };
  
  // Track known Google Doc IDs to detect deletions
  private knownGoogleDocIds: Set<string> = new Set();

  async syncAllDocuments() {
    // Check if sync is already in progress
    if (this.syncInProgress) {
      this.showSyncInProgressMenu();
      return;
    }

    console.log('🔄 Starting syncAllDocuments()');
    console.log(`📦 Plugin version: ${PLUGIN_VERSION} (${VERSION_INFO.commit || 'unknown'})`);
    
    // Validate folder configuration before proceeding
    try {
      await this.resolveDriveFolderId();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Invalid Google Drive folder configuration', 8000);
      this.syncInProgress = false;
      return;
    }
    this.syncCancelled = false;
    this.syncInProgress = true;
    this.currentSyncStatus = {
      isRunning: true,
      progress: { current: 0, total: 0 },
      operation: 'Starting sync...',
      startTime: Date.now(),
    };
    
    try {
      // Test authentication first
      console.log('🔐 Testing authentication...');
      const driveAPI = await this.getAuthenticatedDriveAPI();
      console.log('✅ Authentication successful');
      
      // Build and log comprehensive sync plan
      console.log('📋 Building sync plan for comprehensive analysis...');
      this.currentSyncStatus.operation = 'Building sync plan...';
      const syncPlan = await this.buildSyncPlan();
      this.logSyncPlan(syncPlan);
      
      // Safety check before proceeding - only block on real conflicts
      if (!syncPlan.operations.safe) {
        const duplicateDocs = syncPlan.operations.warnings.filter(w => w.type === 'duplicate-document').length;
        const conflicts = syncPlan.operations.conflicts.length;
        
        console.error('🛑 SYNC ABORTED - Real conflicts detected:');
        if (duplicateDocs > 0) console.error(`   - ${duplicateDocs} duplicate document conflict(s) in Google Drive`);
        if (conflicts > 0) console.error(`   - ${conflicts} sync conflict(s) detected`);
        
        const errorMessage = `Sync aborted due to conflicts: ${duplicateDocs} duplicate document conflicts, ${conflicts} sync conflicts. Please resolve conflicts manually.`;
        new Notice(errorMessage, 15000);
        
        // Reset sync state and abort
        this.syncInProgress = false;
        this.currentSyncStatus = {
          isRunning: false,
          progress: { current: 0, total: 0 },
          operation: 'Sync aborted - conflicts detected',
          startTime: 0,
        };
        this.statusBarItem.setText('Sync aborted');
        
        console.log('\n🔧 RECOMMENDED ACTIONS TO FIX:');
        if (duplicateDocs > 0) {
          console.log('1. Resolve duplicate Google Doc IDs or path conflicts');
          console.log('2. Ensure no two documents sync to the same local path');
        }
        if (conflicts > 0) {
          console.log('1. Resolve local vs remote conflicts manually');
          console.log('2. Choose which version to keep for each conflicted file');
        }
        console.log('3. Re-run sync after resolving conflicts');
        
        return; // Abort the sync operation
      } else {
        console.log('✅ Sync plan safety check passed - proceeding with sync');
      }
      
      const files = this.app.vault.getMarkdownFiles();
      
      let syncCount = 0;
      let createCount = 0;
      let updateCount = 0;
      let moveCount = 0;
      let deleteCount = 0;
      let archiveCount = 0;
      let errorCount = 0;

      console.log(`📁 Found ${files.length} markdown files to process`);
      
      // Update sync status
      this.currentSyncStatus.progress.total = files.length;
      this.currentSyncStatus.operation = 'Enumerating files';
      
      // Use only status bar for progress
      this.statusBarItem.setText(`Syncing 0/${files.length}...`);

      for (const file of files) {
        // Check for cancellation
        if (this.syncCancelled) {
          console.log('🛑 Sync cancelled by user');
          break;
        }

        try {
          // Update status bar with progress (only progress indicator)  
          this.statusBarItem.setText(`Syncing ${syncCount + 1}/${files.length}...`);
          this.currentSyncStatus.progress.current = syncCount + 1;
          this.currentSyncStatus.operation = `Syncing ${file.name}`;
          
          // Check if file has Google Drive metadata
          const metadata = await this.getGoogleDocsMetadata(file);
          
          if (!metadata) {
            // File not linked to Google Drive - create new doc
            console.log(`Creating new Google Doc for ${file.path}`);
            await this.performSmartSync(file);
            createCount++;
            syncCount++;
          } else {
            // File linked to Google Drive - check for changes and moves
            const syncState = await this.changeDetector.detectChanges(file);
            
            let needsSync = false;
            let syncReason = '';
            
            // Handle moves first (if enabled)
            if (this.settings.syncMoves) {
              if (syncState.hasLocalMove && syncState.hasRemoteMove) {
                // Move conflict - need to resolve
                console.log(`Move conflict detected for ${file.path}: local moved from ${syncState.localMoveFrom}, remote moved from ${syncState.remoteMoveFrom}`);
                const resolvedMove = await this.resolveMoveConflict(file, syncState, driveAPI);
                if (resolvedMove) {
                  moveCount++;
                  syncCount++;
                  needsSync = true;
                  syncReason = 'move conflict resolved';
                }
              } else if (syncState.hasLocalMove) {
                // Local file moved - move Google Doc to match
                console.log(`Local move detected: ${syncState.localMoveFrom} → ${file.path}`);
                await this.syncLocalMoveToRemote(file, metadata.id, driveAPI);
                moveCount++;
                syncCount++;
                needsSync = true;
                syncReason = 'local move synced';
              } else if (syncState.hasRemoteMove) {
                // Remote file moved - move local file to match (requires careful handling)
                console.log(`Remote move detected: ${syncState.remoteMoveFrom} → current remote location`);
                await this.syncRemoteMoveToLocal(file, syncState.remoteMoveFrom, driveAPI);
                moveCount++;
                syncCount++;
                needsSync = true;
                syncReason = 'remote move synced';
              }
            }
            
            // Handle delete operations (process before content changes)
            if (syncState.hasRemoteDelete) {
              const deleteResult = await this.handleRemoteDelete(file, syncState, driveAPI);
              if (deleteResult.archived) {
                archiveCount++;
                syncCount++;
                needsSync = true;
                syncReason = deleteResult.reason;
              } else if (deleteResult.restored) {
                updateCount++;
                syncCount++;
                needsSync = true;
                syncReason = 'restored from delete conflict';
              }
            }
            
            // Handle content changes (only if file wasn't deleted)
            if (!syncState.hasRemoteDelete && (syncState.hasLocalChanges || syncState.hasRemoteChanges)) {
              console.log(`Content changes for ${file.path} (local: ${syncState.hasLocalChanges}, remote: ${syncState.hasRemoteChanges})`);
              await this.performSmartSync(file);
              updateCount++;
              syncCount++;
              needsSync = true;
              syncReason += (syncReason ? ' + content changes' : 'content changes');
            }
            
            if (!needsSync) {
              console.log(`No changes detected for ${file.path}`);
            } else {
              console.log(`Synced ${file.path}: ${syncReason}`);
            }
          }
        } catch (error) {
          errorCount++;
          console.error(`Failed to sync ${file.path}:`, error);
        }
      }

      // Update status bar with final result
      const totalFiles = files.length;
      const statusMessage = this.syncCancelled ? 'cancelled' : 'synced';
      this.statusBarItem.setText(`Google Docs: ${syncCount}/${totalFiles} ${statusMessage}`);

      // Show brief completion notice only
      if (this.syncCancelled) {
        new Notice(`Sync cancelled: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived`, 2000);
      } else if (errorCount > 0) {
        new Notice(`Sync completed: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived, ${errorCount} errors`, 3000);
      } else {
        new Notice(`Sync completed: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived`, 2000);
      }
      
      console.log(`✅ Sync ${this.syncCancelled ? 'cancelled' : 'completed'}: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived, ${errorCount} errors`);
      
    } catch (error) {
      console.error('❌ Sync failed:', error);
      new Notice(`Sync failed: ${error.message}`);
      this.statusBarItem.setText('Google Docs: sync failed');
    } finally {
      // Reset sync state
      this.syncInProgress = false;
      this.syncCancelled = false;
      this.currentSyncStatus = {
        isRunning: false,
        progress: { current: 0, total: 0 },
        operation: '',
        startTime: 0,
      };
    }
  }

  showSyncInProgressMenu(): void {
    const menu = new Menu();

    menu.addItem((item: any) => {
      item
        .setTitle('View sync status')
        .setIcon('info')
        .onClick(() => this.showCurrentSyncStatus());
    });

    menu.addItem((item: any) => {
      item
        .setTitle('Cancel sync')
        .setIcon('stop-circle')
        .onClick(() => this.cancelSync());
    });

    menu.addSeparator();

    menu.addItem((item: any) => {
      item
        .setTitle('Continue running')
        .setIcon('play')
        .onClick(() => {
          // Just close the menu and let sync continue
          new Notice('Sync will continue running...', 2000);
        });
    });

    // Show menu at current mouse position or center of screen
    const rect = this.statusBarItem.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top });
  }

  showCurrentSyncStatus(): void {
    if (!this.syncInProgress) {
      new Notice('No sync operation currently running', 3000);
      return;
    }

    const elapsed = Math.round((Date.now() - this.currentSyncStatus.startTime) / 1000);
    const progress = this.currentSyncStatus.progress;
    const percentComplete = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    let message = `**Manual Sync in Progress**\n\n`;
    message += `• Progress: ${progress.current}/${progress.total} files (${percentComplete}%)\n`;
    message += `• Current Operation: ${this.currentSyncStatus.operation}\n`;
    message += `• Elapsed Time: ${elapsed}s\n`;
    message += `• Started: ${new Date(this.currentSyncStatus.startTime).toLocaleTimeString()}\n`;

    if (progress.total > 0 && progress.current > 0) {
      const avgTimePerFile = elapsed / progress.current;
      const remainingFiles = progress.total - progress.current;
      const estimatedTimeRemaining = Math.round(avgTimePerFile * remainingFiles);
      
      if (estimatedTimeRemaining > 0) {
        message += `• Estimated Time Remaining: ${estimatedTimeRemaining}s\n`;
      }
    }

    new Notice(message, 10000);
  }

  cancelSync(): void {
    if (!this.syncInProgress) {
      new Notice('No sync operation to cancel', 3000);
      return;
    }

    this.syncCancelled = true;
    new Notice('Sync cancellation requested...', 3000);
    console.log('🛑 User requested sync cancellation');
  }

  showStatusBarMenu(evt: MouseEvent): void {
    const menu = new Menu();

    // Show different options based on sync status
    if (this.syncInProgress) {
      menu.addItem((item: any) => {
        item
          .setTitle('View sync status')
          .setIcon('info')
          .onClick(() => this.showCurrentSyncStatus());
      });

      menu.addItem((item: any) => {
        item
          .setTitle('Cancel sync')
          .setIcon('stop-circle')
          .onClick(() => this.cancelSync());
      });
    } else {
      menu.addItem((item: any) => {
        item
          .setTitle('Sync all documents (bidirectional)')
          .setIcon('sync')
          .onClick(() => this.syncAllDocuments());
      });

      menu.addSeparator();

      menu.addItem((item: any) => {
        item
          .setTitle('Push all documents')
          .setIcon('upload')
          .onClick(() => this.pushAllDocs());
      });

      menu.addItem((item: any) => {
        item
          .setTitle('Pull all documents')
          .setIcon('download')
          .onClick(() => this.pullAllDocs());
      });

      menu.addItem((item: any) => {
        item
          .setTitle('Smart sync current document')
          .setIcon('sync')
          .onClick(() => this.smartSyncCurrentDoc());
      });

      menu.addSeparator();

      menu.addItem((item: any) => {
        item
          .setTitle('View sync status')
          .setIcon('info')
          .onClick(() => this.showSyncStatus());
      });
    }

    menu.showAtMouseEvent(evt);
  }

  async showFileSyncMenu(file: TFile, evt: MouseEvent | null): Promise<void> {
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle('Push to Google Docs')
        .setIcon('upload')
        .onClick(() => this.pushSingleFile(file));
    });

    menu.addItem((item) => {
      item
        .setTitle('Pull from Google Docs')
        .setIcon('download')
        .onClick(() => this.pullSingleFile(file));
    });

    if (evt) {
      menu.showAtMouseEvent(evt);
    } else {
      menu.showAtPosition({ x: 0, y: 0 });
    }
  }

  async pushSingleFile(file: TFile): Promise<void> {
    const notice = new Notice('Pushing to Google Docs...', 0);

    try {
      const metadata = await this.getGoogleDocsMetadata(file);
      if (!metadata) {
        await this.createGoogleDocFromFile(file);
      } else {
        await this.updateGoogleDoc(file, metadata);
      }

      notice.setMessage('Push completed successfully');
      setTimeout(() => notice.hide(), 2000);

      // Update header action after successful push
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      const normalizedError = ErrorUtils.normalize(error as any, {
        operation: 'push-document',
        resourceName: file.name,
        filePath: file.path,
      });
      notice.setMessage(`Push failed: ${normalizedError.message}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('Push failed:', normalizedError);
    }
  }

  async pullSingleFile(file: TFile): Promise<void> {
    const enhancedNotice = this.createEnhancedNotice('Preparing to pull...', 0);
    const operationId = `pull-${file.path}-${Date.now()}`;
    this.currentOperations.set(operationId, enhancedNotice);

    try {
      enhancedNotice.update('Checking document metadata...');
      const metadata = await this.getGoogleDocsMetadata(file);
      if (!metadata) {
        throw new BaseError('No Google Docs metadata found', {
          resourceName: file.name,
          filePath: file.path,
          operation: 'validate-metadata',
        });
      }

      enhancedNotice.update('Fetching remote content...');
      await this.updateLocalFile(file, metadata);

      const summary: OperationSummary = {
        created: 0,
        updated: 1,
        skipped: 0,
        conflicted: 0,
        errors: 0,
        total: 1,
      };

      const message = this.formatOperationSummary(
        `✅ Updated ${file.name} from Google Doc`,
        summary,
      );

      enhancedNotice.update(message);
      setTimeout(() => enhancedNotice.hide(), 3000);

      // Update header action after successful pull
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      this.handleSyncError(error, file, enhancedNotice);
    } finally {
      this.currentOperations.delete(operationId);
    }
  }

  async smartSyncCurrentDoc() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') {
      new Notice('No active Markdown file');
      return;
    }

    await this.performSmartSync(activeFile);
  }

  async syncCurrentDoc() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') {
      new Notice('No active Markdown file');
      return;
    }

    await this.performSmartSync(activeFile);
  }

  async pushAllDocs() {
    // Validate settings before proceeding
    if (!this.settings.driveFolderId || this.settings.driveFolderId.trim() === '') {
      new Notice('Google Drive folder not configured. Please set the Drive folder ID in plugin settings.', 8000);
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    const notice = new Notice('Pushing all documents...', 0);

    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        await this.pushSingleFile(file);
        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`Failed to push ${file.path}:`, error);
      }
    }

    notice.setMessage(`Push completed: ${successCount} success, ${errorCount} errors`);
    setTimeout(() => notice.hide(), 3000);
  }

  async pullAllDocs() {
    console.log('🔄 pullAllDocs() called');
    console.log('📋 Current settings:', {
      driveFolderId: this.settings.driveFolderId,
      baseVaultFolder: this.settings.baseVaultFolder,
      profile: this.settings.profile,
    });

    const notice = new Notice('Validating Google Drive folder...', 0);

    try {
      // Resolve and validate the folder ID
      const resolvedFolderId = await this.resolveDriveFolderId();
      console.log('✅ pullAllDocs() validation passed, resolved folderId:', resolvedFolderId);

      notice.setMessage('Building comprehensive sync plan...');

      // Get authenticated Drive API
      const driveAPI = await this.getAuthenticatedDriveAPI();
      
      // Build and log comprehensive sync plan before pulling
      console.log('📋 Building sync plan for pull operation analysis...');
      const syncPlan = await this.buildSyncPlan();
      this.logSyncPlan(syncPlan);
      
      // Show specific analysis for pull operation
      const pullOperations = syncPlan.operations.pullFromRemote;
      console.log(`\n📥 PULL ANALYSIS: ${pullOperations.length} documents can be pulled from remote`);
      pullOperations.forEach(op => {
        console.log(`   • ${op.action.toUpperCase()}: ${op.remoteDoc.name} → ${op.targetPath}`);
        console.log(`     Reason: ${op.reason}`);
      });
      
      // Safety checks for pull operation
      const existingFileWarnings = syncPlan.operations.warnings.filter(w => w.type === 'existing-file');
      const duplicateDocWarnings = syncPlan.operations.warnings.filter(w => w.type === 'duplicate-document');
      
      if (existingFileWarnings.length > 0) {
        console.log(`\n⚠️  PULL CONFLICTS: ${existingFileWarnings.length} remote documents would conflict with existing local files:`);
        existingFileWarnings.forEach(warning => {
          console.log(`   • Remote "${warning.details.remoteName}" → Local "${warning.details.localPath}"`);
        });
      }
      
      // Check for real conflicts that should abort pull
      if (duplicateDocWarnings.length > 0) {
        console.error('🛑 PULL ABORTED - Document conflicts detected:');
        duplicateDocWarnings.forEach(warning => {
          console.error(`   - Document conflict: "${warning.details.name}" appears ${warning.details.count} times`);
          console.error(`     • IDs: ${warning.details.ids.join(', ')}`);
        });
        
        const errorMessage = `Pull aborted: ${duplicateDocWarnings.length} document conflicts detected. Resolve conflicts first.`;
        notice.setMessage('❌ ' + errorMessage);
        setTimeout(() => notice.hide(), 15000);
        new Notice(errorMessage, 15000);
        
        console.log('\n🔧 RECOMMENDED ACTIONS:');
        console.log('1. Resolve duplicate Google Doc IDs or path conflicts');
        console.log('2. Ensure no two documents would sync to the same local path');
        console.log('3. Re-run "Pull All Documents" after resolving conflicts');
        
        return; // Abort the pull operation
      } else if (existingFileWarnings.length > 0) {
        console.warn(`⚠️ ${existingFileWarnings.length} potential file conflicts detected, but proceeding with pull...`);
        const warningMessage = `${existingFileWarnings.length} remote documents may conflict with existing local files. Check console for details.`;
        new Notice(warningMessage, 8000);
      } else {
        console.log('✅ Pull safety check passed - proceeding with pull operation');
      }

      notice.setMessage('Discovering documents on Google Drive...');

      // Get all documents from Google Drive using resolved folder ID
      console.log('📡 Calling driveAPI.listDocsInFolder with resolved folderId:', resolvedFolderId);
      const remoteDocs = await driveAPI.listDocsInFolder(resolvedFolderId);
      console.log('📊 listDocsInFolder returned:', remoteDocs.length, 'documents');
      
      // Log the first few documents for debugging
      if (remoteDocs.length > 0) {
        console.log('📋 First few discovered documents:');
        remoteDocs.slice(0, 3).forEach((doc, i) => {
          console.log(`  ${i + 1}. "${doc.name}" (${doc.id}) at path: "${doc.relativePath || '(root)'}"`);
        });
        if (remoteDocs.length > 3) {
          console.log(`  ... and ${remoteDocs.length - 3} more documents`);
        }
      } else {
        console.log('⚠️ No documents found in Google Drive folder');
      }
      
      notice.setMessage(`Found ${remoteDocs.length} document(s) on Google Drive. Pulling...`);

      let successCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      for (const doc of remoteDocs) {
        try {
          console.log(`Processing Google Doc: "${doc.name}" (${doc.id}) at path: "${doc.relativePath || '(root)'}"`);
          
          // Find corresponding local file by Google Doc ID
          const localFiles = this.app.vault.getMarkdownFiles();
          let localFile: TFile | null = null;
          
          for (const file of localFiles) {
            const content = await this.app.vault.read(file);
            const { frontmatter } = SyncUtils.parseFrontMatter(content);
            if (frontmatter['google-doc-id'] === doc.id) {
              localFile = file;
              break;
            }
          }

          if (localFile) {
            // Update existing local file
            console.log(`Updating existing local file: ${localFile.path}`);
            await this.pullSingleFile(localFile);
            updatedCount++;
          } else {
            // Create new local file for this Google Doc
            console.log(`Creating new local file for Google Doc: "${doc.name}" with relativePath: "${doc.relativePath || '(empty)'}"`);
            await this.createLocalFileFromGoogleDoc(doc, driveAPI);
            createdCount++;
          }
          
          successCount++;
        } catch (error) {
          errorCount++;
          console.error(`Failed to pull ${doc.name} (${doc.id}):`, error);
        }
      }

      notice.setMessage(`Pull completed: ${successCount} success (${createdCount} created, ${updatedCount} updated), ${errorCount} errors`);
      setTimeout(() => notice.hide(), 5000);
    } catch (error) {
      console.error('Failed to pull all docs:', error);
      
      // Clear any cached data on errors
      this.clearDriveAPICache();
      
      // Provide user-friendly error messages
      let errorMessage = 'Pull failed: ';
      if (error instanceof Error) {
        if (error.message.includes('Cannot access Google Drive folder')) {
          errorMessage += 'Invalid Google Drive folder. Please check your folder ID in settings.';
        } else if (error.message.includes('Authentication')) {
          errorMessage += 'Authentication failed. Please re-authenticate in settings.';
        } else {
          errorMessage += error.message;
        }
      } else {
        errorMessage += String(error);
      }
      
      notice.setMessage(errorMessage);
      setTimeout(() => notice.hide(), 8000);
    }
  }

  /**
   * Create a new local file from a Google Doc
   */
  async createLocalFileFromGoogleDoc(doc: any, driveAPI: any): Promise<void> {
    try {
      console.log(`🆕 createLocalFileFromGoogleDoc for "${doc.name}" (${doc.id})`);
      console.log(`  - doc.relativePath: "${doc.relativePath || '(empty)'}"`);
      console.log(`  - settings.baseVaultFolder: "${this.settings.baseVaultFolder || '(not set)'}"`);
      
      // Download the Google Doc content
      const remoteContent = await driveAPI.exportDocMarkdown(doc.id);
      console.log(`  - Downloaded content length: ${remoteContent.length} chars`);
      
      // Create frontmatter for the new file
      const frontmatter = {
        'google-doc-id': doc.id,
        'google-doc-url': `https://docs.google.com/document/d/${doc.id}/edit`,
        'google-doc-title': doc.name,
        'last-synced': new Date().toISOString(),
        'sync-revision': 1,
      };
      
      // Build the complete markdown content with frontmatter
      const completeContent = SyncUtils.buildMarkdownWithFrontmatter(frontmatter, remoteContent);
      
      // Generate a suitable filename (sanitize the doc name)
      const sanitizedName = SyncUtils.sanitizeFileName(doc.name);
      const fileName = `${sanitizedName}.md`;
      
      console.log(`  - Sanitized filename: "${fileName}"`);
      console.log(`  - Starting path calculation...`);
      
      // Determine the target path including Google Drive folder structure
      let targetPath = fileName;
      console.log(`  - Initial targetPath: "${targetPath}"`);
      
      // Start with base vault folder if configured
      if (this.settings.baseVaultFolder && this.settings.baseVaultFolder.trim() !== '') {
        targetPath = `${this.settings.baseVaultFolder.trim()}/${fileName}`;
        console.log(`  - Applied base vault folder: "${targetPath}"`);
      }
      
      // Add the relative path from Google Drive folder structure
      if (doc.relativePath && doc.relativePath.trim() !== '') {
        // If we have a base folder, combine them, otherwise use just the relative path
        if (this.settings.baseVaultFolder && this.settings.baseVaultFolder.trim() !== '') {
          targetPath = `${this.settings.baseVaultFolder.trim()}/${doc.relativePath}/${fileName}`;
          console.log(`  - Combined base + relative: "${targetPath}"`);
        } else {
          targetPath = `${doc.relativePath}/${fileName}`;
          console.log(`  - Applied relative path only: "${targetPath}"`);
        }
      } else {
        console.log(`  - No relative path (root file), final path: "${targetPath}"`);
      }
      
      console.log(`  - Final target path: "${targetPath}"`);
      
      // Ensure target directory exists
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      if (targetDir && targetDir !== targetPath) {
        console.log(`Creating directory: ${targetDir}`);
        // Create nested folders if they don't exist
        await this.ensureDirectoryExists(targetDir);
      }
      
      // Create the file in the vault
      const newFile = await this.app.vault.create(targetPath, completeContent);
      
      console.log(`✓ Created local file ${newFile.path} from Google Doc "${doc.name}" (${doc.id})`);
      
    } catch (error) {
      console.error(`Failed to create local file from Google Doc "${doc.name}" (${doc.id}):`, error);
      throw error;
    }
  }

  /**
   * Ensure directory exists in Obsidian vault, creating nested folders as needed
   */
  async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      // Check if directory already exists
      const folderExists = this.app.vault.getAbstractFileByPath(dirPath);
      if (folderExists) {
        console.log(`Directory already exists: ${dirPath}`);
        return;
      }

      // Split path and create directories recursively
      const parts = dirPath.split('/').filter(part => part.length > 0);
      let currentPath = '';
      
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        
        const exists = this.app.vault.getAbstractFileByPath(currentPath);
        if (!exists) {
          console.log(`Creating directory: ${currentPath}`);
          await this.app.vault.createFolder(currentPath);
        }
      }
    } catch (error) {
      console.error(`Failed to create directory ${dirPath}:`, error);
      throw error;
    }
  }

  async getGoogleDocsMetadata(file: TFile): Promise<any> {
    const content = await this.app.vault.read(file);
    const { frontmatter } = this.parseFrontmatter(content);

    if (frontmatter['google-doc-id']) {
      return {
        id: frontmatter['google-doc-id'],
        url: frontmatter['google-doc-url'] || '',
        title: frontmatter['google-doc-title'] || SyncUtils.sanitizeFileName(file.basename),
        lastSynced: frontmatter['last-synced'] || new Date().toISOString(),
        lastSyncPath: frontmatter['last-sync-path'],
        syncRevision: frontmatter['sync-revision'] || 0,
        deletionScheduled: frontmatter['deletion-scheduled'],
      };
    }

    return null;
  }

  getGoogleDocsMetadataSync(file: TFile): any {
    // This is a synchronous version for context menu
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter && cache.frontmatter['google-doc-id']) {
      return {
        id: cache.frontmatter['google-doc-id'],
        url: cache.frontmatter['google-doc-url'] || '',
        title: cache.frontmatter['google-doc-title'] || SyncUtils.sanitizeFileName(file.basename),
        lastSynced: cache.frontmatter['last-synced'] || new Date().toISOString(),
      };
    }
    return null;
  }

  parseFrontmatter(content: string): { frontmatter: Record<string, any>; markdown: string } {
    try {
      // Use shared frontmatter parsing from src/fs/frontmatter.ts
      const result = parseFrontMatter(content);
      return { frontmatter: result.data, markdown: result.content };
    } catch (error) {
      console.error('Frontmatter parsing failed, using fallback:', error);
      // Fallback to old parsing if needed
      const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
      const match = content.match(frontmatterRegex);

      if (!match) {
        return { frontmatter: {}, markdown: content };
      }

      const frontmatterText = match[1];
      const markdown = match[2];

      try {
        const frontmatter = parseBasicYaml(frontmatterText);
        return { frontmatter, markdown };
      } catch (fallbackError) {
        console.error('Fallback frontmatter parsing also failed:', fallbackError);
        return { frontmatter: {}, markdown: content };
      }
    }
  }

  serializeFrontmatter(frontmatter: Record<string, any>): string {
    try {
      // Use shared frontmatter building from src/fs/frontmatter.ts
      // Extract the YAML part from the full document
      const fullDocument = buildFrontMatter(frontmatter, '');
      const yamlMatch = fullDocument.match(/^---\n([\s\S]*?)\n---\n/);
      return yamlMatch ? yamlMatch[1] : serializeBasicYaml(frontmatter);
    } catch (error) {
      console.warn('Shared YAML serialization failed, using fallback:', error);
      try {
        return serializeBasicYaml(frontmatter);
      } catch (fallbackError) {
        console.warn('Fallback YAML serialization failed:', fallbackError);
        // Fallback to simple key-value serialization
        let result = '';
        for (const [key, value] of Object.entries(frontmatter)) {
          result += `${key}: ${value}\n`;
        }
        return result;
      }
    }
  }

  async updateFileWithNewDocId(file: TFile, docId: string): Promise<void> {
    const content = await this.app.vault.read(file);
    const { frontmatter, markdown } = this.parseFrontmatter(content);

    // Update frontmatter with Google Docs information
    frontmatter['google-doc-id'] = docId;
    frontmatter['last-synced'] = new Date().toISOString();

    // Serialize frontmatter properly
    const frontmatterYaml = this.serializeFrontmatter(frontmatter);
    const newContent = `---\n${frontmatterYaml}---\n${markdown}`;

    await this.app.vault.modify(file, newContent);
  }

  async createGoogleDocFromFile(file: TFile): Promise<void> {
    const notice = new Notice('Creating Google Doc...', 0);

    try {
      // Check for existing document with same name first
      const parentFolder = file.parent;
      const folderId = await this.getOrCreateGoogleDriveFolder(parentFolder);
      const sanitizedName = SyncUtils.sanitizeFileName(file.basename);
      const existingDoc = await this.findDocumentByName(sanitizedName, folderId);

      if (existingDoc) {
        // Document already exists, just link it
        await this.updateFileWithNewDocId(file, existingDoc.id);
        notice.setMessage('Linked to existing Google Doc');
        setTimeout(() => notice.hide(), 2000);
        return;
      }

      const content = await this.app.vault.read(file);
      const { markdown } = this.parseFrontmatter(content);

      // Sanitize markdown for Google Drive compatibility
      const sanitizedMarkdown = SyncUtils.sanitizeMarkdownForGoogleDrive(markdown);

      // Create new document
      const docId = await this.createGoogleDoc(sanitizedName, sanitizedMarkdown, folderId);
      await this.updateFileWithNewDocId(file, docId);

      notice.setMessage('Google Doc created successfully');
      setTimeout(() => notice.hide(), 2000);

      // Update header action
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      const normalizedError = ErrorUtils.normalize(error as any, {
        operation: 'create-google-doc',
        resourceName: file.name,
        filePath: file.path,
      });
      notice.setMessage(`Failed to create Google Doc: ${normalizedError.message}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('Create failed:', normalizedError);
    }
  }

  async getAuthenticatedDriveAPI(): Promise<DriveAPI> {
    // Check cache first
    const now = Date.now();
    if (this.driveAPICache && (now - this.driveAPICache.timestamp) < this.DRIVE_API_CACHE_TTL) {
      return this.driveAPICache.api;
    }

    try {
      const authClient = await this.authManager.getAuthClient();
      const api = new DriveAPI(authClient.credentials.access_token);
      
      // Cache the API instance
      this.driveAPICache = { api, timestamp: now };
      
      return api;
    } catch (error) {
      console.error('❌ Failed to get authenticated Drive API:', error);
      // Clear cache on error
      this.driveAPICache = null;
      throw error;
    }
  }

  /**
   * Clear the Drive API cache (useful after auth changes)
   */
  clearDriveAPICache(): void {
    this.driveAPICache = null;
  }

  /**
   * Get current workspace information
   */
  getWorkspaceInfo() {
    return this.workspaceInfo;
  }

  /**
   * Discover and categorize local files in the vault
   */
  async discoverLocalFiles(): Promise<{
    linked: Array<{ file: TFile; docId: string; path: string }>;
    unlinked: Array<{ file: TFile; path: string }>;
    suspicious: Array<{ file: TFile; path: string; issue: string }>;
    total: number;
  }> {
    const files = this.app.vault.getMarkdownFiles();
    const linked: Array<{ file: TFile; docId: string; path: string }> = [];
    const unlinked: Array<{ file: TFile; path: string }> = [];
    const suspicious: Array<{ file: TFile; path: string; issue: string }> = [];

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = SyncUtils.parseFrontMatter(content);
        const docId = frontmatter['google-doc-id'];

        if (docId) {
          linked.push({ file, docId, path: file.path });
          
          // Check for suspicious patterns
          if (file.path.includes('New Folder')) {
            suspicious.push({ file, path: file.path, issue: 'File in "New Folder" directory' });
          }
        } else {
          unlinked.push({ file, path: file.path });
        }
      } catch (error) {
        suspicious.push({ file, path: file.path, issue: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    return {
      linked,
      unlinked,
      suspicious,
      total: files.length
    };
  }

  /**
   * Discover and analyze remote files in Google Drive
   */
  async discoverRemoteFiles(): Promise<{
    docs: Array<{ id: string; name: string; path: string; relativePath: string }>;
    duplicateFolders: Array<{ name: string; count: number; paths: string[] }>;
    duplicateDocs: Array<{ name: string; count: number; ids: string[] }>;
    suspiciousFolders: Array<{ name: string; path: string; id: string }>;
    folderStats: Record<string, number>;
    total: number;
  }> {
    const driveAPI = await this.getAuthenticatedDriveAPI();
    const resolvedFolderId = await this.resolveDriveFolderId();
    const allDocs = await driveAPI.listDocsInFolder(resolvedFolderId);

    // Track folder paths for statistics only
    const folderPathCounts = new Map<string, number>();
    const docIdCounts = new Map<string, number>(); // Track if same Google Doc ID appears multiple times
    const fullPathCounts = new Map<string, { id: string; name: string }[]>(); // Track if multiple docs want same local path
    const suspiciousFolders: Array<{ name: string; path: string; id: string }> = [];

    allDocs.forEach(doc => {
      const folderPath = doc.relativePath || '(root)';
      const fullPath = `${folderPath}/${doc.name}`.replace(/^\//, '');
      
      // Count documents per folder (for stats)
      folderPathCounts.set(folderPath, (folderPathCounts.get(folderPath) || 0) + 1);

      // Track Google Doc ID occurrences (real duplicates)
      docIdCounts.set(doc.id, (docIdCounts.get(doc.id) || 0) + 1);

      // Track full path conflicts (multiple docs trying to sync to same local path)
      if (!fullPathCounts.has(fullPath)) {
        fullPathCounts.set(fullPath, []);
      }
      fullPathCounts.get(fullPath)!.push({ id: doc.id, name: doc.name });

      // Flag suspicious folders (documents in "New Folder" directories)
      if (folderPath.includes('New Folder')) {
        suspiciousFolders.push({ 
          name: 'New Folder', 
          path: folderPath, 
          id: doc.id 
        });
      }
    });

    // NO duplicate folder detection - folders with same names in different locations are valid
    const duplicateFolders: Array<{ name: string; count: number; paths: string[] }> = [];

    // Find REAL duplicate issues: same Google Doc ID appearing multiple times
    const duplicateDocs: Array<{ name: string; count: number; ids: string[] }> = [];
    docIdCounts.forEach((count, docId) => {
      if (count > 1) {
        const doc = allDocs.find(d => d.id === docId);
        if (doc) {
          duplicateDocs.push({
            name: doc.name,
            count,
            ids: [docId] // Same ID repeated
          });
        }
      }
    });

    // Find path conflicts: multiple different documents trying to sync to same local path
    fullPathCounts.forEach((docs, path) => {
      if (docs.length > 1) {
        // Multiple docs want the same local path - this is a real conflict
        const uniqueIds = [...new Set(docs.map(d => d.id))];
        if (uniqueIds.length > 1) {
          duplicateDocs.push({
            name: `Path conflict: ${path}`,
            count: docs.length,
            ids: uniqueIds
          });
        }
      }
    });

    // Generate folder statistics (documents per folder path)
    const folderStats: Record<string, number> = {};
    folderPathCounts.forEach((count, path) => {
      const folderName = path.split('/').pop() || '(root)';
      folderStats[folderName] = (folderStats[folderName] || 0) + count;
    });

    return {
      docs: allDocs.map(doc => ({
        id: doc.id,
        name: doc.name,
        path: `${doc.relativePath || '(root)'}/${doc.name}`,
        relativePath: doc.relativePath || '(root)'
      })),
      duplicateFolders,
      duplicateDocs,
      suspiciousFolders,
      folderStats,
      total: allDocs.length
    };
  }

  /**
   * Build a comprehensive sync plan by matching local and remote files
   */
  async buildSyncPlan(): Promise<{
    localState: Awaited<ReturnType<typeof this.discoverLocalFiles>>;
    remoteState: Awaited<ReturnType<typeof this.discoverRemoteFiles>>;
    operations: {
      pushToRemote: Array<{ localFile: TFile; action: 'create' | 'update'; reason: string }>;
      pullFromRemote: Array<{ remoteDoc: { id: string; name: string; path: string }; action: 'create' | 'update'; reason: string; targetPath?: string }>;
      conflicts: Array<{ localFile: TFile; remoteDoc: { id: string; name: string }; reason: string }>;
      warnings: Array<{ type: 'duplicate-folder' | 'duplicate-document' | 'suspicious-pattern' | 'existing-file'; message: string; details: any }>;
      safe: boolean;
    };
  }> {
    console.log('🔍 Building comprehensive sync plan...');
    
    // Discover current state
    const localState = await this.discoverLocalFiles();
    const remoteState = await this.discoverRemoteFiles();
    
    // Initialize operation collections
    const pushToRemote: Array<{ localFile: TFile; action: 'create' | 'update'; reason: string }> = [];
    const pullFromRemote: Array<{ remoteDoc: { id: string; name: string; path: string }; action: 'create' | 'update'; reason: string; targetPath?: string }> = [];
    const conflicts: Array<{ localFile: TFile; remoteDoc: { id: string; name: string }; reason: string }> = [];
    const warnings: Array<{ type: 'duplicate-folder' | 'duplicate-document' | 'suspicious-pattern' | 'existing-file'; message: string; details: any }> = [];
    
    // Create lookup maps for efficient matching
    const localByDocId = new Map<string, { file: TFile; docId: string; path: string }>();
    const remoteById = new Map<string, { id: string; name: string; path: string; relativePath: string }>();
    const localByPath = new Map<string, TFile>();
    
    localState.linked.forEach(local => {
      localByDocId.set(local.docId, local);
      localByPath.set(local.path, local.file);
    });
    
    localState.unlinked.forEach(local => {
      localByPath.set(local.path, local.file);
    });
    
    remoteState.docs.forEach(remote => {
      remoteById.set(remote.id, remote);
    });
    
    // Analyze warnings for REAL issues only
    if (remoteState.duplicateDocs.length > 0) {
      remoteState.duplicateDocs.forEach(duplicate => {
        warnings.push({
          type: 'duplicate-document',
          message: `Found ${duplicate.count} documents with conflict: "${duplicate.name}"`,
          details: { name: duplicate.name, count: duplicate.count, ids: duplicate.ids }
        });
      });
    }
    
    if (remoteState.suspiciousFolders.length > 0) {
      warnings.push({
        type: 'suspicious-pattern',
        message: `Found ${remoteState.suspiciousFolders.length} suspicious "New Folder" entries`,
        details: remoteState.suspiciousFolders
      });
    }
    
    if (localState.suspicious.length > 0) {
      localState.suspicious.forEach(suspicious => {
        warnings.push({
          type: 'suspicious-pattern',
          message: `Local file issue: ${suspicious.issue}`,
          details: { path: suspicious.path, issue: suspicious.issue }
        });
      });
    }
    
    // Process linked local files (files with google-doc-id)
    for (const localLinked of localState.linked) {
      const remoteDoc = remoteById.get(localLinked.docId);
      
      // Validate that the document belongs to the current workspace
      const driveAPI = await this.getAuthenticatedDriveAPI();
      const isValidWorkspace = await driveAPI.validateDocumentInCurrentWorkspace(localLinked.docId);
      
      if (!isValidWorkspace) {
        const handleCrossWorkspace = this.settings.handleCrossWorkspaceDocs || 'auto-relink';
        console.log(`🚫 Document ${localLinked.docId} not accessible in current workspace, handling with policy: ${handleCrossWorkspace}`);
        
        if (handleCrossWorkspace === 'skip') {
          console.log(`⏭️ Skipping ${localLinked.path} (cross-workspace document, skip policy)`);
          continue;
        } else if (handleCrossWorkspace === 'warn') {
          console.log(`⚠️ Warning: ${localLinked.path} has cross-workspace document, skipping sync`);
          warnings.push({
            type: 'suspicious-pattern',
            message: `Document ${localLinked.docId} belongs to different workspace: ${localLinked.path}`,
            details: { path: localLinked.path, oldDocId: localLinked.docId, reason: 'cross-workspace-document-warning' }
          });
          continue;
        } else if (handleCrossWorkspace === 'auto-relink') {
          console.log(`🔗 Attempting to auto-relink ${localLinked.path} by name...`);
          
          // Try to find a document with the same name in the current workspace
          const expectedFileName = localLinked.file.name.replace(/\.md$/, '');
          const expectedPath = localLinked.path.replace(/\.md$/, '');
          
          const nameMatchedDoc = remoteState.docs.find(doc => {
            const docPath = doc.relativePath === '(root)' ? doc.name : `${doc.relativePath}/${doc.name}`;
            return doc.name === expectedFileName || docPath === expectedPath;
          });
          
          if (nameMatchedDoc) {
            console.log(`🔗 Auto-relinking ${localLinked.path}: wrong workspace ID ${localLinked.docId} → correct ID ${nameMatchedDoc.id}`);
            
            // Re-link to the document in the current workspace
            pushToRemote.push({
              localFile: localLinked.file,
              action: 'update',
              reason: `Auto-relinking to document in current workspace (ID changed from ${localLinked.docId} to ${nameMatchedDoc.id})`
            });
            
            // Update lookup maps
            localByDocId.delete(localLinked.docId);
            localByDocId.set(nameMatchedDoc.id, { ...localLinked, docId: nameMatchedDoc.id });
            
            warnings.push({
              type: 'suspicious-pattern',
              message: `Auto-relinked cross-workspace document: ${localLinked.path}`,
              details: { path: localLinked.path, oldDocId: localLinked.docId, newDocId: nameMatchedDoc.id, reason: 'cross-workspace-auto-relink' }
            });
            
            // Continue processing with the new valid document
            continue;
          } else {
            console.log(`⚠️ No matching document found for ${localLinked.path} in current workspace, treating as new document`);
            
            // Treat as new document to be created
            pushToRemote.push({
              localFile: localLinked.file,
              action: 'create',
              reason: `Document ID ${localLinked.docId} belongs to different workspace, no matching document found - creating new document`
            });
            
            warnings.push({
              type: 'suspicious-pattern',
              message: `Cross-workspace document ${localLinked.docId} cleared from ${localLinked.path}, will create new document`,
              details: { path: localLinked.path, oldDocId: localLinked.docId, reason: 'cross-workspace-document-cleared' }
            });
            
            continue;
          }
        }
      }
      
      if (remoteDoc) {
        // Both local and remote exist - check for updates needed
        try {
          const hasRemoteChanges = await this.hasRemoteChanges(localLinked.docId, localLinked.file.stat.mtime.toString());
          const hasLocalChanges = await this.hasLocalChanges(localLinked.file);
          
          if (hasLocalChanges && hasRemoteChanges) {
            conflicts.push({
              localFile: localLinked.file,
              remoteDoc: { id: remoteDoc.id, name: remoteDoc.name },
              reason: 'Both local and remote files have been modified'
            });
          } else if (hasLocalChanges) {
            pushToRemote.push({
              localFile: localLinked.file,
              action: 'update',
              reason: 'Local file has been modified'
            });
          } else if (hasRemoteChanges) {
            pullFromRemote.push({
              remoteDoc,
              action: 'update',
              reason: 'Remote document has been modified',
              targetPath: localLinked.path
            });
          }
        } catch (error) {
          warnings.push({
            type: 'suspicious-pattern',
            message: `Failed to check sync status for ${localLinked.path}`,
            details: { path: localLinked.path, docId: localLinked.docId, error: error instanceof Error ? error.message : String(error) }
          });
        }
      } else {
        // Local file exists but remote is missing - check for path-based match
        const expectedPath = localLinked.path.replace(/\.md$/, '');
        const pathMatchedDoc = remoteState.docs.find(doc => {
          const docPath = doc.relativePath === '(root)' ? doc.name : `${doc.relativePath}/${doc.name}`;
          return docPath === expectedPath;
        });
        
        if (pathMatchedDoc) {
          // Found a document at the same path but with different ID - re-link it
          console.log(`🔗 Re-linking ${localLinked.path}: old ID ${localLinked.docId} → new ID ${pathMatchedDoc.id}`);
          
          // Update the local file with the correct Google Doc ID
          pushToRemote.push({
            localFile: localLinked.file,
            action: 'update',
            reason: `Re-linking to existing document at same path (ID changed from ${localLinked.docId} to ${pathMatchedDoc.id})`
          });
          
          // Add this to our lookup so it's not processed again
          localByDocId.delete(localLinked.docId); // Remove old mapping
          localByDocId.set(pathMatchedDoc.id, { ...localLinked, docId: pathMatchedDoc.id }); // Add new mapping
          remoteById.set(pathMatchedDoc.id, pathMatchedDoc); // Ensure it's in remote lookup
        } else {
          // No document found at expected path - create new one
          pushToRemote.push({
            localFile: localLinked.file,
            action: 'create',
            reason: 'Local file has google-doc-id but document not found in Google Drive (no path match either)'
          });
        }
      }
    }
    
    // Process unlinked local files (files without google-doc-id)
    for (const localUnlinked of localState.unlinked) {
      // These could potentially be pushed to create new documents
      pushToRemote.push({
        localFile: localUnlinked.file,
        action: 'create',
        reason: 'Local file has no google-doc-id, could create new Google Doc'
      });
    }
    
    // Process remote docs that don't have local counterparts
    for (const remoteDoc of remoteState.docs) {
      const localLinked = localByDocId.get(remoteDoc.id);
      
      if (!localLinked) {
        // Remote doc exists but no local file - should we pull?
        const potentialLocalPath = this.calculateTargetPath(remoteDoc);
        const existingFile = localByPath.get(potentialLocalPath);
        
        if (existingFile) {
          // Check if this local file is in our linked files list
          const existingLocalLinked = localState.linked.find(local => local.file === existingFile);
          const existingLocalUnlinked = localState.unlinked.find(local => local.file === existingFile);
          
          if (existingLocalLinked && existingLocalLinked.docId !== remoteDoc.id) {
            // Local file has a different ID but same path - re-link to the found remote doc
            console.log(`🔗 Re-linking existing file ${potentialLocalPath}: ${existingLocalLinked.docId} → ${remoteDoc.id}`);
            pullFromRemote.push({
              remoteDoc,
              action: 'update',
              reason: `Re-linking existing local file to correct remote document (ID ${existingLocalLinked.docId} → ${remoteDoc.id})`,
              targetPath: potentialLocalPath
            });
          } else if (existingLocalUnlinked) {
            // Local file has no ID - link it to the remote doc
            console.log(`🔗 Linking unlinked file ${potentialLocalPath} to remote doc ${remoteDoc.id}`);
            pullFromRemote.push({
              remoteDoc,
              action: 'update',
              reason: 'Linking existing unlinked local file to remote document',
              targetPath: potentialLocalPath
            });
          } else {
            // This shouldn't happen as it means same ID in both places (already processed above)
            warnings.push({
              type: 'existing-file',
              message: `Remote document "${remoteDoc.name}" conflicts with existing local file (already processed or unexpected state)`,
              details: { 
                remoteName: remoteDoc.name, 
                remoteId: remoteDoc.id, 
                localPath: potentialLocalPath,
                remoteRelativePath: remoteDoc.relativePath
              }
            });
          }
        } else {
          pullFromRemote.push({
            remoteDoc,
            action: 'create',
            reason: 'Remote document has no local counterpart',
            targetPath: potentialLocalPath
          });
        }
      }
    }
    
    // Determine if sync plan is safe to execute - only block on real conflicts
    const safe = warnings.filter(w => w.type === 'duplicate-document').length === 0 
                && conflicts.length === 0;
    
    return {
      localState,
      remoteState,
      operations: {
        pushToRemote,
        pullFromRemote,
        conflicts,
        warnings,
        safe
      }
    };
  }
  
  /**
   * Calculate the target local path for a remote document
   */
  private calculateTargetPath(remoteDoc: { name: string; relativePath: string }): string {
    if (remoteDoc.relativePath && remoteDoc.relativePath !== '(root)') {
      return `${remoteDoc.relativePath}/${remoteDoc.name}.md`;
    }
    return `${remoteDoc.name}.md`;
  }
  
  /**
   * Check if local file has been modified since last sync
   */
  private async hasLocalChanges(file: TFile): Promise<boolean> {
    try {
      const content = await this.app.vault.read(file);
      const { frontmatter } = SyncUtils.parseFrontMatter(content);
      const lastSynced = frontmatter['last-synced'];
      
      if (!lastSynced) {
        return true; // No sync history, assume changes
      }
      
      const lastSyncTime = new Date(lastSynced);
      const fileModified = new Date(file.stat.mtime);
      
      return fileModified > lastSyncTime;
    } catch (error) {
      console.error(`Failed to check local changes for ${file.path}:`, error);
      return true; // If we can't check, assume changes
    }
  }

  /**
   * Log comprehensive sync plan to console for visibility
   */
  logSyncPlan(syncPlan: Awaited<ReturnType<typeof this.buildSyncPlan>>): void {
    console.log('\n📋 ========== COMPREHENSIVE SYNC PLAN ==========');
    
    // Local State Summary
    console.log('\n📁 LOCAL STATE:');
    console.log(`   Total files: ${syncPlan.localState.total}`);
    console.log(`   Linked (with google-doc-id): ${syncPlan.localState.linked.length}`);
    console.log(`   Unlinked (no google-doc-id): ${syncPlan.localState.unlinked.length}`);
    console.log(`   Suspicious: ${syncPlan.localState.suspicious.length}`);
    
    if (syncPlan.localState.linked.length > 0) {
      console.log('\n   📎 Linked Files:');
      syncPlan.localState.linked.forEach(file => {
        console.log(`     • ${file.path} → ${file.docId}`);
      });
    }
    
    if (syncPlan.localState.unlinked.length > 0 && syncPlan.localState.unlinked.length <= 10) {
      console.log('\n   🔗 Unlinked Files:');
      syncPlan.localState.unlinked.forEach(file => {
        console.log(`     • ${file.path}`);
      });
    } else if (syncPlan.localState.unlinked.length > 10) {
      console.log(`\n   🔗 Unlinked Files: ${syncPlan.localState.unlinked.length} files (showing first 5):`);
      syncPlan.localState.unlinked.slice(0, 5).forEach(file => {
        console.log(`     • ${file.path}`);
      });
      console.log(`     ... and ${syncPlan.localState.unlinked.length - 5} more`);
    }
    
    if (syncPlan.localState.suspicious.length > 0) {
      console.log('\n   ⚠️  Suspicious Local Files:');
      syncPlan.localState.suspicious.forEach(file => {
        console.log(`     • ${file.path}: ${file.issue}`);
      });
    }
    
    // Remote State Summary
    console.log('\n☁️  REMOTE STATE:');
    console.log(`   Total documents: ${syncPlan.remoteState.total}`);
    console.log(`   Document conflicts: ${syncPlan.remoteState.duplicateDocs.length}`);
    console.log(`   Suspicious folders: ${syncPlan.remoteState.suspiciousFolders.length}`);
    
    if (syncPlan.remoteState.folderStats) {
      console.log('\n   📂 Folder Distribution:');
      Object.entries(syncPlan.remoteState.folderStats).forEach(([folderName, count]) => {
        console.log(`     • ${folderName}: ${count} documents`);
      });
    }
    
    if (syncPlan.remoteState.duplicateDocs.length > 0) {
      console.log('\n   📄 Document Conflicts:');
      syncPlan.remoteState.duplicateDocs.forEach(duplicate => {
        console.log(`     • "${duplicate.name}" has ${duplicate.count} conflicts with IDs:`);
        duplicate.ids.forEach(id => {
          console.log(`       - ${id}`);
        });
      });
    }
    
    // Operations Summary
    console.log('\n🔄 PLANNED OPERATIONS:');
    console.log(`   Push to remote: ${syncPlan.operations.pushToRemote.length}`);
    console.log(`   Pull from remote: ${syncPlan.operations.pullFromRemote.length}`);
    console.log(`   Conflicts: ${syncPlan.operations.conflicts.length}`);
    console.log(`   Warnings: ${syncPlan.operations.warnings.length}`);
    console.log(`   Safe to execute: ${syncPlan.operations.safe ? '✅ YES' : '❌ NO'}`);
    
    if (syncPlan.operations.pushToRemote.length > 0) {
      console.log('\n   ⬆️  PUSH TO REMOTE:');
      syncPlan.operations.pushToRemote.forEach(op => {
        console.log(`     • ${op.action.toUpperCase()}: ${op.localFile.path}`);
        console.log(`       Reason: ${op.reason}`);
      });
    }
    
    if (syncPlan.operations.pullFromRemote.length > 0) {
      console.log('\n   ⬇️  PULL FROM REMOTE:');
      syncPlan.operations.pullFromRemote.forEach(op => {
        console.log(`     • ${op.action.toUpperCase()}: ${op.remoteDoc.name} (${op.remoteDoc.id})`);
        console.log(`       Target: ${op.targetPath || 'TBD'}`);
        console.log(`       Reason: ${op.reason}`);
      });
    }
    
    if (syncPlan.operations.conflicts.length > 0) {
      console.log('\n   ⚔️  CONFLICTS:');
      syncPlan.operations.conflicts.forEach(conflict => {
        console.log(`     • Local: ${conflict.localFile.path}`);
        console.log(`       Remote: ${conflict.remoteDoc.name} (${conflict.remoteDoc.id})`);
        console.log(`       Issue: ${conflict.reason}`);
      });
    }
    
    if (syncPlan.operations.warnings.length > 0) {
      console.log('\n   ⚠️  WARNINGS:');
      syncPlan.operations.warnings.forEach(warning => {
        console.log(`     • [${warning.type}] ${warning.message}`);
        if (warning.type === 'existing-file') {
          const details = warning.details;
          console.log(`       Remote: ${details.remoteName} (${details.remoteId})`);
          console.log(`       Local: ${details.localPath}`);
        } else if (warning.type === 'duplicate-folder' || warning.type === 'duplicate-document') {
          console.log(`       Count: ${warning.details.count}`);
        }
      });
    }
    
    // Safety Assessment
    console.log('\n🛡️  SAFETY ASSESSMENT:');
    if (syncPlan.operations.safe) {
      console.log('   ✅ Sync plan appears safe to execute');
      console.log('   ✅ No document conflicts detected');
      console.log('   ✅ No sync conflicts detected');
    } else {
      console.log('   ❌ Sync plan has conflicts:');
      
      const duplicateDocWarnings = syncPlan.operations.warnings.filter(w => w.type === 'duplicate-document');
      
      if (duplicateDocWarnings.length > 0) {
        console.log(`   ❌ ${duplicateDocWarnings.length} document conflict(s) detected`);
      }
      
      if (syncPlan.operations.conflicts.length > 0) {
        console.log(`   ❌ ${syncPlan.operations.conflicts.length} sync conflict(s) detected`);
      }
      
      console.log('\n   🔧 RECOMMENDED ACTIONS:');
      if (duplicateDocWarnings.length > 0) {
        console.log('     1. Resolve duplicate Google Doc IDs or path conflicts');
        console.log('     2. Ensure no two documents sync to the same local path');
        console.log('     3. Re-run sync plan analysis after resolving conflicts');
      }
      
      if (syncPlan.operations.conflicts.length > 0) {
        console.log('     1. Resolve conflicts manually by choosing which version to keep');
        console.log('     2. Consider using conflict resolution tools');
      }
    }
    
    console.log('\n===============================================\n');
  }

  /**
   * Resolve folder name or ID to actual folder ID and validate it exists
   */
  async resolveDriveFolderId(): Promise<string> {
    if (!this.settings.driveFolderId || this.settings.driveFolderId.trim() === '') {
      throw new Error('Google Drive folder not configured. Please set the Drive folder ID in plugin settings.');
    }

    const driveAPI = await this.getAuthenticatedDriveAPI();
    try {
      const resolvedId = await driveAPI.resolveFolderId(this.settings.driveFolderId.trim());
      console.log(`✅ Resolved folder "${this.settings.driveFolderId}" to ID: ${resolvedId}`);
      return resolvedId;
    } catch (error) {
      console.error(`❌ Failed to resolve folder "${this.settings.driveFolderId}":`, error);
      throw new Error(`Cannot access Google Drive folder "${this.settings.driveFolderId}". Please check the folder ID/name and your permissions.`);
    }
  }

  // Placeholder methods for Google Drive API integration
  async hasRemoteChanges(docId: string, lastSynced: string): Promise<boolean> {
    try {
      // Get authenticated Drive API client
      const driveAPI = await this.getAuthenticatedDriveAPI();
      
      // Get file info from Drive
      const fileInfo = await driveAPI.getFile(docId);
      if (!fileInfo) {
        console.log(`Document ${docId} not found in Google Drive`);
        return false;
      }
      
      // Validate and parse timestamps
      const remoteModified = new Date(fileInfo.modifiedTime);
      if (isNaN(remoteModified.getTime())) {
        console.warn(`Invalid remote modified time for ${docId}: ${fileInfo.modifiedTime}`);
        return false;
      }
      
      // Parse lastSynced - it could be a timestamp number or ISO string
      let lastSyncTime: Date;
      if (!lastSynced || lastSynced === 'undefined' || lastSynced === 'null') {
        // No last sync time, assume changes exist
        console.log(`No last sync time for ${docId}, assuming changes exist`);
        return true;
      }
      
      // Try parsing as timestamp number first (from file.stat.mtime)
      const numericTime = Number(lastSynced);
      if (!isNaN(numericTime)) {
        lastSyncTime = new Date(numericTime);
      } else {
        // Try parsing as ISO string
        lastSyncTime = new Date(lastSynced);
      }
      
      if (isNaN(lastSyncTime.getTime())) {
        console.warn(`Invalid last sync time for ${docId}: ${lastSynced}, assuming changes exist`);
        return true;
      }
      
      const hasChanges = remoteModified > lastSyncTime;
      console.log(`Remote changes for ${docId}: ${hasChanges} (remote: ${remoteModified.toISOString()}, lastSync: ${lastSyncTime.toISOString()})`);
      
      return hasChanges;
    } catch (error) {
      console.error(`Failed to check remote changes for ${docId}:`, error);
      // If we can't check, assume no changes to avoid unnecessary sync attempts
      return false;
    }
  }

  async getRemoteDocumentContent(frontmatter: FrontMatter): Promise<{
    content: string;
    revisionId: string;
    modifiedTime: string;
  } | null> {
    // TODO: Implement actual Google Docs API call
    const docId = frontmatter['google-doc-id'] || frontmatter.docId;
    if (!docId) return null;

    console.log(`Getting remote content for doc ${docId}`);

    // Placeholder implementation
    return {
      content: 'Remote document content (placeholder)',
      revisionId: 'rev-' + Date.now(),
      modifiedTime: new Date().toISOString(),
    };
  }

  async findDocumentByName(name: string, folderId: string): Promise<any> {
    // TODO: Implement actual Google Drive search
    console.log(`Searching for document named "${name}" in folder ${folderId}`);
    return null;
  }

  async getOrCreateGoogleDriveFolder(folder: any): Promise<string> {
    // TODO: Implement folder creation/retrieval
    console.log(`Getting/creating folder for ${folder?.path || 'root'}`);
    return 'root';
  }

  async createGoogleDoc(title: string, content: string, folderId: string): Promise<string> {
    // TODO: Implement actual Google Docs creation
    // Content is already sanitized by caller using SyncUtils.sanitizeMarkdownForGoogleDrive
    console.log(
      `Creating Google Doc "${title}" in folder ${folderId} with ${content.length} characters`,
    );
    return 'dummy-doc-id';
  }

  async updateGoogleDoc(file: TFile, metadata: any): Promise<void> {
    // TODO: Implement actual Google Docs update
    const content = await this.app.vault.read(file);
    const { markdown } = this.parseFrontmatter(content);
    const sanitizedMarkdown = SyncUtils.sanitizeMarkdownForGoogleDrive(markdown);
    console.log(`Updating Google Doc ${metadata.id} with ${sanitizedMarkdown.length} characters`);
  }

  async updateLocalFile(file: TFile, metadata: any): Promise<void> {
    // TODO: Implement actual Google Docs content fetch and local update
    console.log(`Updating local file ${file.path} from doc ${metadata.id}`);
  }

  /**
   * Create an enhanced notice with update capability
   */
  private createEnhancedNotice(message: string, timeout: number): EnhancedNotice {
    const notice = new Notice(message, timeout);
    return {
      notice,
      update: (newMessage: string) => {
        notice.setMessage(newMessage);
      },
      hide: () => {
        notice.hide();
      },
    };
  }

  /**
   * Format operation summary with detailed counts
   */
  private formatOperationSummary(baseMessage: string, summary: OperationSummary): string {
    const parts = [baseMessage];

    if (summary.total > 1) {
      const details = [];
      if (summary.created > 0) details.push(`${summary.created} created`);
      if (summary.updated > 0) details.push(`${summary.updated} updated`);
      if (summary.skipped > 0) details.push(`${summary.skipped} skipped`);
      if (summary.conflicted > 0) details.push(`${summary.conflicted} conflicts`);
      if (summary.errors > 0) details.push(`${summary.errors} errors`);

      if (details.length > 0) {
        parts.push(`\n📊 Summary: ${details.join(', ')}`);
      }
    }

    return parts.join('');
  }

  /**
   * Validate plugin settings
   */
  private validateSettings(): { valid: boolean; error?: string } {
    // Validate conflict policy
    if (!ConflictResolver.isValidPolicy(this.settings.conflictPolicy)) {
      return {
        valid: false,
        error: `Invalid conflict policy: ${this.settings.conflictPolicy}. Must be one of: prefer-doc, prefer-md, merge`,
      };
    }

    // Validate Drive folder ID format if provided
    if (this.settings.driveFolderId) {
      const folderIdPattern = /^[a-zA-Z0-9_-]{25,}$/;
      const isValidId = folderIdPattern.test(this.settings.driveFolderId.trim());
      const isValidName =
        this.settings.driveFolderId.trim().length > 0 && !this.settings.driveFolderId.includes('/');

      if (!isValidId && !isValidName) {
        return {
          valid: false,
          error:
            'Drive folder must be a valid folder name or folder ID (25+ alphanumeric characters)',
        };
      }
    }

    // Validate poll interval
    if (
      this.settings.pollInterval &&
      (this.settings.pollInterval < 5 || this.settings.pollInterval > 3600)
    ) {
      return {
        valid: false,
        error: 'Poll interval must be between 5 seconds and 1 hour (3600 seconds)',
      };
    }

    return { valid: true };
  }

  /**
   * Get actionable error message from BaseError
   */
  private getActionableErrorMessage(error: BaseError): string {
    const baseMessage = error.message;

    // Add specific guidance based on error type
    if (error.name === 'DriveAPIError') {
      const driveError = error as any;
      if (driveError.statusCode === 401) {
        return `${baseMessage}. Please re-authenticate with Google Drive.`;
      } else if (driveError.statusCode === 403) {
        return `${baseMessage}. Check if you have permission to access this document.`;
      } else if (driveError.statusCode === 404) {
        return `${baseMessage}. The document may have been deleted or moved.`;
      } else if (driveError.statusCode === 429) {
        return `${baseMessage}. Please wait a moment and try again.`;
      }
    } else if (error.name === 'AuthenticationError') {
      return `${baseMessage}. Please check your authentication in plugin settings.`;
    } else if (error.name === 'NetworkError') {
      return `${baseMessage}. Please check your internet connection and try again.`;
    }

    // Add correlation ID for debugging
    if (error.correlationId) {
      return `${baseMessage} (ID: ${error.correlationId.slice(-8)})`;
    }

    return baseMessage;
  }

  /**
   * Handle sync operation errors with enhanced feedback
   */
  private handleSyncError(error: any, file: TFile, notice: EnhancedNotice): void {
    const normalizedError = ErrorUtils.normalize(error, {
      operation: 'sync-document',
      resourceName: file.name,
      filePath: file.path,
    });

    const actionableMessage = this.getActionableErrorMessage(normalizedError);
    notice.update(`❌ Sync failed: ${actionableMessage}`);

    // Keep error notice visible longer for user to read
    setTimeout(() => notice.hide(), 10000);

    // Log detailed error for debugging
    console.error('Smart sync failed:', {
      file: file.path,
      error: normalizedError,
      correlationId: normalizedError.correlationId,
    });
  }

  /**
   * Multi-strategy browser opening with graceful fallback for auth flow
   */
  private async tryOpenBrowser(url: string): Promise<boolean> {
    const strategies = [
      // Strategy 1: Try Electron's shell API (most reliable on desktop)
      async () => {
        try {
          // Check if we're in Electron environment
          const electron = (window as any).require?.('electron');
          if (electron?.shell?.openExternal) {
            await electron.shell.openExternal(url);
            return true;
          }
        } catch (error) {
          console.log('Electron shell method failed:', error);
        }
        return false;
      },

      // Strategy 2: Try direct Node.js approach (fallback)
      async () => {
        try {
          const { exec } = (window as any).require?.('child_process') || {};
          if (exec) {
            const command =
              process.platform === 'darwin'
                ? `open "${url}"`
                : process.platform === 'win32'
                  ? `start "" "${url}"`
                  : `xdg-open "${url}"`;

            exec(command, (error: any) => {
              if (error) console.log('Command line browser open failed:', error);
            });
            return true;
          }
        } catch (error) {
          console.log('Command line method failed:', error);
        }
        return false;
      },

      // Strategy 3: Try window.open as last resort
      async () => {
        try {
          const opened = window.open(url, '_blank');
          if (opened) {
            // Check if popup was blocked
            setTimeout(() => {
              if (opened.closed) {
                console.log('Popup was blocked or closed');
              }
            }, 1000);
            return true;
          }
        } catch (error) {
          console.log('Window.open method failed:', error);
        }
        return false;
      },
    ];

    // Try each strategy in order
    for (const strategy of strategies) {
      try {
        const success = await strategy();
        if (success) {
          return true;
        }
      } catch (error) {
        console.log('Browser opening strategy failed:', error);
        continue;
      }
    }

    return false;
  }

  /**
   * Start authentication flow using UnifiedOAuthManager
   */
  async startAuthFlow(): Promise<void> {
    // Check if credentials are configured first
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice('Please configure Client ID and Client Secret in settings first');
      return;
    }

    try {
      // Check if already authenticated
      const hasValidCreds = await this.authManager.hasValidCredentials();
      if (hasValidCreds) {
        new Notice('Already authenticated! Use "Clear Authentication" to re-authenticate.');
        return;
      }

      // Create UnifiedOAuthManager with plugin flag to force iOS client
      const { ObsidianTokenStorage } = await import('./auth/ObsidianTokenStorage');
      const tokenStorage = new ObsidianTokenStorage(this, this.authManager.profile || 'default');
      const oauthManager = new UnifiedOAuthManager(tokenStorage, {
        isPlugin: true, // Force iOS client usage
      });

      // Get authorization URL with PKCE parameters
      const { url: authUrl, codeVerifier } = await oauthManager.getAuthorizationUrl();
      this.pkceVerifier = codeVerifier;

      // Try to open browser with fallback strategies
      const browserOpened = await this.tryOpenBrowser(authUrl);

      if (browserOpened) {
        new Notice('Browser opened for authentication. Complete the process in your browser to continue.', 10000);
      } else {
        // Fallback to manual code entry if browser fails to open
        new UnifiedAuthModal(this.app, authUrl, async (authCode: string) => {
          await this.handleAuthCallback(authCode, oauthManager);
        }).open();
      }
    } catch (error) {
      console.error('Auth flow failed:', error);
      new Notice(`Authentication failed: ${(error as Error).message}`);
    }
  }

  // Store PKCE verifier for this auth session
  private pkceVerifier: string | null = null;

  /**
   * Handle OAuth callback from protocol handler
   */
  private async handleOAuthCallback(params: Record<string, string>): Promise<void> {
    const { code, error } = params;
    
    if (error) {
      console.error('OAuth error:', error);
      new Notice(`Authentication failed: ${error}`);
      return;
    }
    
    if (!code) {
      console.error('No authorization code received');
      new Notice('Authentication failed: No authorization code received');
      return;
    }

    if (!this.pkceVerifier) {
      console.error('No PKCE verifier found');
      new Notice('Authentication failed: No PKCE verifier found. Please restart the authentication flow.');
      return;
    }

    const notice = new Notice('Processing OAuth callback...', 0);

    try {
      // Create UnifiedOAuthManager instance with plugin flag
      const { ObsidianTokenStorage } = await import('./auth/ObsidianTokenStorage');
      const tokenStorage = new ObsidianTokenStorage(this, this.authManager.profile || 'default');
      const oauthManager = new UnifiedOAuthManager(tokenStorage, {
        isPlugin: true, // Force iOS client usage
      });

      // Exchange code for tokens
      const credentials = await oauthManager.exchangeCodeForTokens(code, this.pkceVerifier);

      // Validate credentials
      if (!credentials.access_token || !credentials.refresh_token) {
        throw new Error('Invalid token response: missing required tokens');
      }

      await this.authManager.storeCredentials(credentials);

      // Clear PKCE verifier
      this.pkceVerifier = null;

      notice.setMessage('✅ Authentication successful!');
      setTimeout(() => notice.hide(), 3000);

      // Trigger settings page update if available
      if ((this as any).settingsTab) {
        (this as any).settingsTab.updateAuthStatus?.();
      }
    } catch (error) {
      console.error('OAuth callback failed:', error);
      notice.setMessage(`❌ Authentication failed: ${(error as Error).message}`);
      setTimeout(() => notice.hide(), 5000);
    }
  }

  /**
   * Handle auth callback with authorization code using UnifiedOAuthManager
   */
  private async handleAuthCallback(authCode: string, oauthManager: any): Promise<void> {
    const notice = new Notice('Exchanging authorization code...', 0);

    try {
      if (!this.pkceVerifier) {
        throw new Error('PKCE verifier not found. Please restart the authentication flow.');
      }

      // Exchange authorization code for tokens using UnifiedOAuthManager
      const credentials = await oauthManager.exchangeCodeForTokens(authCode, this.pkceVerifier);

      // Validate credentials before storing
      if (!credentials.access_token || !credentials.refresh_token) {
        throw new Error('Invalid token response: missing required tokens');
      }

      await this.authManager.storeCredentials(credentials);

      // Clear PKCE verifier
      this.pkceVerifier = null;

      notice.setMessage('✅ Authentication successful!');
      setTimeout(() => notice.hide(), 3000);

      // Trigger settings page update if available
      if ((this as any).settingsTab) {
        (this as any).settingsTab.updateAuthStatus?.();
      }
    } catch (error) {
      console.error('Token exchange failed:', error);
      notice.setMessage(`❌ Authentication failed: ${(error as Error).message}`);
      setTimeout(() => notice.hide(), 5000);
    }
  }

  /**
   * Clear authentication tokens
   */
  async clearAuthentication(): Promise<void> {
    try {
      await this.authManager.clearAllCredentials();
      new Notice('Authentication cleared successfully');
    } catch (error) {
      new Notice(`Failed to clear authentication: ${(error as Error).message}`);
    }
  }

  /**
   * Check authentication status
   */
  isAuthenticated(): boolean {
    return this.authManager?.isAuthenticated() || false;
  }

  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    error?: string;
    suggestions?: string[];
    nextSteps?: string[];
  }> {
    return await this.authManager.getAuthStatus();
  }

  /**
   * Copy text to clipboard with fallback
   */
  private async copyToClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      new Notice('URL copied to clipboard!');
    } catch (error) {
      console.warn('Failed to copy to clipboard:', error);
      new Notice('Failed to copy URL to clipboard');
    }
  }

  /**
   * Toggle background sync on/off
   */
  async toggleBackgroundSync(): Promise<void> {
    const currentlyEnabled = this.settings.backgroundSyncEnabled === true;
    this.settings.backgroundSyncEnabled = !currentlyEnabled;
    await this.saveSettings();

    const statusText = currentlyEnabled ? 'disabled' : 'enabled';
    new Notice(`Background sync ${statusText}`, 3000);

    // Update status immediately
    this.syncStatusManager.updateFromBackgroundState(
      this.backgroundSyncManager.getSyncStatus() as any,
      this.settings.backgroundSyncEnabled === true,
    );
  }

  /**
   * Force background sync to run immediately
   */
  async forceBackgroundSync(): Promise<void> {
    if (this.settings.backgroundSyncEnabled !== true) {
      new Notice('Background sync is disabled. Enable it in settings first.', 5000);
      return;
    }

    new Notice('Starting background sync...', 2000);

    try {
      await this.backgroundSyncManager.forceSyncNow();
    } catch (error) {
      const syncError = SyncErrorClassifier.classifyError(error as Error, {
        operation: 'force_background_sync',
      });
      this.syncStatusManager.handleSyncError(syncError);
    }
  }

  /**
   * Show detailed sync status information
   */
  showSyncStatus(): void {
    const status = this.backgroundSyncManager.getSyncStatus();
    const currentStatus = this.syncStatusManager.getCurrentStatus();

    let message = `**Background Sync Status**\n\n`;
    message += `• Status: ${currentStatus.state} - ${currentStatus.message}\n`;
    message += `• Enabled: ${status.enabled ? 'Yes' : 'No'}\n`;
    message += `• Currently Running: ${status.isRunning ? 'Yes' : 'No'}\n`;
    message += `• Files Queued: ${status.queuedCount}\n`;
    message += `• Failed Files: ${status.failedCount}\n`;

    if (status.lastSync) {
      message += `• Last Sync: ${status.lastSync.toLocaleString()}\n`;
    } else {
      message += `• Last Sync: Never\n`;
    }

    if (status.nextSyncIn !== null && status.enabled) {
      const nextSyncMinutes = Math.round(status.nextSyncIn / (60 * 1000));
      message += `• Next Sync: ${nextSyncMinutes > 0 ? nextSyncMinutes + ' minutes' : 'Soon'}\n`;
    }

    message += `\n**Details:** ${currentStatus.details}`;

    if (currentStatus.errorInfo) {
      message += `\n\n**Error Info:**\n`;
      message += `• Type: ${currentStatus.errorInfo.type}\n`;
      message += `• Can Recover: ${currentStatus.errorInfo.canRecover ? 'Yes' : 'No'}\n`;
      if (currentStatus.errorInfo.userAction) {
        message += `• Action: ${currentStatus.errorInfo.userAction}\n`;
      }
    }

    // Add manual sync status if running
    if (this.syncInProgress) {
      message += `\n\n**Manual Sync Status**\n`;
      message += `• Running: Yes\n`;
      message += `• Progress: ${this.currentSyncStatus.progress.current}/${this.currentSyncStatus.progress.total}\n`;
      message += `• Current Operation: ${this.currentSyncStatus.operation}\n`;
      
      if (this.currentSyncStatus.startTime > 0) {
        const elapsed = Math.round((Date.now() - this.currentSyncStatus.startTime) / 1000);
        message += `• Elapsed Time: ${elapsed}s\n`;
      }
    }

    new Notice(message, 15000);
  }






  /**
   * Build markdown content with frontmatter
   */
  private buildMarkdownWithFrontmatter(frontmatter: any, content: string): string {
    const yamlContent = Object.entries(frontmatter)
      .map(([key, value]) => {
        if (typeof value === 'string' && (value.includes('\n') || value.includes('"'))) {
          return `${key}: "${value.replace(/"/g, '\\"')}"`;
        }
        return `${key}: ${value}`;
      })
      .join('\n');

    return `---\n${yamlContent}\n---\n${content}`;
  }

  /**
   * Find or create Google Doc using folder-based strategy
   * Strategy:
   * 1. If frontmatter has google-doc-id, verify it exists and return it
   * 2. Otherwise, map local file path to Google Drive folder structure
   * 3. Search for existing document by name in the target folder
   * 4. If not found, create new document in the target folder
   * 5. Link the document by updating frontmatter
   */
  private async findOrCreateGoogleDoc(
    file: TFile, 
    driveAPI: DriveAPI, 
    frontmatter: any
  ): Promise<GoogleDocInfo | null> {
    try {
      // Step 1: If already linked, verify the existing link
      if (frontmatter['google-doc-id']) {
        try {
          const existingDoc = await driveAPI.getFile(frontmatter['google-doc-id']);
          if (existingDoc) {
            console.log(`File ${file.path} already linked to Google Doc: ${existingDoc.id}`);
            return {
              id: existingDoc.id,
              name: existingDoc.name,
              relativePath: file.path,
              parentId: '', // Not needed for existing docs
            };
          }
        } catch (error) {
          console.warn(`Linked Google Doc ${frontmatter['google-doc-id']} not found, will create new one`);
        }
      }

      // Step 2: Calculate target folder path in Google Drive
      const targetPath = this.calculateGoogleDrivePath(file);
      console.log(`Target Google Drive path for ${file.path}: ${targetPath}`);

      // Step 3: Ensure the folder structure exists in Google Drive
      const baseFolderId = await this.resolveDriveFolderId();
      const targetFolderId = await driveAPI.ensureNestedFolders(
        targetPath.folderPath, 
        baseFolderId
      );

      // Step 4: Search for existing document by name in the target folder
      const searchName = targetPath.documentName;
      console.log(`Searching for document "${searchName}" in folder ${targetFolderId}`);
      
      const existingDocs = await driveAPI.listDocsInFolder(targetFolderId);
      const existingDoc = existingDocs.find(doc => 
        doc.name === searchName || 
        doc.name === `${searchName}.md` ||
        doc.name.replace(/\.md$/, '') === searchName
      );

      if (existingDoc) {
        console.log(`Found existing Google Doc: ${existingDoc.id} (${existingDoc.name})`);
        return {
          id: existingDoc.id,
          name: existingDoc.name,
          relativePath: file.path,
          parentId: targetFolderId,
        };
      }

      // Step 5: Create new document if not found
      console.log(`Creating new Google Doc "${searchName}" in folder ${targetFolderId}`);
      const fileContent = await this.app.vault.read(file);
      const { markdown } = SyncUtils.parseFrontMatter(fileContent);
      
      const newDoc = await driveAPI.uploadMarkdownAsDoc(searchName, markdown, targetFolderId);
      console.log(`Created new Google Doc: ${newDoc.id} (${newDoc.name})`);

      return {
        id: newDoc.id,
        name: newDoc.name,
        relativePath: file.path,
        parentId: targetFolderId,
      };

    } catch (error) {
      console.error(`Failed to find or create Google Doc for ${file.path}:`, error);
      return null;
    }
  }

  /**
   * Calculate expected remote path for a local file (for move detection)
   */
  calculateExpectedRemotePath(localPath: string): string {
    const { folderPath, documentName } = this.calculateGoogleDrivePathFromPath(localPath);
    return folderPath ? `${folderPath}/${documentName}` : documentName;
  }

  /**
   * Calculate the target Google Drive path for a local file path
   * Maps vault file structure to Google Drive folder structure
   */
  private calculateGoogleDrivePathFromPath(localPath: string): { folderPath: string; documentName: string } {
    // Remove baseVaultFolder from the path if it exists
    if (this.settings.baseVaultFolder) {
      const baseFolder = this.settings.baseVaultFolder.replace(/\/$/, ''); // Remove trailing slash
      if (localPath.startsWith(baseFolder + '/')) {
        localPath = localPath.substring(baseFolder.length + 1);
      }
    }

    // Split into folder path and filename
    const pathParts = localPath.split('/');
    const fileName = pathParts.pop() || '';
    const folderPath = pathParts.join('/');

    // Convert filename to document name (remove .md extension)
    let documentName = fileName.replace(/\.md$/, '');
    
    // Convert underscores to spaces for Google Docs naming convention
    documentName = documentName.replace(/_/g, ' ');

    return {
      folderPath: folderPath || '', // Empty string means root of Drive folder
      documentName,
    };
  }

  /**
   * Calculate the target Google Drive path for a local file
   * Maps vault file structure to Google Drive folder structure
   */
  private calculateGoogleDrivePath(file: TFile): { folderPath: string; documentName: string } {
    let filePath = file.path;
    console.log(`📂 calculateGoogleDrivePath for ${file.path}:`);
    console.log(`  - Initial filePath: "${filePath}"`);
    console.log(`  - baseVaultFolder setting: "${this.settings.baseVaultFolder || '(not set)'}"`);
    
    // Remove baseVaultFolder from the path if it exists
    if (this.settings.baseVaultFolder && this.settings.baseVaultFolder.trim() !== '') {
      const baseFolder = this.settings.baseVaultFolder.replace(/\/$/, ''); // Remove trailing slash
      console.log(`  - Processed baseFolder: "${baseFolder}"`);
      
      if (filePath.startsWith(baseFolder + '/')) {
        filePath = filePath.substring(baseFolder.length + 1);
        console.log(`  - After removing base folder: "${filePath}"`);
      } else {
        console.log(`  - File path doesn't start with base folder, keeping as-is`);
      }
    } else {
      console.log(`  - No base vault folder configured, using full path`);
    }

    // Split into folder path and filename
    const pathParts = filePath.split('/');
    const fileName = pathParts.pop() || file.name;
    const folderPath = pathParts.join('/');

    console.log(`  - Path parts: [${pathParts.map(p => `"${p}"`).join(', ')}]`);
    console.log(`  - fileName: "${fileName}"`);
    console.log(`  - folderPath: "${folderPath}"`);

    // Convert filename to document name (remove .md extension)
    let documentName = fileName.replace(/\.md$/, '');
    
    // Convert underscores to spaces for Google Docs naming convention
    documentName = documentName.replace(/_/g, ' ');

    console.log(`  - Final documentName: "${documentName}"`);
    console.log(`  - Final folderPath: "${folderPath}"`);

    return {
      folderPath: folderPath || '', // Empty string means root of Drive folder
      documentName,
    };
  }

  /**
   * Get document revision information
   */
  private async getDocumentRevision(docId: string, driveAPI: DriveAPI): Promise<string> {
    try {
      const fileInfo = await driveAPI.getFile(docId);
      return fileInfo.modifiedTime || '';
    } catch (error) {
      console.warn(`Failed to get revision for doc ${docId}:`, error);
      return '';
    }
  }

  /**
   * Sync local file move to Google Drive
   */
  private async syncLocalMoveToRemote(file: TFile, docId: string, driveAPI: DriveAPI): Promise<void> {
    try {
      // Calculate target folder in Google Drive based on new local path
      const targetPath = this.calculateGoogleDrivePath(file);
      
      // Ensure target folder exists
      const targetFolderId = await driveAPI.ensureNestedFolders(
        targetPath.folderPath, 
        this.settings.driveFolderId
      );
      
      // Move the Google Doc to the new folder
      await driveAPI.moveFile(docId, targetFolderId);
      
      console.log(`✅ Moved Google Doc ${docId} to match local file location: ${file.path}`);
    } catch (error) {
      console.error(`Failed to sync local move to remote for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Sync remote file move to local (create new local file at new location)
   */
  private async syncRemoteMoveToLocal(file: TFile, oldRemotePath: string, driveAPI: DriveAPI): Promise<void> {
    try {
      // Get current remote path
      const docId = (await this.getGoogleDocsMetadata(file))?.id;
      if (!docId) {
        throw new Error('No Google Doc ID found for file');
      }
      
      const baseFolderId = await this.resolveDriveFolderId();
      const currentRemotePath = await driveAPI.getFilePath(docId, baseFolderId);
      
      // Calculate what the new local path should be
      const newLocalPath = this.calculateLocalPathFromRemote(currentRemotePath);
      
      // Validate that we actually need to move the file
      if (newLocalPath === file.path) {
        console.log(`✅ File ${file.path} already at correct location, no move needed`);
        return;
      }
      
      // Check if destination already exists (to avoid collision)
      const existingFile = this.app.vault.getAbstractFileByPath(newLocalPath);
      if (existingFile && existingFile !== file) {
        throw new Error(`Destination file already exists at ${newLocalPath}`);
      }
      
      // Need to move/rename the local file
      const newTFile = await this.app.vault.rename(file, newLocalPath);
      console.log(`✅ Moved local file ${file.path} → ${newLocalPath} to match remote location`);
    } catch (error) {
      console.error(`Failed to sync remote move to local for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Resolve move conflicts (both sides moved)
   */
  private async resolveMoveConflict(file: TFile, syncState: SyncState, driveAPI: DriveAPI): Promise<boolean> {
    try {
      // Use last-write-wins approach for move conflicts
      // Check which side was modified more recently
      const localMtime = file.stat.mtime;
      const docId = (await this.getGoogleDocsMetadata(file))?.id;
      if (!docId) {
        throw new Error('No Google Doc ID found for file');
      }
      
      const fileInfo = await driveAPI.getFile(docId);
      const remoteMtime = new Date(fileInfo.modifiedTime).getTime();
      
      if (localMtime > remoteMtime) {
        // Local is newer - sync local move to remote
        await this.syncLocalMoveToRemote(file, docId, driveAPI);
        console.log(`✅ Move conflict resolved: Used local location for ${file.path}`);
      } else {
        // Remote is newer - sync remote move to local
        await this.syncRemoteMoveToLocal(file, syncState.remoteMoveFrom!, driveAPI);
        console.log(`✅ Move conflict resolved: Used remote location for ${file.path}`);
      }
      
      return true;
    } catch (error) {
      console.error(`Failed to resolve move conflict for ${file.path}:`, error);
      return false;
    }
  }

  /**
   * Calculate local path from Google Drive path
   */
  private calculateLocalPathFromRemote(remotePath: string): string {
    // Add base vault folder if configured
    let localPath = remotePath;
    
    if (this.settings.baseVaultFolder) {
      localPath = `${this.settings.baseVaultFolder}/${remotePath}`;
    }
    
    // Convert spaces back to underscores if needed
    localPath = localPath.replace(/ /g, '_');
    
    // Ensure .md extension
    if (!localPath.endsWith('.md')) {
      localPath += '.md';
    }
    
    return localPath;
  }

  /**
   * Get or create local trash folder for archived files
   */
  private async getLocalTrashFolder(): Promise<string> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const trashPath = `.trash/${today}`;
    
    try {
      // Check if folder exists
      const existingFolder = this.app.vault.getAbstractFileByPath(trashPath);
      if (!existingFolder) {
        // Create the folder structure
        await this.app.vault.createFolder(trashPath);
      }
      return trashPath;
    } catch (error) {
      console.error('Failed to create local trash folder:', error);
      throw error;
    }
  }

  /**
   * Get or create Google Drive trash folder for archived files
   */
  private async getRemoteTrashFolder(driveAPI: DriveAPI): Promise<string> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const trashPath = `Obsidian Trash/${today}`;
    
    try {
      // Create the nested folder structure
      const baseFolderId = await this.resolveDriveFolderId();
      const trashFolderId = await driveAPI.ensureNestedFolders(trashPath, baseFolderId);
      return trashFolderId;
    } catch (error) {
      console.error('Failed to create remote trash folder:', error);
      throw error;
    }
  }

  /**
   * Archive local file to trash (soft delete)
   */
  private async archiveLocalFile(file: TFile, reason: string): Promise<string> {
    try {
      const trashFolder = await this.getLocalTrashFolder();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivedFileName = `${file.basename}_${timestamp}.md`;
      const archivedPath = `${trashFolder}/${archivedFileName}`;
      
      // Read content before moving
      const content = await this.app.vault.read(file);
      
      // Add deletion metadata to frontmatter
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);
      const updatedFrontmatter = {
        ...frontmatter,
        'deletion-scheduled': new Date().toISOString(),
        'deletion-reason': reason,
        'original-path': file.path,
        'archived-from': 'local-delete'
      };
      
      // Create archived file with updated metadata
      const archivedContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
      await this.app.vault.create(archivedPath, archivedContent);
      
      // Remove original file
      await this.app.vault.delete(file);
      
      console.log(`📁 Archived local file: ${file.path} → ${archivedPath}`);
      return archivedPath;
    } catch (error) {
      console.error(`Failed to archive local file ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Archive Google Doc to trash (soft delete)
   */
  private async archiveRemoteFile(docId: string, fileName: string, reason: string, driveAPI: DriveAPI): Promise<string> {
    try {
      const trashFolderId = await this.getRemoteTrashFolder(driveAPI);
      
      // Move the Google Doc to trash folder
      await driveAPI.moveFile(docId, trashFolderId);
      
      // Update document properties to track deletion
      await driveAPI.updateDocumentProperties(docId, {
        'deletion-scheduled': new Date().toISOString(),
        'deletion-reason': reason,
        'archived-from': 'remote-delete'
      });
      
      console.log(`📁 Archived remote file: ${fileName} (${docId}) to Google Drive trash`);
      return trashFolderId;
    } catch (error) {
      console.error(`Failed to archive remote file ${fileName} (${docId}):`, error);
      throw error;
    }
  }

  /**
   * Restore file from local trash
   */
  private async restoreLocalFile(archivedPath: string, originalPath?: string): Promise<string> {
    try {
      const archivedFile = this.app.vault.getAbstractFileByPath(archivedPath);
      if (!archivedFile || !(archivedFile instanceof TFile)) {
        throw new Error('Archived file not found');
      }
      
      // Read archived content
      const content = await this.app.vault.read(archivedFile);
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);
      
      // Determine restore path
      const restorePath = originalPath || frontmatter['original-path'] || archivedFile.basename.replace(/_\d{4}-\d{2}-\d{2}T[\d-]+$/, '.md');
      
      // Remove deletion metadata
      const restoredFrontmatter = { ...frontmatter };
      delete restoredFrontmatter['deletion-scheduled'];
      delete restoredFrontmatter['deletion-reason'];
      delete restoredFrontmatter['original-path'];
      delete restoredFrontmatter['archived-from'];
      
      // Create restored file
      const restoredContent = SyncUtils.buildMarkdownWithFrontmatter(restoredFrontmatter, markdown);
      
      // Check if target path exists
      if (this.app.vault.getAbstractFileByPath(restorePath)) {
        // Generate unique name
        const baseName = restorePath.replace(/\.md$/, '');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const uniquePath = `${baseName}_restored_${timestamp}.md`;
        await this.app.vault.create(uniquePath, restoredContent);
        console.log(`🔄 Restored file to unique path: ${archivedPath} → ${uniquePath}`);
        return uniquePath;
      } else {
        await this.app.vault.create(restorePath, restoredContent);
        console.log(`🔄 Restored file: ${archivedPath} → ${restorePath}`);
      }
      
      // Remove archived file
      await this.app.vault.delete(archivedFile);
      
      return restorePath;
    } catch (error) {
      console.error(`Failed to restore file ${archivedPath}:`, error);
      throw error;
    }
  }

  /**
   * Handle remote delete operations (delete vs edit conflict resolution)
   */
  private async handleRemoteDelete(file: TFile, syncState: SyncState, driveAPI: DriveAPI): Promise<{archived: boolean, restored: boolean, reason: string}> {
    try {
      const metadata = await this.getGoogleDocsMetadata(file);
      if (!metadata) {
        return { archived: false, restored: false, reason: 'no metadata' };
      }

      // Check if local file has been modified since deletion
      const localMtime = file.stat.mtime;
      const deleteTime = syncState.remoteDeletedAt?.getTime() || Date.now();
      const hasLocalEditsAfterDelete = localMtime > deleteTime;

      // Delete vs Edit conflict resolution: ALWAYS prefer the edit
      if (hasLocalEditsAfterDelete || syncState.hasLocalChanges) {
        console.log(`🔄 Delete vs Edit conflict: Local file has edits after remote deletion - restoring Google Doc`);
        
        if (this.settings.deleteHandling === 'ignore') {
          console.log(`⏸️ Delete handling set to ignore - skipping restore`);
          return { archived: false, restored: false, reason: 'delete handling ignored' };
        }

        // Restore the Google Doc by recreating it from local content
        await this.recreateDeletedGoogleDoc(file, metadata.id, driveAPI);
        return { archived: false, restored: true, reason: 'restored from delete conflict' };
      }

      // No local edits - proceed with deletion based on settings
      switch (this.settings.deleteHandling) {
        case 'archive':
          console.log(`📁 Archiving local file due to remote deletion: ${file.path}`);
          await this.archiveLocalFile(file, `Remote ${syncState.deleteReason === 'remote-trashed' ? 'trashed' : 'deleted'}: ${syncState.remoteDeletedAt?.toISOString()}`);
          return { archived: true, restored: false, reason: 'archived due to remote delete' };

        case 'sync':
          console.log(`🗑️ Deleting local file due to remote deletion: ${file.path}`);
          if (this.settings.showDeletionWarnings) {
            // In a real implementation, we'd show a confirmation dialog here
            // For now, we'll proceed with deletion
          }
          await this.app.vault.delete(file);
          return { archived: false, restored: false, reason: 'deleted due to remote delete' };

        case 'ignore':
        default:
          console.log(`⏸️ Ignoring remote deletion of: ${file.path}`);
          return { archived: false, restored: false, reason: 'delete handling ignored' };
      }
    } catch (error) {
      console.error(`Failed to handle remote delete for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Recreate a deleted Google Doc from local content
   */
  private async recreateDeletedGoogleDoc(file: TFile, originalDocId: string, driveAPI: DriveAPI): Promise<void> {
    try {
      // Get current content
      const content = await this.app.vault.read(file);
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);

      // Calculate target Google Drive path
      const { folderPath, documentName } = this.calculateGoogleDrivePath(file);
      
      // Ensure target folder exists
      const baseFolderId = await this.resolveDriveFolderId();
      const targetFolderId = await driveAPI.ensureNestedFolders(folderPath, baseFolderId);

      // Create new Google Doc
      const newDocId = await driveAPI.createGoogleDoc(documentName, markdown, targetFolderId);

      // Update frontmatter with new Google Doc information
      const updatedFrontmatter = {
        ...frontmatter,
        'google-doc-id': newDocId,
        'google-doc-url': `https://docs.google.com/document/d/${newDocId}/edit`,
        'google-doc-title': documentName,
        'last-synced': new Date().toISOString(),
        'last-sync-path': file.path,
        'sync-revision': (frontmatter['sync-revision'] || 0) + 1,
        'restored-from-delete': new Date().toISOString(),
        'original-doc-id': originalDocId, // Track the original for reference
      };

      // Update local file with new metadata
      const updatedContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
      await this.app.vault.modify(file, updatedContent);

      console.log(`✅ Recreated Google Doc: ${file.path} → ${newDocId} (was ${originalDocId})`);
    } catch (error) {
      console.error(`Failed to recreate deleted Google Doc for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Show trash folder in Obsidian
   */
  async showTrashFolder(): Promise<void> {
    try {
      const trashFolder = this.app.vault.getAbstractFileByPath('.trash');
      if (!trashFolder) {
        new Notice('No trash folder found. Archive some files first.', 5000);
        return;
      }

      // Open the trash folder in the file explorer
      this.app.workspace.getLeaf().openFile(trashFolder as any);
      new Notice('Opened trash folder. Archived files are organized by date.', 3000);
    } catch (error) {
      console.error('Failed to show trash folder:', error);
      new Notice('Failed to open trash folder');
    }
  }

  /**
   * Empty trash folder with confirmation
   */
  async emptyTrash(): Promise<void> {
    try {
      const trashFolder = this.app.vault.getAbstractFileByPath('.trash');
      if (!trashFolder) {
        new Notice('No trash folder found - nothing to empty', 3000);
        return;
      }

      // Count files in trash
      const trashFiles = this.app.vault.getAllLoadedFiles()
        .filter(file => file.path.startsWith('.trash/'))
        .filter(file => file instanceof TFile);

      if (trashFiles.length === 0) {
        new Notice('Trash folder is already empty', 3000);
        return;
      }

      if (this.settings.showDeletionWarnings) {
        const confirmed = confirm(
          `Permanently delete ${trashFiles.length} files from trash?\n\nThis action cannot be undone.`
        );
        if (!confirmed) {
          return;
        }
      }

      // Delete all files in trash
      for (const file of trashFiles) {
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
        }
      }

      // Clean up empty directories
      await this.app.vault.delete(trashFolder);

      new Notice(`Permanently deleted ${trashFiles.length} files from trash`, 3000);
      console.log(`🗑️ Emptied trash: ${trashFiles.length} files permanently deleted`);
    } catch (error) {
      console.error('Failed to empty trash:', error);
      new Notice('Failed to empty trash');
    }
  }

  /**
   * Show modal to restore files from trash
   */
  async showRestoreModal(): Promise<void> {
    try {
      const trashFiles = this.app.vault.getAllLoadedFiles()
        .filter(file => file.path.startsWith('.trash/'))
        .filter(file => file instanceof TFile) as TFile[];

      if (trashFiles.length === 0) {
        new Notice('No files found in trash to restore', 3000);
        return;
      }

      // For now, just show a list of files and restore the first one as an example
      // In a full implementation, this would be a proper modal with selection
      const fileList = trashFiles.map(f => f.path).join('\n');
      const message = `Files in trash:\n${fileList}\n\nRestoring first file as example...`;
      new Notice(message, 5000);

      // Restore first file as example
      if (trashFiles.length > 0) {
        const restoredPath = await this.restoreLocalFile(trashFiles[0].path);
        new Notice(`Restored: ${restoredPath}`, 3000);
      }
    } catch (error) {
      console.error('Failed to show restore modal:', error);
      new Notice('Failed to show restore options');
    }
  }

  /**
   * Clean cross-workspace document links from all markdown files
   */
  async cleanCrossWorkspaceLinks(): Promise<void> {
    try {
      console.log('🧹 Starting cross-workspace document link cleaning...');
      
      const localState = await this.discoverLocalFiles();
      const driveAPI = await this.getAuthenticatedDriveAPI();
      
      let cleanedCount = 0;
      let checkedCount = 0;
      
      for (const localLinked of localState.linked) {
        checkedCount++;
        console.log(`🔍 Checking document ${localLinked.docId} in ${localLinked.path}...`);
        
        const isValidWorkspace = await driveAPI.validateDocumentInCurrentWorkspace(localLinked.docId);
        
        if (!isValidWorkspace) {
          console.log(`🚫 Document ${localLinked.docId} not in current workspace, cleaning from ${localLinked.path}`);
          
          // Read the file content
          const content = await this.app.vault.read(localLinked.file);
          
          // Remove the google-doc-id from frontmatter
          const updatedContent = this.removeFrontmatterField(content, 'google-doc-id');
          
          // Also remove other related fields
          const finalContent = this.removeFrontmatterField(
            this.removeFrontmatterField(
              this.removeFrontmatterField(updatedContent, 'google-doc-url'),
              'google-doc-title'
            ),
            'last-synced'
          );
          
          // Write the updated content back
          await this.app.vault.modify(localLinked.file, finalContent);
          
          cleanedCount++;
          console.log(`✅ Cleaned cross-workspace link from ${localLinked.path}`);
        }
      }
      
      const message = `Cross-workspace link cleanup complete!\nChecked: ${checkedCount} files\nCleaned: ${cleanedCount} files`;
      console.log(`🧹 ${message}`);
      new Notice(message, 5000);
      
    } catch (error) {
      console.error('Failed to clean cross-workspace links:', error);
      new Notice(`Failed to clean cross-workspace links: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Remove a specific field from YAML frontmatter
   */
  private removeFrontmatterField(content: string, fieldName: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inFrontmatter = false;
    let frontmatterEnded = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (i === 0 && line === '---') {
        inFrontmatter = true;
        result.push(line);
        continue;
      }
      
      if (inFrontmatter && line === '---') {
        frontmatterEnded = true;
        inFrontmatter = false;
        result.push(line);
        continue;
      }
      
      if (inFrontmatter) {
        // Check if this line contains the field we want to remove
        const trimmed = line.trim();
        if (trimmed.startsWith(`${fieldName}:`) || trimmed.startsWith(`'${fieldName}':`) || trimmed.startsWith(`"${fieldName}":`)) {
          // Skip this line (remove the field)
          console.log(`Removing field: ${fieldName} from line: ${line}`);
          continue;
        }
      }
      
      result.push(line);
    }
    
    return result.join('\n');
  }

  /**
   * Migrate folders that were incorrectly created in Google Drive root
   * to the proper Synaptiq Ops folder location
   */
  async migrateMisplacedFolders(): Promise<void> {
    try {
      console.log('📁 Starting folder migration from Google Drive root...');
      
      if (!this.settings.driveFolderId || this.settings.driveFolderId.trim() === '') {
        const message = 'No target folder configured. Please set the Synaptiq Ops folder ID in settings first.';
        console.error('❌ ' + message);
        new Notice(message, 5000);
        return;
      }

      const driveAPI = await this.getAuthenticatedDriveAPI();
      const targetFolderId = this.settings.driveFolderId;
      
      console.log(`🎯 Target folder: ${targetFolderId}`);
      
      // Get folders from the root that might belong in our target folder
      console.log('🔍 Searching for folders in Google Drive root...');
      const rootFolders = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent('mimeType="application/vnd.google-apps.folder" and "root" in parents')}&fields=files(id,name,parents,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
        headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
      });
      
      if (!rootFolders.ok) {
        throw new Error(`Failed to search root folders: ${rootFolders.status} ${rootFolders.statusText}`);
      }
      
      const rootFoldersData = await rootFolders.json();
      const misplacedFolders = rootFoldersData.files || [];
      
      console.log(`📂 Found ${misplacedFolders.length} folders in root`);
      
      if (misplacedFolders.length === 0) {
        const message = 'No folders found in Google Drive root to migrate.';
        console.log('✅ ' + message);
        new Notice(message, 3000);
        return;
      }
      
      let migratedCount = 0;
      let skippedCount = 0;
      
      for (const folder of misplacedFolders) {
        console.log(`🔍 Examining folder: "${folder.name}" (${folder.id})`);
        
        // Skip system/default folders that should stay in root
        const systemFolders = ['My Drive', 'Shared drives', 'Computers', 'Trash'];
        if (systemFolders.includes(folder.name)) {
          console.log(`⏭️  Skipping system folder: ${folder.name}`);
          skippedCount++;
          continue;
        }
        
        // Check if this folder contains any Google Docs that might be related to our workspace
        try {
          const docsInFolder = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`mimeType="application/vnd.google-apps.document" and "${folder.id}" in parents`)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
            headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
          });
          
          if (docsInFolder.ok) {
            const docsData = await docsInFolder.json();
            const docCount = docsData.files?.length || 0;
            
            if (docCount > 0) {
              console.log(`📄 Folder "${folder.name}" contains ${docCount} documents, migrating...`);
              
              // Move the folder to the target location
              await fetch(`https://www.googleapis.com/drive/v3/files/${folder.id}?addParents=${encodeURIComponent(targetFolderId)}&removeParents=root&supportsAllDrives=true`, {
                method: 'PATCH',
                headers: { 
                  'Authorization': `Bearer ${driveAPI.getAccessToken()}`,
                  'Content-Type': 'application/json'
                }
              });
              
              console.log(`✅ Migrated folder "${folder.name}" (${folder.id}) to target folder`);
              migratedCount++;
            } else {
              console.log(`📭 Folder "${folder.name}" is empty, skipping`);
              skippedCount++;
            }
          }
        } catch (error) {
          console.warn(`⚠️ Error checking contents of folder "${folder.name}":`, error);
          skippedCount++;
        }
      }
      
      const message = `Folder migration complete!\nMigrated: ${migratedCount} folders\nSkipped: ${skippedCount} folders`;
      console.log(`📁 ${message}`);
      new Notice(message, 5000);
      
    } catch (error) {
      console.error('Failed to migrate folders:', error);
      new Notice(`Failed to migrate folders: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Diagnose workspace access and document parent folder issues
   */
  async diagnoseWorkspaceAccess(): Promise<void> {
    try {
      console.log('🔍 Starting workspace access diagnosis...');
      
      const driveAPI = await this.getAuthenticatedDriveAPI();
      
      // Get user info and workspace details
      console.log('👤 Getting authenticated user information...');
      const userResponse = await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
        headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
      });
      
      if (!userResponse.ok) {
        throw new Error(`Failed to get user info: ${userResponse.status} ${userResponse.statusText}`);
      }
      
      const userInfo = await userResponse.json();
      const email = userInfo.user?.emailAddress || 'Unknown';
      const displayName = userInfo.user?.displayName || 'Unknown';
      const domain = email.includes('@') ? email.split('@')[1] : 'Unknown';
      
      console.log('🏢 Current Workspace Information:');
      console.log(`   📧 Email: ${email}`);
      console.log(`   👤 Name: ${displayName}`);
      console.log(`   🌐 Domain: ${domain}`);
      console.log(`   💾 Storage Used: ${userInfo.storageQuota?.usage || 'Unknown'} bytes`);
      
      // Check target folder access
      const targetFolderId = this.settings.driveFolderId;
      console.log(`\n🎯 Target Folder Analysis:`);
      console.log(`   📁 Configured ID: ${targetFolderId || 'Not configured'}`);
      
      if (targetFolderId) {
        try {
          const folderInfo = await driveAPI.getFile(targetFolderId);
          console.log(`   ✅ Folder accessible: "${folderInfo.name}"`);
          console.log(`   📂 Parents: ${JSON.stringify(folderInfo.parents || [])}`);
        } catch (error) {
          console.log(`   ❌ Cannot access target folder: ${error}`);
        }
      }
      
      // Analyze document parent patterns
      console.log(`\n📊 Document Parent Folder Analysis:`);
      const allDocsResponse = await fetch('https://www.googleapis.com/drive/v3/files?q=mimeType="application/vnd.google-apps.document"&fields=files(id,name,parents)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true', {
        headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
      });
      
      if (allDocsResponse.ok) {
        const docsData = await allDocsResponse.json();
        const docs = docsData.files || [];
        
        // Count documents by parent folder
        const parentCounts: { [key: string]: { count: number; docs: string[] } } = {};
        
        for (const doc of docs) {
          const parents = doc.parents || ['root'];
          for (const parent of parents) {
            if (!parentCounts[parent]) {
              parentCounts[parent] = { count: 0, docs: [] };
            }
            parentCounts[parent].count++;
            parentCounts[parent].docs.push(`${doc.name} (${doc.id})`);
          }
        }
        
        console.log(`   📄 Total accessible documents: ${docs.length}`);
        console.log(`   📁 Documents by parent folder:`);
        
        // Show top parent folders
        const sortedParents = Object.entries(parentCounts)
          .sort(([,a], [,b]) => b.count - a.count)
          .slice(0, 10);
          
        for (const [parentId, info] of sortedParents) {
          console.log(`      ${parentId}: ${info.count} documents`);
          if (info.count <= 5) {
            for (const docName of info.docs) {
              console.log(`         - ${docName}`);
            }
          } else {
            console.log(`         - ${info.docs.slice(0, 3).join(', ')}, and ${info.count - 3} more...`);
          }
        }
        
        // Highlight the most common non-target parent
        const mainParent = sortedParents[0];
        if (mainParent && mainParent[0] !== targetFolderId) {
          console.log(`\n⚠️  ISSUE DETECTED:`);
          console.log(`   📁 Most documents (${mainParent[1].count}) are in folder: ${mainParent[0]}`);
          console.log(`   🎯 But target folder is configured as: ${targetFolderId}`);
          console.log(`   💡 This suggests a workspace/authentication mismatch!`);
        }
      }
      
      // Search specifically for "The Synaptitudes"
      console.log(`\n🔍 Searching for "The Synaptitudes" document:`);
      const synaptitudesSearch = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent('name contains "Synaptitudes"')}&fields=files(id,name,parents,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
        headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
      });
      
      if (synaptitudesSearch.ok) {
        const searchData = await synaptitudesSearch.json();
        const results = searchData.files || [];
        
        if (results.length > 0) {
          console.log(`   ✅ Found ${results.length} matching documents:`);
          for (const doc of results) {
            console.log(`      📄 "${doc.name}" (${doc.id})`);
            console.log(`         Parents: ${JSON.stringify(doc.parents || [])}`);
            console.log(`         Link: ${doc.webViewLink || 'No link'}`);
          }
        } else {
          console.log(`   ❌ No documents found matching "Synaptitudes"`);
          console.log(`   💡 This document may be in a different workspace or account`);
        }
      }
      
      const message = `Workspace diagnosis complete! Check console for detailed results.\nUser: ${displayName} (${email})\nDomain: ${domain}`;
      console.log(`\n🔍 ${message}`);
      new Notice(message, 10000);
      
    } catch (error) {
      console.error('Failed to diagnose workspace access:', error);
      new Notice(`Failed to diagnose workspace access: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Switch the plugin configuration to use the folder where most documents are actually located
   */
  async switchToDocumentFolder(): Promise<void> {
    try {
      console.log('🔄 Analyzing document locations to find the correct folder...');
      
      const driveAPI = await this.getAuthenticatedDriveAPI();
      
      // Get all accessible documents and analyze their parent folders
      const allDocsResponse = await fetch('https://www.googleapis.com/drive/v3/files?q=mimeType="application/vnd.google-apps.document"&fields=files(id,name,parents)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true', {
        headers: { 'Authorization': `Bearer ${driveAPI.getAccessToken()}` }
      });
      
      if (!allDocsResponse.ok) {
        throw new Error(`Failed to get documents: ${allDocsResponse.status} ${allDocsResponse.statusText}`);
      }
      
      const docsData = await allDocsResponse.json();
      const docs = docsData.files || [];
      
      if (docs.length === 0) {
        new Notice('No documents found to analyze', 5000);
        return;
      }
      
      // Count documents by parent folder
      const parentCounts: { [key: string]: number } = {};
      
      for (const doc of docs) {
        const parents = doc.parents || ['root'];
        for (const parent of parents) {
          parentCounts[parent] = (parentCounts[parent] || 0) + 1;
        }
      }
      
      // Find the folder with the most documents
      const sortedParents = Object.entries(parentCounts)
        .sort(([,a], [,b]) => b - a);
      
      if (sortedParents.length === 0) {
        new Notice('No parent folders found', 5000);
        return;
      }
      
      const [mostCommonParent, docCount] = sortedParents[0];
      
      console.log(`📊 Document distribution analysis:`);
      for (const [parentId, count] of sortedParents.slice(0, 5)) {
        console.log(`   ${parentId}: ${count} documents`);
      }
      
      console.log(`\n🎯 Most documents (${docCount}) are in folder: ${mostCommonParent}`);
      
      // Get folder info if it's not 'root'
      let folderName = 'Google Drive Root';
      if (mostCommonParent !== 'root') {
        try {
          const folderInfo = await driveAPI.getFile(mostCommonParent);
          folderName = folderInfo.name || 'Unnamed Folder';
        } catch (error) {
          console.warn('Could not get folder name:', error);
        }
      }
      
      const currentFolder = this.settings.driveFolderId;
      
      if (mostCommonParent === currentFolder) {
        const message = `Already configured to use the correct folder: ${folderName} (${mostCommonParent})`;
        console.log(`✅ ${message}`);
        new Notice(message, 5000);
        return;
      }
      
      // Ask user for confirmation
      const confirmed = confirm(
        `Switch from current folder:\n` +
        `"${currentFolder || 'Not set'}"\n\n` +
        `To folder with most documents (${docCount} docs):\n` +
        `"${folderName}" (${mostCommonParent})\n\n` +
        `This will update your plugin settings. Continue?`
      );
      
      if (!confirmed) {
        new Notice('Operation cancelled', 3000);
        return;
      }
      
      // Update the settings
      this.settings.driveFolderId = mostCommonParent;
      await this.saveSettings();
      
      console.log(`✅ Updated Drive folder ID to: ${mostCommonParent}`);
      console.log(`📁 Folder name: ${folderName}`);
      console.log(`📄 This folder contains ${docCount} documents`);
      
      const message = `Switched to folder: ${folderName}\nThis folder contains ${docCount} documents`;
      new Notice(message, 8000);
      
      // Suggest running a sync
      setTimeout(() => {
        new Notice('Consider running a sync to see the documents from this folder', 5000);
      }, 2000);
      
    } catch (error) {
      console.error('Failed to switch to document folder:', error);
      new Notice(`Failed to switch folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Unified authentication modal following common "browser didn't open" UX pattern
 * Assumes browser opened successfully by default, with fallback options
 */
class UnifiedAuthModal extends Modal {
  private authUrl: string;
  private onAuthCode: (code: string) => void;

  constructor(app: any, authUrl: string, onAuthCode: (code: string) => void) {
    super(app);
    this.authUrl = authUrl;
    this.onAuthCode = onAuthCode;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Complete Authentication' });

    // Primary instructions assuming browser opened
    const primaryInstructions = contentEl.createDiv({ cls: 'auth-primary-instructions' });
    primaryInstructions.createEl('p', {
      text: 'Complete the Google authentication in your browser, then paste the authorization code below:'
    });

    // Auth code input (primary focus)
    const codeContainer = contentEl.createDiv({ cls: 'auth-code-container' });
    codeContainer.createEl('label', { text: 'Authorization Code:' });

    const codeInput = codeContainer.createEl('input', {
      type: 'text',
      placeholder: 'Paste your authorization code here...',
      cls: 'auth-code-input',
    });

    // Progress indicator
    const statusDiv = contentEl.createDiv({ cls: 'auth-status' });

    // Main action buttons
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const submitButton = buttonContainer.createEl('button', {
      text: 'Authenticate',
      cls: 'mod-cta',
    });
    submitButton.onclick = () => {
      const code = codeInput.value.trim();
      if (!code) {
        statusDiv.setText('Please enter the authorization code');
        statusDiv.className = 'auth-status error';
        return;
      }

      statusDiv.setText('Processing...');
      statusDiv.className = 'auth-status processing';

      this.onAuthCode(code);
      this.close();
    };

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.onclick = () => this.close();

    // Fallback section for "browser didn't open" scenario
    const fallbackSection = contentEl.createEl('details', { cls: 'auth-fallback-section' });
    const fallbackSummary = fallbackSection.createEl('summary', { 
      text: 'Browser didn\'t open? Click here for manual steps',
      cls: 'auth-fallback-toggle'
    });

    const fallbackContent = fallbackSection.createDiv({ cls: 'auth-fallback-content' });
    
    // Copy login link button (left-aligned, secondary)
    const linkContainer = fallbackContent.createDiv({ cls: 'auth-link-container' });
    const copyLinkButton = linkContainer.createEl('button', {
      text: 'Copy Login Link',
      cls: 'auth-copy-link-btn'
    });
    copyLinkButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.authUrl);
        new Notice('Authentication URL copied to clipboard!');
      } catch (error) {
        // Fallback: show URL for manual selection
        const urlDisplay = linkContainer.createEl('textarea', {
          cls: 'auth-url-display',
          attr: { readonly: 'true' }
        });
        urlDisplay.value = this.authUrl;
        urlDisplay.rows = 4;
        urlDisplay.select();
        new Notice('URL shown below - select and copy manually');
      }
    };

    const linkExplanation = linkContainer.createEl('p', {
      text: 'Copy this link and open it manually in your browser to complete authentication',
      cls: 'auth-link-explanation'
    });

    // Manual steps
    const manualSteps = fallbackContent.createEl('div', { cls: 'auth-manual-steps' });
    manualSteps.createEl('h4', { text: 'Manual Authentication Steps:' });
    const stepsList = manualSteps.createEl('ol');
    stepsList.createEl('li', { text: 'Click "Copy Login Link" above' });
    stepsList.createEl('li', { text: 'Open the link in your browser' });
    stepsList.createEl('li', { text: 'Sign in to Google and authorize access' });
    stepsList.createEl('li', { text: 'Copy the authorization code from the success page' });
    stepsList.createEl('li', { text: 'Paste it in the field above and click "Authenticate"' });

    // Focus on input by default
    setTimeout(() => codeInput.focus(), 100);
  }
}
