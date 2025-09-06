import { Plugin, TFile, Notice, Menu, WorkspaceLeaf, MarkdownView } from 'obsidian';

import { PluginAuthManager } from './auth/PluginAuthManager';
import { UnifiedOAuthManager } from './auth/UnifiedOAuthManager';
import { DriveAPI, GoogleDocInfo } from './drive/DriveAPI';
import { parseFrontMatter, buildFrontMatter } from './fs/frontmatter';
import { GoogleDocsSyncSettingsTab } from './settings';
import { ObsidianStorage } from './storage/ObsidianStorage';
import { SyncErrorClassifier } from './sync/BackgroundSyncErrors';
import { BackgroundSyncManager } from './sync/BackgroundSyncManager';
import { ChangeDetector } from './sync/ChangeDetector';
import { ConflictResolver } from './sync/ConflictResolver';
import { SyncOperations } from './sync/SyncOperations';
import { SyncService, createSyncService } from './sync/SyncService';
import { SyncStatusManager } from './sync/SyncStatusManager';
import { SyncUtils } from './sync/SyncUtils';
import {
  GoogleDocsSyncSettings,
  SyncState,
  OperationSummary,
  EnhancedNotice,
} from './types/plugin-types';
import { UnifiedAuthModal } from './ui/UnifiedAuthModal';
import { ErrorUtils, BaseError } from './utils/ErrorUtils';
import { getBuildVersion, VERSION_INFO } from './version';

// Ensure version info is available at runtime
const PLUGIN_VERSION = getBuildVersion();
const PLUGIN_VERSION_DETAILS = VERSION_INFO;

export default class GoogleDocsSyncPlugin extends Plugin {
  settings!: GoogleDocsSyncSettings;
  public changeDetector!: ChangeDetector;
  public syncService!: SyncService;
  private syncOperations!: SyncOperations;
  public backgroundSyncManager!: BackgroundSyncManager;
  public syncStatusManager!: SyncStatusManager;
  public storage!: ObsidianStorage;
  private headerActions: Map<string, HTMLElement> = new Map();
  public statusBarItem!: HTMLElement;
  private updateTimeout: number | null = null;
  private currentOperations: Map<string, EnhancedNotice> = new Map();
  public authManager!: PluginAuthManager;
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
    console.log(
      `📊 Plugin Details: version=${PLUGIN_VERSION_DETAILS.version}, commit=${PLUGIN_VERSION_DETAILS.commit}, dirty=${PLUGIN_VERSION_DETAILS.isDirty}, buildTime=${PLUGIN_VERSION_DETAILS.buildTime}`,
    );

    await this.loadSettings();

    // Initialize ObsidianStorage with vault and base folder from settings
    this.storage = new ObsidianStorage(this.app.vault, this.settings.baseVaultFolder);

    // Initialize auth manager with plugin instance for token storage
    this.authManager = new PluginAuthManager(this.settings.profile, this);

    // Register OAuth callback handler for iOS client redirect using centralized config
    const tokenStorage = this.authManager.getTokenStorage();
    if (tokenStorage) {
      const tempOAuthManager = new UnifiedOAuthManager(tokenStorage, { isPlugin: true });
      const protocolPath = tempOAuthManager.getProtocolHandlerPath();

      if (protocolPath) {
        this.registerObsidianProtocolHandler(protocolPath, async (params) => {
          await this.handleOAuthCallback(params);
        });
      }
    }

    // Verify workspace and token validity on startup
    await this.verifyWorkspaceAndToken();

    this.changeDetector = new ChangeDetector(this);
    this.syncService = createSyncService(this.settings);
    this.syncOperations = new SyncOperations(this);

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
        new Notice(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
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
      const testResponse = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota',
        {
          headers: {
            Authorization: `Bearer ${driveAPI.getAccessToken()}`,
          },
        },
      );

