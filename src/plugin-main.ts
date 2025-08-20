import { Plugin, TFile, Notice, Menu, WorkspaceLeaf, MarkdownView, Modal } from 'obsidian';

import { getBuildVersion } from './version';
import { SyncService, createSyncService } from './sync/SyncService';
import { SyncUtils, FrontMatter } from './sync/SyncUtils';
import { GoogleDocsSyncSettings as ImportedSettings } from './types';
import { PluginAuthManager } from './auth/PluginAuthManager';
import { ObsidianTokenStorage } from './auth/ObsidianTokenStorage';
import { parseFrontMatter, buildFrontMatter, computeSHA256, FrontMatter as FSFrontMatter } from './fs/frontmatter';
import { ErrorUtils, BaseError, ErrorAggregator } from './utils/ErrorUtils';
import { BackgroundSyncManager } from './sync/BackgroundSyncManager';
import { SyncStatusManager } from './sync/SyncStatusManager';
import { SyncError, SyncErrorClassifier } from './sync/BackgroundSyncErrors';
import { GoogleDocsSyncSettingsTab } from './settings';
import { ConflictResolver } from './sync/ConflictResolver';

interface GoogleDocsSyncSettings extends ImportedSettings {
  // Plugin-specific extensions can be added here
}

interface SyncState {
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
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
      return { hasLocalChanges: false, hasRemoteChanges: false };
    }

    const lastSynced = new Date(metadata.lastSynced);
    const localMtime = new Date(file.stat.mtime);

    // Check for local changes (file modified after last sync)
    const hasLocalChanges = localMtime > lastSynced;

    // Check for remote changes by querying Google Drive
    const hasRemoteChanges = await this.plugin.hasRemoteChanges(metadata.id, metadata.lastSynced);

    return { hasLocalChanges, hasRemoteChanges };
  }
}

