/**
 * Unified interface for local file system operations
 * Abstracts differences between CLI (Bun/Node.js filesystem) and Plugin (Obsidian Vault) environments
 */

export interface LocalStorage {
  /**
   * Read file content as UTF-8 string
   * @param path - File path (relative to vault root in Plugin, absolute in CLI)
   * @returns File content as string
   * @throws Error if file doesn't exist or cannot be read
   */
  readFile(path: string): Promise<string>;

  /**
   * Write content to file as UTF-8 string
   * @param path - File path (relative to vault root in Plugin, absolute in CLI)
   * @param content - Content to write
   * @throws Error if file cannot be written
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Delete a file
   * @param path - File path to delete
   * @throws Error if file cannot be deleted
   */
  deleteFile(path: string): Promise<void>;

  /**
   * Check if file or directory exists
   * @param path - Path to check
   * @returns true if path exists, false otherwise
   */
  exists(path: string): Promise<boolean>;

  /**
   * List files in directory, optionally filtered by pattern
   * @param directory - Directory path to list
   * @param pattern - Optional glob pattern to filter files (e.g., "*.md")
   * @returns Array of file paths relative to the directory
   */
  listFiles(directory: string, pattern?: string): Promise<string[]>;

  /**
   * Get file modification time
   * @param path - File path
   * @returns Modification time as Unix timestamp (milliseconds)
   * @throws Error if file doesn't exist
   */
  getModifiedTime(path: string): Promise<number>;

  /**
   * Create directory and any necessary parent directories
   * @param path - Directory path to create
   */
  createDirectory(path: string): Promise<void>;

  /**
   * Move/rename a file
   * @param oldPath - Current file path
   * @param newPath - New file path
   * @throws Error if move fails
   */
  moveFile(oldPath: string, newPath: string): Promise<void>;

  /**
   * Get file size in bytes
   * @param path - File path
   * @returns File size in bytes
   * @throws Error if file doesn't exist
   */
  getFileSize(path: string): Promise<number>;

  /**
   * Check if path is a file
   * @param path - Path to check
   * @returns true if path is a file, false otherwise
   */
  isFile(path: string): Promise<boolean>;

  /**
   * Check if path is a directory
   * @param path - Path to check
   * @returns true if path is a directory, false otherwise
   */
  isDirectory(path: string): Promise<boolean>;

  /**
   * Get the base name of a path (filename with extension)
   * @param path - File path
   * @returns Base name of the file
   */
  getBaseName(path: string): string;

  /**
   * Get the directory name of a path
   * @param path - File path
   * @returns Directory path
   */
  getDirectoryName(path: string): string;

  /**
   * Join path segments into a single path
   * @param segments - Path segments to join
   * @returns Joined path
   */
  joinPath(...segments: string[]): string;

  /**
   * Normalize a path (resolve . and .. segments)
   * @param path - Path to normalize
   * @returns Normalized path
   */
  normalizePath(path: string): string;
}

/**
 * File metadata interface
 */
export interface FileMetadata {
  path: string;
  size: number;
  modifiedTime: number;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Extended LocalStorage interface with additional metadata operations
 */
export interface ExtendedLocalStorage extends LocalStorage {
  /**
   * Get comprehensive file metadata
   * @param path - File path
   * @returns File metadata object
   * @throws Error if file doesn't exist
   */
  getMetadata(path: string): Promise<FileMetadata>;

  /**
   * List files with metadata
   * @param directory - Directory path
   * @param pattern - Optional glob pattern
   * @returns Array of file metadata objects
   */
  listFilesWithMetadata(directory: string, pattern?: string): Promise<FileMetadata[]>;

  /**
   * Watch for file changes (if supported by implementation)
   * @param path - Path to watch
   * @param callback - Callback for file changes
   * @returns Cleanup function to stop watching
   */
  watchFile?(
    path: string,
    callback: (event: 'change' | 'create' | 'delete', path: string) => void,
  ): () => void;
}
