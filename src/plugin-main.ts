import { Plugin, TFile, Notice, Menu, WorkspaceLeaf, MarkdownView } from 'obsidian';

import { getBuildVersion } from './version';

interface GoogleDocsSyncSettings {
  // Settings can be added here later
}

interface SyncState {
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
}

// Basic YAML parser that doesn't require external dependencies
function parseBasicYaml(frontmatterText: string): Record<string, any> {
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

function serializeBasicYaml(obj: Record<string, any>, indent = ''): string {
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
  private headerActions: Map<string, HTMLElement> = new Map();
  private statusBarItem!: HTMLElement;
  private updateTimeout: number | null = null;
  async onload() {
    const buildVersion = getBuildVersion();
    console.log(`Loading Google Docs Sync plugin ${buildVersion}`);

    this.changeDetector = new ChangeDetector(this);

    await this.loadSettings();

    // Add status bar item for overall sync status
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('Google Docs Sync');
    this.statusBarItem.addClass('google-docs-status');
    this.statusBarItem.onClickEvent(async () => {
      await this.showSyncMenu();
    });

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

    // Initial header action setup
    setTimeout(() => {
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    }, 100);

    new Notice(`Google Docs Sync plugin loaded (${buildVersion})`);
  }

  async onunload() {
    console.log('Unloading Google Docs Sync plugin');

    // Clean up header actions
    this.headerActions.forEach((action, _fileId: string) => {
      if (action && action.parentNode) {
        action.parentNode.removeChild(action);
      }
    });
    this.headerActions.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
    const syncState = await this.changeDetector.detectChanges(file);

    if (syncState.hasLocalChanges && syncState.hasRemoteChanges) {
      // Show menu for conflicts
      await this.showFileSyncMenu(file, null);
    } else if (syncState.hasLocalChanges) {
      // Direct push
      await this.pushSingleFile(file);
    } else if (syncState.hasRemoteChanges) {
      // Direct pull
      await this.pullSingleFile(file);
    } else {
      new Notice('No changes to sync');
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
      notice.setMessage(`Push failed: ${(error as Error).message}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('Push failed:', error);
    }
  }

  async pullSingleFile(file: TFile): Promise<void> {
    const notice = new Notice('Pulling from Google Docs...', 0);

    try {
      const metadata = await this.getGoogleDocsMetadata(file);
      if (!metadata) {
        throw new Error('No Google Docs metadata found');
      }

      await this.updateLocalFile(file, metadata);

      notice.setMessage('Pull completed successfully');
      setTimeout(() => notice.hide(), 2000);

      // Update header action after successful pull
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      notice.setMessage(`Pull failed: ${(error as Error).message}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('Pull failed:', error);
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
        title: frontmatter['google-doc-title'] || file.basename,
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
        title: cache.frontmatter['google-doc-title'] || file.basename,
        lastSynced: cache.frontmatter['last-synced'] || new Date().toISOString(),
      };
    }
    return null;
  }

  parseFrontmatter(content: string): { frontmatter: Record<string, any>; markdown: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return { frontmatter: {}, markdown: content };
    }

    const frontmatterText = match[1];
    const markdown = match[2];

    try {
      // Use robust basic YAML parsing
      const frontmatter = parseBasicYaml(frontmatterText);
      return { frontmatter, markdown };
    } catch (error) {
      console.error('Frontmatter parsing failed:', error);
      return { frontmatter: {}, markdown: content };
    }
  }

  serializeFrontmatter(frontmatter: Record<string, any>): string {
    try {
      return serializeBasicYaml(frontmatter);
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
      const existingDoc = await this.findDocumentByName(file.basename, folderId);

      if (existingDoc) {
        // Document already exists, just link it
        await this.updateFileWithNewDocId(file, existingDoc.id);
        notice.setMessage('Linked to existing Google Doc');
        setTimeout(() => notice.hide(), 2000);
        return;
      }

      const content = await this.app.vault.read(file);
      const { markdown } = this.parseFrontmatter(content);

      // Create new document
      const docId = await this.createGoogleDoc(file.basename, markdown, folderId);
      await this.updateFileWithNewDocId(file, docId);

      notice.setMessage('Google Doc created successfully');
      setTimeout(() => notice.hide(), 2000);

      // Update header action
      const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      notice.setMessage(`Failed to create Google Doc: ${(error as Error).message}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('Create failed:', error);
    }
  }

  // Placeholder methods for Google Drive API integration
  async hasRemoteChanges(docId: string, lastSynced: string): Promise<boolean> {
    // TODO: Implement actual Google Drive API call
    console.log(`Checking remote changes for doc ${docId} since ${lastSynced}`);
    return false;
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

  async createGoogleDoc(title: string, _content: string, folderId: string): Promise<string> {
    // TODO: Implement actual Google Docs creation
    console.log(`Creating Google Doc "${title}" in folder ${folderId}`);
    return 'dummy-doc-id';
  }

  async updateGoogleDoc(_file: TFile, metadata: any): Promise<void> {
    // TODO: Implement actual Google Docs update
    console.log(`Updating Google Doc ${metadata.id}`);
  }

  async updateLocalFile(file: TFile, metadata: any): Promise<void> {
    // TODO: Implement actual Google Docs content fetch and local update
    console.log(`Updating local file ${file.path} from doc ${metadata.id}`);
  }
}
