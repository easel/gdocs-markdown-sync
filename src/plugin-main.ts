import { Plugin, TFile, Notice, Menu, WorkspaceLeaf, MarkdownView, Modal } from 'obsidian';

import { PluginAuthManager } from './auth/PluginAuthManager';
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
    
    try {
      if (this.plugin.settings.syncMoves && metadata.id && !hasRemoteDelete) {
        const driveAPI = await this.plugin.getAuthenticatedDriveAPI();
        const currentRemotePath = await driveAPI.getFilePath(metadata.id);
        const expectedRemotePath = this.plugin.calculateExpectedRemotePath(file.path);
        
        if (currentRemotePath !== expectedRemotePath) {
          hasRemoteMove = true;
          remoteMoveFrom = currentRemotePath;
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
  async onload() {
    console.log(`🚀 Loading Google Docs Sync plugin ${PLUGIN_VERSION}`);
    console.log(`📊 Plugin Details: version=${PLUGIN_VERSION_DETAILS.version}, commit=${PLUGIN_VERSION_DETAILS.commit}, dirty=${PLUGIN_VERSION_DETAILS.isDirty}, buildTime=${PLUGIN_VERSION_DETAILS.buildTime}`);

    await this.loadSettings();

    // Initialize auth manager with plugin instance for token storage
    this.authManager = new PluginAuthManager(this.settings.profile, this);

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
    const files = this.app.vault.getMarkdownFiles();
    const notice = new Notice('Pulling all documents...', 0);

    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const metadata = await this.getGoogleDocsMetadata(file);
        if (metadata) {
          await this.pullSingleFile(file);
          successCount++;
        }
      } catch (error) {
        errorCount++;
        console.error(`Failed to pull ${file.path}:`, error);
      }
    }

    notice.setMessage(`Pull completed: ${successCount} success, ${errorCount} errors`);
    setTimeout(() => notice.hide(), 3000);
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
    console.log('🔐 Getting authenticated Drive API client...');
    try {
      const authClient = await this.authManager.getAuthClient();
      console.log('✅ Auth client obtained, creating Drive API...');
      return new DriveAPI(authClient.credentials.access_token);
    } catch (error) {
      console.error('❌ Failed to get authenticated Drive API:', error);
      throw error;
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
      
      // Check if remote file was modified after last sync
      const remoteModified = new Date(fileInfo.modifiedTime);
      const lastSyncTime = new Date(lastSynced);
      
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
   * Start authentication flow with enhanced UX
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

      // Generate OAuth URL with PKCE parameters
      const authUrl = await this.generateAuthUrl();

      // Try to open browser with fallback strategies
      const browserOpened = await this.tryOpenBrowser(authUrl);

      // Always show the unified auth modal that assumes browser opened
      // but provides fallback for manual opening
      new UnifiedAuthModal(this.app, authUrl, (authCode: string) => {
        this.handleAuthCallback(authCode);
      }).open();
    } catch (error) {
      console.error('Auth flow failed:', error);
      new Notice(`Authentication failed: ${(error as Error).message}`);
    }
  }

  // Store PKCE verifier for this auth session
  private pkceVerifier: string | null = null;

  /**
   * Generate OAuth authorization URL with PKCE
   */
  private async generateAuthUrl(): Promise<string> {
    // Generate PKCE challenge/verifier pair
    const { codeVerifier, codeChallenge } = await this.generatePKCE();
    this.pkceVerifier = codeVerifier;

    const params = new URLSearchParams({
      client_id: this.settings.clientId || '',
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', // For manual code entry
      scope: 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Generate PKCE challenge and verifier for browser environment
   */
  private async generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    // Generate cryptographically secure random verifier
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const codeVerifier = btoa(String.fromCharCode.apply(null, Array.from(array)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // Create SHA256 challenge from verifier
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const codeChallenge = btoa(String.fromCharCode.apply(null, Array.from(hashArray)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    return { codeVerifier, codeChallenge };
  }

  /**
   * Handle auth callback with authorization code
   */
  private async handleAuthCallback(authCode: string): Promise<void> {
    const notice = new Notice('Exchanging authorization code...', 0);

    try {
      if (!this.pkceVerifier) {
        throw new Error('PKCE verifier not found. Please restart the authentication flow.');
      }

      // Exchange authorization code for tokens using Google OAuth endpoint
      const tokens = await this.exchangeCodeForTokens(authCode, this.pkceVerifier);

      // Store tokens using Obsidian plugin storage
      const credentials = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        scope: 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
        expiry_date: tokens.expiry_date || (Date.now() + (tokens.expires_in || 3600) * 1000),
      };

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
   * Exchange authorization code for access tokens using Google OAuth2 endpoint
   * Reuses the same logic as CLI but for plugin environment
   */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<any> {
    // PUBLIC OAuth Client - Intentionally committed for desktop/plugin use
    // Google requires client_secret even with PKCE (non-standard requirement)  
    // Security scanner exception: not a leaked secret, this is a public client
    // gitleaks:allow
    const PUBLIC_CLIENT_ID = 
      '181003307316-5devin5s9sh5tmvunurn4jh4m6m8p89v.apps.googleusercontent.com';
    // gitleaks:allow
    const CLIENT_SECRET = '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';

    const tokenRequestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.settings.clientId || PUBLIC_CLIENT_ID,
      client_secret: this.settings.clientSecret || CLIENT_SECRET,
      code: code,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      code_verifier: codeVerifier,
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenRequestBody,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `Token exchange failed: ${errorData.error_description || errorData.error || response.statusText}`,
      );
    }

    const tokens = await response.json();

    // Validate response has required tokens
    if (!tokens.access_token) {
      throw new Error('Token exchange successful but no access token received');
    }

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
    };
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
      const targetFolderId = await driveAPI.ensureNestedFolders(
        targetPath.folderPath, 
        this.settings.driveFolderId
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
    
    // Remove baseVaultFolder from the path if it exists
    if (this.settings.baseVaultFolder) {
      const baseFolder = this.settings.baseVaultFolder.replace(/\/$/, ''); // Remove trailing slash
      if (filePath.startsWith(baseFolder + '/')) {
        filePath = filePath.substring(baseFolder.length + 1);
      }
    }

    // Split into folder path and filename
    const pathParts = filePath.split('/');
    const fileName = pathParts.pop() || file.name;
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
      
      const currentRemotePath = await driveAPI.getFilePath(docId);
      
      // Calculate what the new local path should be
      const newLocalPath = this.calculateLocalPathFromRemote(currentRemotePath);
      
      if (newLocalPath !== file.path) {
        // Need to move/rename the local file
        const newTFile = await this.app.vault.rename(file, newLocalPath);
        console.log(`✅ Moved local file ${file.path} → ${newLocalPath} to match remote location`);
      }
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
      const trashFolderId = await driveAPI.ensureNestedFolders(trashPath, this.settings.driveFolderId);
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
      const targetFolderId = await driveAPI.ensureNestedFolders(folderPath, this.settings.driveFolderId);

      // Create new Google Doc
      const newDocId = await driveAPI.createDocument(documentName, markdown, targetFolderId);

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
