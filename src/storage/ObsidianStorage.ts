/**
 * Obsidian Vault-based storage implementation for Plugin environment
 * Uses Obsidian's Vault API for file operations
 */

import { TFile, TFolder, Vault, normalizePath } from 'obsidian';

import { FileMetadata, ExtendedLocalStorage } from './LocalStorage.js';

export class ObsidianStorage implements ExtendedLocalStorage {
  private vault: Vault;
  private baseFolder: string;

  constructor(vault: Vault, baseFolder?: string) {
    this.vault = vault;
    // Normalize base folder path (remove leading/trailing slashes)
    this.baseFolder = baseFolder ? normalizePath(baseFolder.replace(/^\/+|\/+$/g, '')) : '';
  }

  /**
   * Resolve path relative to base folder
   */
  private resolvePath(filePath: string): string {
    // Normalize the path first
    const normalized = normalizePath(filePath);

    // If we have a base folder, prepend it unless path is already absolute from vault root
    if (this.baseFolder && !normalized.startsWith(this.baseFolder)) {
      return normalizePath(`${this.baseFolder}/${normalized}`);
    }

    return normalized;
  }

  async readFile(filePath: string): Promise<string> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const file = this.vault.getAbstractFileByPath(resolvedPath);

      if (!file || !(file instanceof TFile)) {
        throw new Error(`File not found: ${filePath}`);
      }

      return await this.vault.read(file);
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${(error as Error).message}`);
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const existingFile = this.vault.getAbstractFileByPath(resolvedPath);

      if (existingFile && existingFile instanceof TFile) {
        // File exists, modify it
        await this.vault.modify(existingFile, content);
      } else {
        // File doesn't exist, create it
        // First ensure parent directories exist
        const parentPath = this.getDirectoryName(resolvedPath);
        if (parentPath && parentPath !== '.') {
          await this.createDirectory(parentPath);
        }

        await this.vault.create(resolvedPath, content);
      }
    } catch (error) {
      throw new Error(`Failed to write file ${filePath}: ${(error as Error).message}`);
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const file = this.vault.getAbstractFileByPath(resolvedPath);

      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      await this.vault.delete(file);
    } catch (error) {
      throw new Error(`Failed to delete file ${filePath}: ${(error as Error).message}`);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const resolvedPath = this.resolvePath(filePath);
    const file = this.vault.getAbstractFileByPath(resolvedPath);
    return file !== null;
  }

  async listFiles(directory: string, pattern?: string): Promise<string[]> {
    try {
      const resolvedDir = this.resolvePath(directory);
      const folder = this.vault.getAbstractFileByPath(resolvedDir);

      if (!folder || !(folder instanceof TFolder)) {
        // If directory doesn't exist or is not a folder, return empty array
        return [];
      }

      let files = folder.children
        .filter((child) => child instanceof TFile)
        .map((file) => {
          // Return path relative to the requested directory
          const relativePath = file.path.startsWith(resolvedDir + '/')
            ? file.path.substring(resolvedDir.length + 1)
            : file.name;
          return relativePath;
        });

      // Apply pattern filter if provided
      if (pattern) {
        const regex = this.globToRegex(pattern);
        files = files.filter((file) => regex.test(this.getBaseName(file)));
      }

      return files;
    } catch (error) {
      throw new Error(`Failed to list files in ${directory}: ${(error as Error).message}`);
    }
  }

  async getModifiedTime(filePath: string): Promise<number> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const file = this.vault.getAbstractFileByPath(resolvedPath);

      if (!file || !(file instanceof TFile)) {
        throw new Error(`File not found: ${filePath}`);
      }

      return file.stat.mtime;
    } catch (error) {
      throw new Error(`Failed to get modified time for ${filePath}: ${(error as Error).message}`);
    }
  }

  async createDirectory(dirPath: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(dirPath);

      // Check if directory already exists
      const existingFolder = this.vault.getAbstractFileByPath(resolvedPath);
      if (existingFolder && existingFolder instanceof TFolder) {
        return; // Directory already exists
      }

      // Create directory and any necessary parent directories
      await this.vault.createFolder(resolvedPath);
    } catch (error) {
      // Obsidian's createFolder may throw if folder already exists
      // Check if the error is because the folder already exists
      const existingFolder = this.vault.getAbstractFileByPath(this.resolvePath(dirPath));
      if (existingFolder && existingFolder instanceof TFolder) {
        return; // Directory now exists, ignore the error
      }

      throw new Error(`Failed to create directory ${dirPath}: ${(error as Error).message}`);
    }
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    try {
      const resolvedOldPath = this.resolvePath(oldPath);
      const resolvedNewPath = this.resolvePath(newPath);

      const file = this.vault.getAbstractFileByPath(resolvedOldPath);
      if (!file || !(file instanceof TFile)) {
        throw new Error(`File not found: ${oldPath}`);
      }

      // Ensure parent directory of new path exists
      const parentDir = this.getDirectoryName(resolvedNewPath);
      if (parentDir && parentDir !== '.') {
        await this.createDirectory(parentDir);
      }

      await this.vault.rename(file, resolvedNewPath);
    } catch (error) {
      throw new Error(
        `Failed to move file from ${oldPath} to ${newPath}: ${(error as Error).message}`,
      );
    }
  }

  async getFileSize(filePath: string): Promise<number> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const file = this.vault.getAbstractFileByPath(resolvedPath);

      if (!file || !(file instanceof TFile)) {
        throw new Error(`File not found: ${filePath}`);
      }

      return file.stat.size;
    } catch (error) {
      throw new Error(`Failed to get file size for ${filePath}: ${(error as Error).message}`);
    }
  }

  async isFile(filePath: string): Promise<boolean> {
    const resolvedPath = this.resolvePath(filePath);
    const file = this.vault.getAbstractFileByPath(resolvedPath);
    return file instanceof TFile;
  }

  async isDirectory(dirPath: string): Promise<boolean> {
    const resolvedPath = this.resolvePath(dirPath);
    const folder = this.vault.getAbstractFileByPath(resolvedPath);
    return folder instanceof TFolder;
  }

  getBaseName(filePath: string): string {
    // Simple basename implementation for Obsidian paths
    const parts = filePath.split('/');
    return parts[parts.length - 1] || '';
  }

  getDirectoryName(filePath: string): string {
    // Simple dirname implementation for Obsidian paths
    const parts = filePath.split('/');
    if (parts.length <= 1) {
      return '.';
    }
    return parts.slice(0, -1).join('/');
  }

  joinPath(...segments: string[]): string {
    // Join path segments and normalize
    return normalizePath(segments.join('/'));
  }

  normalizePath(filePath: string): string {
    return normalizePath(filePath);
  }

  async getMetadata(filePath: string): Promise<FileMetadata> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const file = this.vault.getAbstractFileByPath(resolvedPath);

      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      return {
        path: filePath,
        size: file instanceof TFile ? file.stat.size : 0,
        modifiedTime: file instanceof TFile ? file.stat.mtime : Date.now(),
        isFile: file instanceof TFile,
        isDirectory: file instanceof TFolder,
      };
    } catch (error) {
      throw new Error(`Failed to get metadata for ${filePath}: ${(error as Error).message}`);
    }
  }

  async listFilesWithMetadata(directory: string, pattern?: string): Promise<FileMetadata[]> {
    try {
      const resolvedDir = this.resolvePath(directory);
      const folder = this.vault.getAbstractFileByPath(resolvedDir);

      if (!folder || !(folder instanceof TFolder)) {
        return [];
      }

      let children = folder.children;

      // Apply pattern filter if provided
      if (pattern) {
        const regex = this.globToRegex(pattern);
        children = children.filter((child) => regex.test(child.name));
      }

      return children.map((child) => {
        const relativePath = child.path.startsWith(resolvedDir + '/')
          ? child.path.substring(resolvedDir.length + 1)
          : child.name;

        return {
          path: relativePath,
          size: child instanceof TFile ? child.stat.size : 0,
          modifiedTime: child instanceof TFile ? child.stat.mtime : Date.now(),
          isFile: child instanceof TFile,
          isDirectory: child instanceof TFolder,
        };
      });
    } catch (error) {
      throw new Error(
        `Failed to list files with metadata in ${directory}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Watch for file changes using Obsidian's event system
   * Note: Obsidian's event system has specific type requirements that vary by version
   */
  watchFile?(
    _filePath: string,
    _callback: (event: 'change' | 'create' | 'delete', path: string) => void,
  ): () => void {
    // For now, return a no-op implementation to avoid TypeScript issues
    // This can be implemented when specific Obsidian event requirements are clarified
    console.warn('File watching not yet implemented for Obsidian storage');

    // Return no-op cleanup function
    return () => {};
  }

