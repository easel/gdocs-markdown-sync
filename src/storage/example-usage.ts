/**
 * Example usage of the LocalStorage interface
 * Demonstrates how to use the unified interface in both CLI and Plugin environments
 */

import { FilesystemStorage } from './FilesystemStorage.js';
import { LocalStorage } from './LocalStorage.js';
import { ObsidianStorage } from './ObsidianStorage.js';

/**
 * Example service that uses LocalStorage interface
 * This can work with both CLI and Plugin implementations
 */
export class DocumentSyncService {
  private storage: LocalStorage;

  constructor(storage: LocalStorage) {
    this.storage = storage;
  }

  /**
   * Sync a document by reading, processing, and writing back
   */
  async syncDocument(filePath: string, remoteContent: string): Promise<void> {
    try {
      // Read current local content
      const localContent = await this.storage.readFile(filePath);
      console.log(`Read local file: ${filePath} (${localContent.length} chars)`);

      // Simple merge strategy (in real implementation, this would be more sophisticated)
      const mergedContent = this.mergeContent(localContent, remoteContent);

      // Write back merged content
      await this.storage.writeFile(filePath, mergedContent);
      console.log(`Updated file: ${filePath}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('File not found')) {
        // File doesn't exist locally, create it with remote content
        await this.storage.writeFile(filePath, remoteContent);
        console.log(`Created new file: ${filePath}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * List all markdown files in a directory
   */
  async listMarkdownFiles(directory: string = '.'): Promise<string[]> {
    return await this.storage.listFiles(directory, '*.md');
  }

  /**
   * Create a backup of a file
   */
  async createBackup(filePath: string): Promise<string> {
    const content = await this.storage.readFile(filePath);
    const backupPath = `${filePath}.backup.${Date.now()}`;
    await this.storage.writeFile(backupPath, content);
    console.log(`Created backup: ${backupPath}`);
    return backupPath;
  }

  /**
   * Get file information
   */
  async getFileInfo(filePath: string) {
    const exists = await this.storage.exists(filePath);
    if (!exists) {
      return null;
    }

    const [size, modifiedTime, isFile] = await Promise.all([
      this.storage.getFileSize(filePath),
      this.storage.getModifiedTime(filePath),
      this.storage.isFile(filePath),
    ]);

    return {
      path: filePath,
      size,
      modifiedTime: new Date(modifiedTime),
      isFile,
      basename: this.storage.getBaseName(filePath),
      directory: this.storage.getDirectoryName(filePath),
    };
  }

  /**
   * Simple content merging (placeholder implementation)
   */
  private mergeContent(local: string, remote: string): string {
    // In a real implementation, this would use proper diff/merge algorithms
    if (local === remote) {
      return local;
    }

    // Simple timestamp-based approach
    const timestamp = new Date().toISOString();
    return `${remote}\n\n<!-- Merged at ${timestamp} -->\n<!-- Local changes were: -->\n<!-- ${local.replace(/\n/g, '\\n')} -->`;
  }
}

/**
 * Factory function to create storage instance based on environment
 */
export function createLocalStorage(environment: 'cli' | 'plugin', options: any = {}): LocalStorage {
  if (environment === 'cli') {
    const baseDirectory = options.baseDirectory || process.cwd();
    return new FilesystemStorage(baseDirectory);
  } else if (environment === 'plugin') {
    const { vault, baseFolder } = options;
    if (!vault) {
      throw new Error('Obsidian vault instance required for plugin environment');
    }
    return new ObsidianStorage(vault, baseFolder);
  } else {
    throw new Error(`Unknown environment: ${environment}`);
  }
}

/**
 * Example CLI usage
 */
export async function cliExample() {
  console.log('=== CLI Example ===');

  // Create filesystem storage for CLI
  const storage = createLocalStorage('cli', {
    baseDirectory: '/tmp/cli-example',
  });

  // Create the service
  const syncService = new DocumentSyncService(storage);

  // Create example directory
  await storage.createDirectory('documents');

  // Sync some documents
  await syncService.syncDocument(
    'documents/test1.md',
    '# Remote Document 1\n\nThis came from remote.',
  );
  await syncService.syncDocument(
    'documents/test2.md',
    '# Remote Document 2\n\nAnother remote document.',
  );

  // List all markdown files
  const files = await syncService.listMarkdownFiles('documents');
  console.log('Found markdown files:', files);

  // Get file info
  for (const file of files) {
    const info = await syncService.getFileInfo(`documents/${file}`);
    console.log(`File info for ${file}:`, info);
  }
}

/**
 * Example Plugin usage (pseudo-code since we don't have actual Obsidian vault)
 */
export async function pluginExample(vault: any) {
  console.log('=== Plugin Example ===');

  // Create Obsidian storage for plugin
  const storage = createLocalStorage('plugin', {
    vault,
    baseFolder: 'GoogleDocs',
  });

  // Create the service
  const syncService = new DocumentSyncService(storage);

  // Sync some documents
  await syncService.syncDocument('doc1.md', '# Remote Document 1\n\nThis came from Google Docs.');
  await syncService.syncDocument('subfolder/doc2.md', '# Remote Document 2\n\nAnother Google Doc.');

  // List all markdown files
  const files = await syncService.listMarkdownFiles();
  console.log('Found markdown files:', files);

  // Get file info
  for (const file of files) {
    const info = await syncService.getFileInfo(file);
    console.log(`File info for ${file}:`, info);
  }
}

/**
 * Example of polymorphic usage - same code works with both implementations
 */
export async function polymorphicExample(storage: LocalStorage) {
  console.log('=== Polymorphic Example ===');

  const syncService = new DocumentSyncService(storage);

  // This code works the same regardless of whether storage is FilesystemStorage or ObsidianStorage
  await syncService.syncDocument(
    'example.md',
    '# Example Document\n\nThis works with any storage implementation.',
  );

  const files = await syncService.listMarkdownFiles();
  console.log('Markdown files found:', files);

  if (files.includes('example.md')) {
    const info = await syncService.getFileInfo('example.md');
    console.log('Example file info:', info);
  }
}

// Export everything for easy importing
export { LocalStorage, FilesystemStorage, ObsidianStorage };