      if (testResponse.ok) {
        const userInfo = await testResponse.json();
        console.log('✅ Authentication successful!');
        console.log(
          `👤 Authenticated as: ${userInfo.user?.displayName || 'Unknown'} (${userInfo.user?.emailAddress || 'Unknown email'})`,
        );

        // Store workspace information
        const email = userInfo.user?.emailAddress || 'Unknown email';
        const displayName = userInfo.user?.displayName || 'Unknown';
        const domain = email.includes('@') ? email.split('@')[1] : 'Unknown domain';

        this.workspaceInfo = {
          email,
          displayName,
          domain,
          lastVerified: new Date(),
        };

        console.log(`🏢 Workspace Domain: ${domain}`);
        console.log(`🆔 Workspace Email: ${email}`);

        // Test access to configured folder if available
        if (this.settings.driveFolderId && this.settings.driveFolderId.trim() !== '') {
          try {
            console.log(`📁 Testing access to configured folder: ${this.settings.driveFolderId}`);
            const folderInfo = await driveAPI.getFile(this.settings.driveFolderId);
            console.log(
              `✅ Folder accessible: "${folderInfo.name || 'Unnamed folder'}" (${this.settings.driveFolderId})`,
            );
            console.log(`📊 Folder metadata:`, {
              id: folderInfo.id,
              name: folderInfo.name,
              parents: folderInfo.parents || [],
              mimeType: folderInfo.mimeType,
              modifiedTime: folderInfo.modifiedTime,
              driveId: folderInfo.driveId,
            });

            // Store folder access information
            if (this.workspaceInfo) {
              this.workspaceInfo.folderAccess = {
                folderId: this.settings.driveFolderId,
                folderName: folderInfo.name || 'Unnamed folder',
                documentCount: 0, // Will be updated below
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
              const searchResults = await fetch(
                `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent('name contains "Synaptitudes"')}&fields=files(id,name,parents,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
                {
                  headers: { Authorization: `Bearer ${driveAPI.getAccessToken()}` },
                },
              );
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
            console.warn(
              `⚠️  Cannot access configured folder ${this.settings.driveFolderId}:`,
              error,
            );
            console.log(
              '💡 This may indicate the folder is in a different workspace or the folder ID is incorrect',
            );

            // Additional diagnostic - try to understand the error better
            if (error instanceof Error) {
              console.log(`🔍 Error details:`, {
                message: error.message,
                name: error.name,
                stack: error.stack?.split('\n').slice(0, 3),
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
      console.log(
        '💡 This may indicate authentication issues. Check plugin settings and reauth if needed.',
      );
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

    // Update storage base folder if changed
    if (this.storage) {
      this.storage.setBaseFolder(this.settings.baseVaultFolder || '');
    }

    // Update sync service with new settings
    this.syncService = createSyncService(this.settings);
    this.syncOperations = new SyncOperations(this);

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
    return this.syncOperations.performSmartSync(file);
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

  public syncCancelled = false;
  public syncInProgress = false;
  public currentSyncStatus = {
    isRunning: false,
    progress: { current: 0, total: 0 },
    operation: '',
    startTime: 0,
  };

  async syncAllDocuments() {
    return this.syncOperations.syncAllDocuments();
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
    const percentComplete =
      progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

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
        // Update Google Doc using DriveAPI
        const driveAPI = await this.getAuthenticatedDriveAPI();
        const content = await this.storage.readFile(file.path);
        const { markdown } = this.parseFrontmatter(content);
        const sanitizedMarkdown = SyncUtils.sanitizeMarkdownForGoogleDrive(markdown);
        await driveAPI.updateDocument(metadata.id, sanitizedMarkdown);
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
      // Update local file using DriveAPI
      const driveAPI = await this.getAuthenticatedDriveAPI();
      const remoteContent = await driveAPI.exportDocument(metadata.id);

      // Update frontmatter with sync info
      const currentContent = await this.storage.readFile(file.path);
      const { frontmatter } = this.parseFrontmatter(currentContent);
      const updatedFrontmatter = {
        ...frontmatter,
        'last-synced': new Date().toISOString(),
        'sync-revision': (frontmatter['sync-revision'] || 0) + 1,
      };

      // Build new content with updated frontmatter and remote markdown
      const frontmatterYaml = this.serializeFrontmatter(updatedFrontmatter);
      const newContent = `---\n${frontmatterYaml}---\n${remoteContent}`;

      await this.storage.writeFile(file.path, newContent);

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
      new Notice(
        'Google Drive folder not configured. Please set the Drive folder ID in plugin settings.',
        8000,
      );
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
    return this.syncOperations.pullAllDocs();
  }

  /**
   * Create a new local file from a Google Doc
   */
  async createLocalFileFromGoogleDoc(doc: any, driveAPI: any): Promise<void> {
    return this.syncOperations.createLocalFileFromGoogleDoc(doc, driveAPI);
  }

  /**
   * Ensure directory exists in Obsidian vault, creating nested folders as needed
   */
  async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await this.storage.createDirectory(dirPath);
      console.log(`Directory ensured: ${dirPath}`);
    } catch (error) {
      console.error(`Failed to create directory ${dirPath}:`, error);
      throw error;
    }
  }

  async getGoogleDocsMetadata(file: TFile): Promise<any> {
    const content = await this.storage.readFile(file.path);
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
      console.error('Frontmatter parsing failed:', error);
      return { frontmatter: {}, markdown: content };
    }
  }

  serializeFrontmatter(frontmatter: Record<string, any>): string {
    try {
      // Use shared frontmatter building from src/fs/frontmatter.ts
      // Extract the YAML part from the full document
      const fullDocument = buildFrontMatter(frontmatter, '');
      const yamlMatch = fullDocument.match(/^---\n([\s\S]*?)\n---\n/);
      return yamlMatch ? yamlMatch[1] : '';
    } catch (error) {
      console.warn('YAML serialization failed:', error);
      // Fallback to simple key-value serialization
      let result = '';
      for (const [key, value] of Object.entries(frontmatter)) {
        result += `${key}: ${value}\n`;
      }
      return result;
    }
  }

  async updateFileWithNewDocId(file: TFile, docId: string): Promise<void> {
    const content = await this.storage.readFile(file.path);
    const { frontmatter, markdown } = this.parseFrontmatter(content);

    // Update frontmatter with Google Docs information
    frontmatter['google-doc-id'] = docId;
    frontmatter['last-synced'] = new Date().toISOString();

    // Serialize frontmatter properly
    const frontmatterYaml = this.serializeFrontmatter(frontmatter);
    const newContent = `---\n${frontmatterYaml}---\n${markdown}`;

    await this.storage.writeFile(file.path, newContent);
  }

  async createGoogleDocFromFile(file: TFile): Promise<void> {
    const notice = new Notice('Creating Google Doc...', 0);

    try {
      // Check for existing document with same name first
      const sanitizedName = SyncUtils.sanitizeFileName(file.basename);
      const driveAPI = await this.getAuthenticatedDriveAPI();
      const driveFolderId = await this.resolveDriveFolderId();

      // Search for existing document by name in the configured folder
      const docs = await driveAPI.listDocsInFolder(driveFolderId);
      const existingDoc = docs.find(
        (doc) =>
          doc.name === sanitizedName ||
          doc.name === `${sanitizedName}.md` ||
          doc.name.replace(/\.md$/, '') === sanitizedName,
      );

      if (existingDoc) {
        // Document already exists, just link it
        await this.updateFileWithNewDocId(file, existingDoc.id);
        notice.setMessage('Linked to existing Google Doc');
        setTimeout(() => notice.hide(), 2000);
        return;
      }

      const content = await this.storage.readFile(file.path);
      const { markdown } = this.parseFrontmatter(content);

      // Sanitize markdown for Google Drive compatibility
      const sanitizedMarkdown = SyncUtils.sanitizeMarkdownForGoogleDrive(markdown);

      // Create new document using DriveAPI
      const docId = await driveAPI.createGoogleDoc(sanitizedName, sanitizedMarkdown, driveFolderId);
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
    if (this.driveAPICache && now - this.driveAPICache.timestamp < this.DRIVE_API_CACHE_TTL) {
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
    return this.syncOperations.discoverLocalFiles();
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
    return this.syncOperations.discoverRemoteFiles();
  }

  /**
   * Build a comprehensive sync plan by matching local and remote files
   */
  async buildSyncPlan(): Promise<{
    localState: {
      linked: Array<{ file: TFile; docId: string; path: string }>;
      unlinked: Array<{ file: TFile; path: string }>;
      suspicious: Array<{ file: TFile; path: string; issue: string }>;
      total: number;
    };
    remoteState: {
      docs: Array<{ id: string; name: string; path: string; relativePath: string }>;
      duplicateFolders: Array<{ name: string; count: number; paths: string[] }>;
      duplicateDocs: Array<{ name: string; count: number; ids: string[] }>;
      suspiciousFolders: Array<{ name: string; path: string; id: string }>;
      folderStats: Record<string, number>;
      total: number;
    };
    operations: {
      pushToRemote: Array<{ localFile: TFile; action: 'create' | 'update'; reason: string }>;
      pullFromRemote: Array<{
        remoteDoc: { id: string; name: string; path: string };
        action: 'create' | 'update';
        reason: string;
        targetPath?: string;
      }>;
      conflicts: Array<{
        localFile: TFile;
        remoteDoc: { id: string; name: string };
        reason: string;
      }>;
      warnings: Array<{
        type: 'duplicate-folder' | 'duplicate-document' | 'suspicious-pattern' | 'existing-file';
        message: string;
        details: any;
      }>;
      safe: boolean;
    };
  }> {
    return this.syncOperations.buildSyncPlan();
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
      syncPlan.localState.linked.forEach((file) => {
        console.log(`     • ${file.path} → ${file.docId}`);
      });
    }

    if (syncPlan.localState.unlinked.length > 0 && syncPlan.localState.unlinked.length <= 10) {
      console.log('\n   🔗 Unlinked Files:');
      syncPlan.localState.unlinked.forEach((file: { file: TFile; path: string }) => {
        console.log(`     • ${file.path}`);
      });
    } else if (syncPlan.localState.unlinked.length > 10) {
      console.log(
        `\n   🔗 Unlinked Files: ${syncPlan.localState.unlinked.length} files (showing first 5):`,
      );
      syncPlan.localState.unlinked.slice(0, 5).forEach((file: { file: TFile; path: string }) => {
        console.log(`     • ${file.path}`);
      });
      console.log(`     ... and ${syncPlan.localState.unlinked.length - 5} more`);
    }

    if (syncPlan.localState.suspicious.length > 0) {
      console.log('\n   ⚠️  Suspicious Local Files:');
      syncPlan.localState.suspicious.forEach(
        (file: { file: TFile; path: string; issue: string }) => {
          console.log(`     • ${file.path}: ${file.issue}`);
        },
      );
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
      syncPlan.remoteState.duplicateDocs.forEach(
        (duplicate: { name: string; count: number; ids: string[] }) => {
          console.log(`     • "${duplicate.name}" has ${duplicate.count} conflicts with IDs:`);
          duplicate.ids.forEach((id: string) => {
            console.log(`       - ${id}`);
          });
        },
      );
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
      syncPlan.operations.pushToRemote.forEach((op) => {
        console.log(`     • ${op.action.toUpperCase()}: ${op.localFile.path}`);
        console.log(`       Reason: ${op.reason}`);
      });
    }

    if (syncPlan.operations.pullFromRemote.length > 0) {
      console.log('\n   ⬇️  PULL FROM REMOTE:');
      syncPlan.operations.pullFromRemote.forEach((op) => {
        console.log(`     • ${op.action.toUpperCase()}: ${op.remoteDoc.name} (${op.remoteDoc.id})`);
        console.log(`       Target: ${op.targetPath || 'TBD'}`);
        console.log(`       Reason: ${op.reason}`);
      });
    }

    if (syncPlan.operations.conflicts.length > 0) {
      console.log('\n   ⚔️  CONFLICTS:');
      syncPlan.operations.conflicts.forEach((conflict) => {
        console.log(`     • Local: ${conflict.localFile.path}`);
        console.log(`       Remote: ${conflict.remoteDoc.name} (${conflict.remoteDoc.id})`);
        console.log(`       Issue: ${conflict.reason}`);
      });
    }

    if (syncPlan.operations.warnings.length > 0) {
      console.log('\n   ⚠️  WARNINGS:');
      syncPlan.operations.warnings.forEach((warning) => {
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

      const duplicateDocWarnings = syncPlan.operations.warnings.filter(
        (w) => w.type === 'duplicate-document',
      );

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
      throw new Error(
        'Google Drive folder not configured. Please set the Drive folder ID in plugin settings.',
      );
    }

    const driveAPI = await this.getAuthenticatedDriveAPI();
    try {
      const resolvedId = await driveAPI.resolveFolderId(this.settings.driveFolderId.trim());
      console.log(`✅ Resolved folder "${this.settings.driveFolderId}" to ID: ${resolvedId}`);
      return resolvedId;
    } catch (error) {
      console.error(`❌ Failed to resolve folder "${this.settings.driveFolderId}":`, error);
      throw new Error(
        `Cannot access Google Drive folder "${this.settings.driveFolderId}". Please check the folder ID/name and your permissions.`,
      );
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
      console.log(
        `Remote changes for ${docId}: ${hasChanges} (remote: ${remoteModified.toISOString()}, lastSync: ${lastSyncTime.toISOString()})`,
      );

      return hasChanges;
    } catch (error) {
      console.error(`Failed to check remote changes for ${docId}:`, error);
      // If we can't check, assume no changes to avoid unnecessary sync attempts
      return false;
    }
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
        new Notice(
          'Browser opened for authentication. Complete the process in your browser to continue.',
          10000,
        );
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
      new Notice(
        'Authentication failed: No PKCE verifier found. Please restart the authentication flow.',
      );
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
   * Find or create Google Doc using folder-based strategy
   * Strategy:
   * 1. If frontmatter has google-doc-id, verify it exists and return it
   * 2. Otherwise, map local file path to Google Drive folder structure
   * 3. Search for existing document by name in the target folder
   * 4. If not found, create new document in the target folder
   * 5. Link the document by updating frontmatter
   */
  public async findOrCreateGoogleDoc(
    file: TFile,
    driveAPI: DriveAPI,
    frontmatter: any,
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
          console.warn(
            `Linked Google Doc ${frontmatter['google-doc-id']} not found, will create new one`,
          );
        }
      }

      // Step 2: Calculate target folder path in Google Drive
      const targetPath = this.calculateGoogleDrivePath(file);
      console.log(`Target Google Drive path for ${file.path}: ${targetPath}`);

      // Step 3: Ensure the folder structure exists in Google Drive
      const baseFolderId = await this.resolveDriveFolderId();
      const targetFolderId = await driveAPI.ensureNestedFolders(
        targetPath.folderPath,
        baseFolderId,
      );

      // Step 4: Search for existing document by name in the target folder
      const searchName = targetPath.documentName;
      console.log(`Searching for document "${searchName}" in folder ${targetFolderId}`);

      const existingDocs = await driveAPI.listDocsInFolder(targetFolderId);
      const existingDoc = existingDocs.find(
        (doc) =>
          doc.name === searchName ||
          doc.name === `${searchName}.md` ||
          doc.name.replace(/\.md$/, '') === searchName,
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
      const fileContent = await this.storage.readFile(file.path);
      const { markdown } = SyncUtils.parseFrontMatter(fileContent);

      const newDoc = await driveAPI.uploadMarkdownAsDoc(searchName, markdown, targetFolderId);
      console.log(`Created new Google Doc: ${newDoc.id} (${searchName})`);

      return {
        id: newDoc.id,
        name: searchName,
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
  private calculateGoogleDrivePathFromPath(localPath: string): {
    folderPath: string;
    documentName: string;
  } {
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
  public calculateGoogleDrivePath(file: TFile): { folderPath: string; documentName: string } {
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

    console.log(`  - Path parts: [${pathParts.map((p) => `"${p}"`).join(', ')}]`);
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
  public async getDocumentRevision(docId: string, driveAPI: DriveAPI): Promise<string> {
    try {
      const fileInfo = await driveAPI.getFile(docId);
      return fileInfo.modifiedTime || '';
    } catch (error) {
      console.warn(`Failed to get revision for doc ${docId}:`, error);
      return '';
    }
  }
}
