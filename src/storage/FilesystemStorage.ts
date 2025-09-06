/**
 * Filesystem-based storage implementation for CLI environment (Bun/Node.js)
 * Uses native filesystem APIs for file operations
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { FileMetadata, ExtendedLocalStorage } from './LocalStorage.js';

export class FilesystemStorage implements ExtendedLocalStorage {
  private baseDirectory: string;

  constructor(baseDirectory?: string) {
    // Default to current working directory if no base directory specified
    this.baseDirectory = baseDirectory || process.cwd();
  }

  /**
   * Resolve path relative to base directory
   */
  private resolvePath(filePath: string): string {
    // If path is absolute, use as-is
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    // Otherwise resolve relative to base directory
    return path.resolve(this.baseDirectory, filePath);
  }

  async readFile(filePath: string): Promise<string> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      return await fs.readFile(resolvedPath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${(error as Error).message}`);
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(filePath);

      // Ensure parent directory exists
      const parentDir = path.dirname(resolvedPath);
      await fs.mkdir(parentDir, { recursive: true });

      await fs.writeFile(resolvedPath, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write file ${filePath}: ${(error as Error).message}`);
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      await fs.unlink(resolvedPath);
    } catch (error) {
      throw new Error(`Failed to delete file ${filePath}: ${(error as Error).message}`);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      await fs.access(resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(directory: string, pattern?: string): Promise<string[]> {
    try {
      const resolvedDir = this.resolvePath(directory);
      const entries = await fs.readdir(resolvedDir, { withFileTypes: true });

      let files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

      // Apply pattern filter if provided
      if (pattern) {
        const regex = this.globToRegex(pattern);
        files = files.filter((file) => regex.test(file));
      }

      return files;
    } catch (error) {
      throw new Error(`Failed to list files in ${directory}: ${(error as Error).message}`);
    }
  }

  async getModifiedTime(filePath: string): Promise<number> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const stats = await fs.stat(resolvedPath);
      return stats.mtime.getTime();
    } catch (error) {
      throw new Error(`Failed to get modified time for ${filePath}: ${(error as Error).message}`);
    }
  }

  async createDirectory(dirPath: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(dirPath);
      await fs.mkdir(resolvedPath, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${dirPath}: ${(error as Error).message}`);
    }
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    try {
      const resolvedOldPath = this.resolvePath(oldPath);
      const resolvedNewPath = this.resolvePath(newPath);

      // Ensure parent directory of new path exists
      const parentDir = path.dirname(resolvedNewPath);
      await fs.mkdir(parentDir, { recursive: true });

      await fs.rename(resolvedOldPath, resolvedNewPath);
    } catch (error) {
      throw new Error(
        `Failed to move file from ${oldPath} to ${newPath}: ${(error as Error).message}`,
      );
    }
  }

  async getFileSize(filePath: string): Promise<number> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const stats = await fs.stat(resolvedPath);
      return stats.size;
    } catch (error) {
      throw new Error(`Failed to get file size for ${filePath}: ${(error as Error).message}`);
    }
  }

  async isFile(filePath: string): Promise<boolean> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const stats = await fs.stat(resolvedPath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  async isDirectory(dirPath: string): Promise<boolean> {
    try {
      const resolvedPath = this.resolvePath(dirPath);
      const stats = await fs.stat(resolvedPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  getBaseName(filePath: string): string {
    return path.basename(filePath);
  }

  getDirectoryName(filePath: string): string {
    return path.dirname(filePath);
  }

  joinPath(...segments: string[]): string {
    return path.join(...segments);
  }

  normalizePath(filePath: string): string {
    return path.normalize(filePath);
  }

  async getMetadata(filePath: string): Promise<FileMetadata> {
    try {
      const resolvedPath = this.resolvePath(filePath);
      const stats = await fs.stat(resolvedPath);

      return {
        path: filePath,
        size: stats.size,
        modifiedTime: stats.mtime.getTime(),
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      throw new Error(`Failed to get metadata for ${filePath}: ${(error as Error).message}`);
    }
  }

  async listFilesWithMetadata(directory: string, pattern?: string): Promise<FileMetadata[]> {
    try {
      const resolvedDir = this.resolvePath(directory);
      const entries = await fs.readdir(resolvedDir, { withFileTypes: true });

      let filteredEntries = entries;

      // Apply pattern filter if provided
      if (pattern) {
        const regex = this.globToRegex(pattern);
        filteredEntries = entries.filter((entry) => regex.test(entry.name));
      }

      const metadataPromises = filteredEntries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        const resolvedEntryPath = this.resolvePath(entryPath);
        const stats = await fs.stat(resolvedEntryPath);

        return {
          path: entryPath,
          size: stats.size,
          modifiedTime: stats.mtime.getTime(),
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
        };
      });

      return await Promise.all(metadataPromises);
    } catch (error) {
      throw new Error(
        `Failed to list files with metadata in ${directory}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Watch for file changes using fs.watch
   * Note: fs.watch behavior varies across platforms
   */
  watchFile?(
    filePath: string,
    callback: (event: 'change' | 'create' | 'delete', path: string) => void,
  ): () => void {
    const resolvedPath = this.resolvePath(filePath);

    try {
      // Use Node.js fs.watch (not fs.promises.watch)
      const fsSync = require('fs');
      const watcher = fsSync.watch(resolvedPath, (eventType: string) => {
        // Map fs.watch events to our standardized events
        let mappedEvent: 'change' | 'create' | 'delete';

        if (eventType === 'rename') {
          // File was created or deleted
          this.exists(filePath).then((exists) => {
            mappedEvent = exists ? 'create' : 'delete';
            callback(mappedEvent, filePath);
          });
        } else {
          // File was modified
          mappedEvent = 'change';
          callback(mappedEvent, filePath);
        }
      });

      // Return cleanup function
      return () => {
        watcher.close();
      };
    } catch (error) {
      console.warn(`Failed to watch file ${filePath}:`, error);
      // Return no-op cleanup function
      return () => {};
    }
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
   * Useful for operations like finding all markdown files
   */
  async walkDirectory(directory: string, pattern?: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const resolvedDir = this.resolvePath(directory);
      const entries = await fs.readdir(resolvedDir, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          // Skip hidden directories and common ignore patterns
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            const subResults = await this.walkDirectory(entryPath, pattern);
            results.push(...subResults);
          }
        } else if (entry.isFile()) {
          // Apply pattern filter if provided
          if (!pattern || this.globToRegex(pattern).test(entry.name)) {
            results.push(entryPath);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to walk directory ${directory}:`, error);
    }

    return results;
  }

  /**
   * Get base directory
   */
  getBaseDirectory(): string {
    return this.baseDirectory;
  }

  /**
   * Set base directory
   */
  setBaseDirectory(directory: string): void {
    this.baseDirectory = directory;
  }
}