export default class GoogleDocsSyncPlugin extends Plugin {
  settings!: GoogleDocsSyncSettings;
  private changeDetector!: ChangeDetector;
  private syncService!: SyncService;
  private backgroundSyncManager!: BackgroundSyncManager;
  private syncStatusManager!: SyncStatusManager;
  private headerActions: Map<string, HTMLElement> = new Map();
  private statusBarItem!: HTMLElement;
  private updateTimeout: number | null = null;
  private currentOperations: Map<string, EnhancedNotice> = new Map();
  private authManager!: PluginAuthManager;
  async onload() {
    const buildVersion = getBuildVersion();
    console.log(`Loading Google Docs Sync plugin ${buildVersion}`);

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
        enabled: this.settings.backgroundSyncEnabled !== false,
        silentMode: this.settings.backgroundSyncSilentMode === true
      }
    );

    // Add status bar item for overall sync status
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('Google Docs Sync');
    this.statusBarItem.addClass('google-docs-status');
    this.statusBarItem.onClickEvent(async () => {
      await this.showSyncMenu();
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
          const syncError = SyncErrorClassifier.classifyError(
            error as Error,
            { operation: 'background_sync', filePath: file.path }
          );
          this.syncStatusManager.handleSyncError(syncError, file.name);
          throw syncError;
        }
      },
      hasGoogleDocsMetadata: (file: TFile) => {
        return !!this.getGoogleDocsMetadataSync(file);
      }
    });

    // Start background sync
    if (this.settings.backgroundSyncEnabled !== false) {
      this.backgroundSyncManager.start();
    }

    new Notice(`Google Docs Sync plugin loaded (${buildVersion})`);
  }

  async onunload() {
    console.log('Unloading Google Docs Sync plugin');

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
      conflictPolicy: 'prefer-doc',
      pollInterval: 60
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
        enabled: this.settings.backgroundSyncEnabled !== false,
        silentMode: this.settings.backgroundSyncSilentMode === true
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
    action.classList.remove('sync-none', 'sync-local', 'sync-remote', 'sync-both');

    if (syncState.hasLocalChanges && syncState.hasRemoteChanges) {
      action.classList.add('sync-both');
      action.setAttribute('aria-label', 'Conflict: Both local and remote changes');
    } else if (syncState.hasLocalChanges) {
      action.classList.add('sync-local');
      action.setAttribute('aria-label', 'Push local changes');
    } else if (syncState.hasRemoteChanges) {
      action.classList.add('sync-remote');
      action.setAttribute('aria-label', 'Pull remote changes');
    } else {
      action.classList.add('sync-none');
      action.setAttribute('aria-label', 'No changes to sync');
    }
  }

  async performSmartSync(file: TFile): Promise<void> {
    const notice = new Notice('Syncing...', 0);

    try {
      // Get current file content and metadata
      const content = await this.app.vault.read(file);
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);

      // Validate preconditions
      const validation = this.syncService.validateSyncPreconditions(content, frontmatter);
      if (!validation.valid) {
        notice.setMessage(`❌ ${validation.error}`);
        setTimeout(() => notice.hide(), 5000);
        return;
      }

      // Get remote content (placeholder - needs actual implementation)
      const remoteData = await this.getRemoteDocumentContent(frontmatter);
      if (!remoteData) {
        throw new Error('Could not fetch remote document');
      }

      // Perform intelligent sync with conflict resolution
      const syncResult = await this.syncService.syncDocument(
        markdown,
        frontmatter,
        remoteData.content,
        remoteData.revisionId,
        remoteData.modifiedTime
      );

      if (!syncResult.result.success) {
        throw new Error(syncResult.result.error || 'Sync failed');
      }

      // Update local file if content changed
      if (syncResult.updatedContent && syncResult.updatedFrontmatter) {
        const updatedDocument = SyncUtils.buildMarkdownWithFrontmatter(
          syncResult.updatedFrontmatter,
          syncResult.updatedContent
        );
        await this.app.vault.modify(file, updatedDocument);
      }

      // Show appropriate feedback
      const summary = this.syncService.generateSyncSummary(syncResult.result);
      notice.setMessage(summary);

      // Show conflict markers if manual resolution needed
      if (syncResult.result.conflictMarkers && syncResult.result.conflictMarkers.length > 0) {
        const conflictNotice = new Notice('', 10000);
        const markers = syncResult.result.conflictMarkers.join('\n• ');
        conflictNotice.setMessage(`Conflict Resolution:\n• ${markers}`);
      }

      setTimeout(() => notice.hide(), 3000);

      // Update header action
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }

    } catch (error) {
      const normalizedError = ErrorUtils.normalize(error as any, {
        operation: 'smart-sync',
        resourceName: file.name,
        filePath: file.path
      });
      notice.setMessage(`❌ Sync failed: ${normalizedError.message}`);
      setTimeout(() => notice.hide(), 5000);
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

  async showSyncMenu() {
    const files = this.app.vault.getMarkdownFiles();
    let pushCount = 0;
    let pullCount = 0;

    for (const file of files) {
      const syncState = await this.changeDetector.detectChanges(file);
      if (syncState.hasLocalChanges) pushCount++;
      if (syncState.hasRemoteChanges) pullCount++;
    }

    // Update status bar text
    this.statusBarItem.setText(`Google Docs: ${pushCount} to push, ${pullCount} to pull`);

    new Notice(`Sync status: ${pushCount} to push, ${pullCount} to pull`);
  }

  showStatusBarMenu(evt: MouseEvent): void {
    const menu = new Menu();

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
        filePath: file.path
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
        throw new DriveAPIError('No Google Docs metadata found', undefined, {
          resourceName: file.name,
          filePath: file.path,
          operation: 'validate-metadata'
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
        total: 1
      };

      const message = this.formatOperationSummary(
        `✅ Updated ${file.name} from Google Doc`,
        summary
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
        filePath: file.path
      });
      notice.setMessage(`Failed to create Google Doc: ${normalizedError.message}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('Create failed:', normalizedError);
    }
  }

  // Placeholder methods for Google Drive API integration
  async hasRemoteChanges(docId: string, lastSynced: string): Promise<boolean> {
    // TODO: Implement actual Google Drive API call
    console.log(`Checking remote changes for doc ${docId} since ${lastSynced}`);
    return false;
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
      modifiedTime: new Date().toISOString()
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
    console.log(`Creating Google Doc "${title}" in folder ${folderId} with ${content.length} characters`);
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
      }
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
        error: `Invalid conflict policy: ${this.settings.conflictPolicy}. Must be one of: prefer-doc, prefer-md, merge`
      };
    }

    // Validate Drive folder ID format if provided
    if (this.settings.driveFolderId) {
      const folderIdPattern = /^[a-zA-Z0-9_-]{25,}$/;
      const isValidId = folderIdPattern.test(this.settings.driveFolderId.trim());
      const isValidName = this.settings.driveFolderId.trim().length > 0 && !this.settings.driveFolderId.includes('/');
      
      if (!isValidId && !isValidName) {
        return {
          valid: false,
          error: 'Drive folder must be a valid folder name or folder ID (25+ alphanumeric characters)'
        };
      }
    }

    // Validate poll interval
    if (this.settings.pollInterval && (this.settings.pollInterval < 5 || this.settings.pollInterval > 3600)) {
      return {
        valid: false,
        error: 'Poll interval must be between 5 seconds and 1 hour (3600 seconds)'
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
      filePath: file.path
    });

    const actionableMessage = this.getActionableErrorMessage(normalizedError);
    notice.update(`❌ Sync failed: ${actionableMessage}`);
    
    // Keep error notice visible longer for user to read
    setTimeout(() => notice.hide(), 10000);
    
    // Log detailed error for debugging
    console.error('Smart sync failed:', {
      file: file.path,
      error: normalizedError,
      correlationId: normalizedError.correlationId
    });
  }

  /**
   * Handle bulk operation errors
   */
  private handleBulkOperationError(error: any, operation: 'push' | 'pull', notice: EnhancedNotice): void {
    const normalizedError = ErrorUtils.normalize(error, {
      operation: `bulk-${operation}`
    });

    const actionableMessage = this.getActionableErrorMessage(normalizedError);
    notice.update(`❌ ${operation.charAt(0).toUpperCase() + operation.slice(1)} failed: ${actionableMessage}`);
    
    setTimeout(() => notice.hide(), 10000);
    
    console.error(`Bulk ${operation} operation failed:`, {
      error: normalizedError,
      correlationId: normalizedError.correlationId
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
          const { exec } = (window as any).require?.('child_process');
          if (exec) {
            const command = process.platform === 'darwin' 
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
      }
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

      // Generate OAuth URL (placeholder - will need actual OAuth URL generation)
      const authUrl = this.generateAuthUrl();
      
      // Try to open browser with fallback strategies
      const browserOpened = await this.tryOpenBrowser(authUrl);
      
      if (browserOpened) {
        // Show success modal with next steps
        new AuthSuccessModal(this.app, authUrl, () => {
          // Callback for manual URL opening
          this.copyToClipboard(authUrl);
        }).open();
      } else {
        // Show manual auth modal with rich UX
        new ManualAuthModal(this.app, authUrl, (authCode: string) => {
          this.handleAuthCallback(authCode);
        }).open();
      }

    } catch (error) {
      console.error('Auth flow failed:', error);
      new Notice(`Authentication failed: ${(error as Error).message}`);
    }
  }

  /**
   * Generate OAuth authorization URL
   */
  private generateAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.settings.clientId || '',
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', // For manual code entry
      scope: 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent'
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Handle auth callback with authorization code
   */
  private async handleAuthCallback(authCode: string): Promise<void> {
    const notice = new Notice('Exchanging authorization code...', 0);
    
    try {
      // TODO: Implement actual token exchange
      // This would normally call Google's token endpoint
      console.log('Would exchange auth code:', authCode);
      
      // Placeholder for token exchange result
      const tokenResult = {
        access_token: 'placeholder_access_token',
        refresh_token: 'placeholder_refresh_token',
        expires_in: 3600,
        token_type: 'Bearer'
      };

      // Store tokens using enhanced auth manager
      await this.authManager.storeCredentials({
        access_token: tokenResult.access_token,
        refresh_token: tokenResult.refresh_token,
        token_type: tokenResult.token_type,
        expiry_date: Date.now() + (tokenResult.expires_in * 1000)
      });

      notice.setMessage('Authentication successful!');
      setTimeout(() => notice.hide(), 3000);

    } catch (error) {
      notice.setMessage(`Authentication failed: ${(error as Error).message}`);
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

  async getAuthStatus(): Promise<{isAuthenticated: boolean, error?: string, suggestions?: string[], nextSteps?: string[]}> {
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
    const currentlyEnabled = this.settings.backgroundSyncEnabled !== false;
    this.settings.backgroundSyncEnabled = !currentlyEnabled;
    await this.saveSettings();

    const statusText = currentlyEnabled ? 'disabled' : 'enabled';
    new Notice(`Background sync ${statusText}`, 3000);

    // Update status immediately
    this.syncStatusManager.updateFromBackgroundState(
      this.backgroundSyncManager.getSyncStatus() as any,
      this.settings.backgroundSyncEnabled !== false
    );
  }

  /**
   * Force background sync to run immediately
   */
  async forceBackgroundSync(): Promise<void> {
    if (this.settings.backgroundSyncEnabled === false) {
      new Notice('Background sync is disabled. Enable it in settings first.', 5000);
      return;
    }

    new Notice('Starting background sync...', 2000);
    
    try {
      await this.backgroundSyncManager.forceSyncNow();
    } catch (error) {
      const syncError = SyncErrorClassifier.classifyError(
        error as Error,
        { operation: 'force_background_sync' }
      );
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
    
    new Notice(message, 15000);
  }
}

/**
 * Modal for successful browser opening with next steps
 */
class AuthSuccessModal extends Modal {
  private authUrl: string;
  private onCopyUrl: () => void;

  constructor(app: any, authUrl: string, onCopyUrl: () => void) {
    super(app);
    this.authUrl = authUrl;
    this.onCopyUrl = onCopyUrl;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl('h2', { text: 'Browser Opened Successfully' });
    
    const instructions = contentEl.createDiv({ cls: 'auth-instructions' });
    instructions.createEl('p', { text: '1. Complete the Google authentication in your browser' });
    instructions.createEl('p', { text: '2. Copy the authorization code from the success page' });
    instructions.createEl('p', { text: '3. Return here and paste it when prompted' });
    
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    
    const copyButton = buttonContainer.createEl('button', { 
      text: 'Copy Auth URL',
      cls: 'mod-cta'
    });
    copyButton.onclick = () => {
      this.onCopyUrl();
    };
    
    const continueButton = buttonContainer.createEl('button', { 
      text: 'I have the code',
      cls: 'mod-cta'
    });
    continueButton.onclick = () => {
      this.close();
      new AuthCodeModal(this.app, (code: string) => {
        // Handle code submission
        console.log('Auth code received:', code);
      }).open();
    };
    
    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.onclick = () => this.close();
  }
}

/**
 * Modal for manual auth with rich UX and URL copying
 */
class ManualAuthModal extends Modal {
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
    
    contentEl.createEl('h2', { text: 'Manual Authentication Required' });
    
    const explanation = contentEl.createDiv({ cls: 'auth-explanation' });
    explanation.createEl('p', { 
      text: 'Unable to open browser automatically. Please follow these steps:' 
    });
    
    const steps = explanation.createEl('ol');
    steps.createEl('li', { text: 'Copy the authorization URL below' });
    steps.createEl('li', { text: 'Open it in your browser manually' });
    steps.createEl('li', { text: 'Complete the Google authentication' });
    steps.createEl('li', { text: 'Copy the authorization code from the success page' });
    steps.createEl('li', { text: 'Paste it in the field below' });
    
    // URL display with copy button
    const urlContainer = contentEl.createDiv({ cls: 'auth-url-container' });
    urlContainer.createEl('label', { text: 'Authorization URL:' });
    
    const urlDisplay = urlContainer.createEl('textarea', { 
      cls: 'auth-url-display',
      attr: { readonly: 'true' }
    });
    urlDisplay.value = this.authUrl;
    urlDisplay.rows = 4;
    
    const copyUrlButton = urlContainer.createEl('button', {
      text: 'Copy URL',
      cls: 'mod-cta'
    });
    copyUrlButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.authUrl);
        new Notice('URL copied to clipboard!');
      } catch (error) {
        urlDisplay.select();
        new Notice('URL selected - press Ctrl+C to copy');
      }
    };
    
    // Auth code input
    const codeContainer = contentEl.createDiv({ cls: 'auth-code-container' });
    codeContainer.createEl('label', { text: 'Authorization Code:' });
    
    const codeInput = codeContainer.createEl('input', {
      type: 'text',
      placeholder: 'Paste your authorization code here...',
      cls: 'auth-code-input'
    });
    
    // Progress indicator
    const statusDiv = contentEl.createDiv({ cls: 'auth-status' });
    
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    
    const submitButton = buttonContainer.createEl('button', {
      text: 'Authenticate',
      cls: 'mod-cta'
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
    
    // Focus on input
    setTimeout(() => codeInput.focus(), 100);
  }
}

/**
 * Simple modal for auth code entry
 */
class AuthCodeModal extends Modal {
  private onCode: (code: string) => void;

  constructor(app: any, onCode: (code: string) => void) {
    super(app);
    this.onCode = onCode;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl('h2', { text: 'Enter Authorization Code' });
    
    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: 'Paste your authorization code here...',
      cls: 'auth-code-input'
    });
    
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    
    const submitButton = buttonContainer.createEl('button', {
      text: 'Submit',
      cls: 'mod-cta'
    });
    submitButton.onclick = () => {
      const code = input.value.trim();
      if (code) {
        this.onCode(code);
        this.close();
      }
    };
    
    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.onclick = () => this.close();
    
    input.focus();
  }
}