  /**
   * Convert glob pattern to regex
   * Simple implementation for basic patterns like *.md
   */
  private globToRegex(pattern: string): RegExp {
    // Escape special regex characters except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Convert glob wildcards to regex
    const regexPattern = escaped
      .replace(/\*/g, '.*') // * matches any sequence of characters
      .replace(/\?/g, '.'); // ? matches any single character

    return new RegExp(`^${regexPattern}$`);
  }

  /**
   * Recursively walk directory tree and find files matching pattern
   * Uses Obsidian's vault file listing
   */
  async walkDirectory(directory: string, pattern?: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const resolvedDir = this.resolvePath(directory);

      // Get all files in the vault
      const allFiles = this.vault.getMarkdownFiles(); // For markdown files specifically

      // Filter files that are in the target directory
      const dirFiles = allFiles.filter((file) => {
        return (
          file.path.startsWith(resolvedDir + '/') ||
          (resolvedDir === '' && !file.path.includes('/'))
        );
      });

      // Apply pattern filter if provided
      for (const file of dirFiles) {
        const relativePath = resolvedDir ? file.path.substring(resolvedDir.length + 1) : file.path;

        if (!pattern || this.globToRegex(pattern).test(file.name)) {
          results.push(relativePath);
        }
      }
    } catch (error) {
      console.warn(`Failed to walk directory ${directory}:`, error);
    }

    return results;
  }

  /**
   * Get all markdown files in the vault (Obsidian-specific convenience method)
   */
  async getAllMarkdownFiles(): Promise<string[]> {
    const files = this.vault.getMarkdownFiles();

    // Filter by base folder if specified
    if (this.baseFolder) {
      return files
        .filter((file) => file.path.startsWith(this.baseFolder + '/'))
        .map((file) => file.path.substring(this.baseFolder.length + 1));
    }

    return files.map((file) => file.path);
  }

  /**
   * Get base folder
   */
  getBaseFolder(): string {
    return this.baseFolder;
  }

  /**
   * Set base folder
   */
  setBaseFolder(folder: string): void {
    this.baseFolder = folder ? normalizePath(folder.replace(/^\/+|\/+$/g, '')) : '';
  }

  /**
   * Get the underlying Obsidian vault instance
   */
  getVault(): Vault {
    return this.vault;
  }
}
