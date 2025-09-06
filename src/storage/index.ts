/**
 * Unified LocalStorage interface for file system operations
 *
 * This module provides a unified interface for file operations that works
 * across both CLI (Bun/Node.js filesystem) and Plugin (Obsidian Vault) environments.
 *
 * Usage:
 *
 * ```typescript
 * import { createLocalStorage, LocalStorage } from './storage';
 *
 * // For CLI environment
 * const cliStorage = createLocalStorage('cli', { baseDirectory: '/path/to/docs' });
 *
 * // For Plugin environment
 * const pluginStorage = createLocalStorage('plugin', { vault: obsidianVault, baseFolder: 'GoogleDocs' });
 *
 * // Use the same interface for both
 * async function syncFile(storage: LocalStorage, path: string, content: string) {
 *   await storage.writeFile(path, content);
 *   const savedContent = await storage.readFile(path);
 *   console.log(`Saved ${savedContent.length} characters to ${path}`);
 * }
 * ```
 */

export { LocalStorage, FileMetadata, ExtendedLocalStorage } from './LocalStorage.js';
export { FilesystemStorage } from './FilesystemStorage.js';
export { ObsidianStorage } from './ObsidianStorage.js';
export {
  DocumentSyncService,
  createLocalStorage,
  cliExample,
  pluginExample,
  polymorphicExample,
} from './example-usage.js';

// Re-export for convenience
export type { LocalStorage as ILocalStorage } from './LocalStorage.js';
