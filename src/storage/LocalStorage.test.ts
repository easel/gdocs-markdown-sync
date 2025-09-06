/**
 * Tests for LocalStorage interface implementations
 * Tests both FilesystemStorage and basic interface compliance
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { FilesystemStorage } from './FilesystemStorage.js';
import { LocalStorage } from './LocalStorage.js';

describe('LocalStorage Interface', () => {
  let tempDir: string;
  let storage: FilesystemStorage;

  beforeEach(async () => {
    // Create temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localstorage-test-'));
    storage = new FilesystemStorage(tempDir);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up temp directory:', error);
    }
  });

  describe('FilesystemStorage', () => {
    it('should implement LocalStorage interface', () => {
      expect(storage).toBeInstanceOf(FilesystemStorage);

      // Check that all required methods are present
      expect(typeof storage.readFile).toBe('function');
      expect(typeof storage.writeFile).toBe('function');
      expect(typeof storage.deleteFile).toBe('function');
      expect(typeof storage.exists).toBe('function');
      expect(typeof storage.listFiles).toBe('function');
      expect(typeof storage.getModifiedTime).toBe('function');
      expect(typeof storage.createDirectory).toBe('function');
      expect(typeof storage.moveFile).toBe('function');
      expect(typeof storage.getFileSize).toBe('function');
      expect(typeof storage.isFile).toBe('function');
      expect(typeof storage.isDirectory).toBe('function');
      expect(typeof storage.getBaseName).toBe('function');
      expect(typeof storage.getDirectoryName).toBe('function');
      expect(typeof storage.joinPath).toBe('function');
      expect(typeof storage.normalizePath).toBe('function');
    });

    it('should write and read files', async () => {
      const filePath = 'test.md';
      const content = '# Test Document\n\nThis is a test.';

      await storage.writeFile(filePath, content);
      const readContent = await storage.readFile(filePath);

      expect(readContent).toBe(content);
    });

    it('should check file existence', async () => {
      const filePath = 'exists-test.md';

      // File should not exist initially
      expect(await storage.exists(filePath)).toBe(false);

      // Write file and check existence
      await storage.writeFile(filePath, 'test content');
      expect(await storage.exists(filePath)).toBe(true);
    });

    it('should create directories', async () => {
      const dirPath = 'nested/directory/structure';

      await storage.createDirectory(dirPath);
      expect(await storage.isDirectory(dirPath)).toBe(true);
    });

    it('should list files in directory', async () => {
      // Create test files
      await storage.writeFile('file1.md', 'content1');
      await storage.writeFile('file2.txt', 'content2');
      await storage.writeFile('file3.md', 'content3');

      // List all files
      const allFiles = await storage.listFiles('.');
      expect(allFiles).toContain('file1.md');
      expect(allFiles).toContain('file2.txt');
      expect(allFiles).toContain('file3.md');

      // List only markdown files
      const mdFiles = await storage.listFiles('.', '*.md');
      expect(mdFiles).toContain('file1.md');
      expect(mdFiles).toContain('file3.md');
      expect(mdFiles).not.toContain('file2.txt');
    });

    it('should get file metadata', async () => {
      const filePath = 'metadata-test.md';
      const content = 'Test content for metadata';

      await storage.writeFile(filePath, content);

      const metadata = await storage.getMetadata(filePath);
      expect(metadata.path).toBe(filePath);
      expect(metadata.size).toBe(Buffer.byteLength(content, 'utf-8'));
      expect(metadata.isFile).toBe(true);
      expect(metadata.isDirectory).toBe(false);
      expect(metadata.modifiedTime).toBeGreaterThan(0);
    });

    it('should move files', async () => {
      const oldPath = 'old-location.md';
      const newPath = 'new-location.md';
      const content = 'File to be moved';

      await storage.writeFile(oldPath, content);
      expect(await storage.exists(oldPath)).toBe(true);

      await storage.moveFile(oldPath, newPath);

      expect(await storage.exists(oldPath)).toBe(false);
      expect(await storage.exists(newPath)).toBe(true);

      const movedContent = await storage.readFile(newPath);
      expect(movedContent).toBe(content);
    });

    it('should delete files', async () => {
      const filePath = 'to-be-deleted.md';

      await storage.writeFile(filePath, 'content to delete');
      expect(await storage.exists(filePath)).toBe(true);

      await storage.deleteFile(filePath);
      expect(await storage.exists(filePath)).toBe(false);
    });

    it('should handle nested directory operations', async () => {
      const nestedFile = 'deeply/nested/directory/file.md';
      const content = 'Nested file content';

      // Writing should create parent directories automatically
      await storage.writeFile(nestedFile, content);

      expect(await storage.exists(nestedFile)).toBe(true);
      expect(await storage.isDirectory('deeply')).toBe(true);
      expect(await storage.isDirectory('deeply/nested')).toBe(true);
      expect(await storage.isDirectory('deeply/nested/directory')).toBe(true);

      const readContent = await storage.readFile(nestedFile);
      expect(readContent).toBe(content);
    });

    it('should handle path utilities correctly', () => {
      expect(storage.getBaseName('path/to/file.md')).toBe('file.md');
      expect(storage.getDirectoryName('path/to/file.md')).toBe('path/to');
      expect(storage.joinPath('path', 'to', 'file.md')).toBe('path/to/file.md');
      expect(storage.normalizePath('path//to/../file.md')).toBe('path/file.md');
    });

    it('should walk directory tree', async () => {
      // Create nested structure with files
      await storage.writeFile('root.md', 'root file');
      await storage.writeFile('subdir/sub.md', 'sub file');
      await storage.writeFile('subdir/nested/deep.md', 'deep file');
      await storage.writeFile('subdir/nested/other.txt', 'text file');

      const allFiles = await storage.walkDirectory('.');
      expect(allFiles).toContain('root.md');
      expect(allFiles).toContain('subdir/sub.md');
      expect(allFiles).toContain('subdir/nested/deep.md');
      expect(allFiles).toContain('subdir/nested/other.txt');

      // Walk with pattern filter
      const mdFiles = await storage.walkDirectory('.', '*.md');
      expect(mdFiles).toContain('root.md');
      expect(mdFiles).toContain('subdir/sub.md');
      expect(mdFiles).toContain('subdir/nested/deep.md');
      expect(mdFiles).not.toContain('subdir/nested/other.txt');
    });

    it('should handle errors gracefully', async () => {
      // Test reading non-existent file
      await expect(storage.readFile('nonexistent.md')).rejects.toThrow();

      // Test deleting non-existent file
      await expect(storage.deleteFile('nonexistent.md')).rejects.toThrow();

      // Test moving non-existent file
      await expect(storage.moveFile('nonexistent.md', 'target.md')).rejects.toThrow();

      // Test getting metadata for non-existent file
      await expect(storage.getMetadata('nonexistent.md')).rejects.toThrow();
    });

    it('should handle relative vs absolute paths correctly', async () => {
      const relativePath = 'relative-test.md';
      const absolutePath = path.join(tempDir, 'absolute-test.md');
      const content = 'Path test content';

      // Test relative path
      await storage.writeFile(relativePath, content);
      expect(await storage.exists(relativePath)).toBe(true);

      // Test absolute path
      await storage.writeFile(absolutePath, content);
      expect(await storage.exists(absolutePath)).toBe(true);

      // Both should be accessible
      const relativeContent = await storage.readFile(relativePath);
      const absoluteContent = await storage.readFile(absolutePath);

      expect(relativeContent).toBe(content);
      expect(absoluteContent).toBe(content);
    });

    it('should support different base directories', async () => {
      const subDir = path.join(tempDir, 'subbase');
      await fs.mkdir(subDir, { recursive: true });

      const subStorage = new FilesystemStorage(subDir);

      // Write file in sub storage
      await subStorage.writeFile('sub-file.md', 'sub content');

      // Should exist in sub storage
      expect(await subStorage.exists('sub-file.md')).toBe(true);

      // Should not exist in main storage (different base)
      expect(await storage.exists('sub-file.md')).toBe(false);

      // But should exist with full path in main storage
      const fullPath = path.join('subbase', 'sub-file.md');
      expect(await storage.exists(fullPath)).toBe(true);
    });
  });

  describe('Interface compliance', () => {
    it('should satisfy LocalStorage interface contract', () => {
      // This test ensures the implementation satisfies the interface
      const localStorage: LocalStorage = storage;

      expect(localStorage).toBeDefined();
      expect(typeof localStorage.readFile).toBe('function');
      expect(typeof localStorage.writeFile).toBe('function');
      expect(typeof localStorage.deleteFile).toBe('function');
      expect(typeof localStorage.exists).toBe('function');
      expect(typeof localStorage.listFiles).toBe('function');
      expect(typeof localStorage.getModifiedTime).toBe('function');
      expect(typeof localStorage.createDirectory).toBe('function');
      expect(typeof localStorage.moveFile).toBe('function');
      expect(typeof localStorage.getFileSize).toBe('function');
      expect(typeof localStorage.isFile).toBe('function');
      expect(typeof localStorage.isDirectory).toBe('function');
      expect(typeof localStorage.getBaseName).toBe('function');
      expect(typeof localStorage.getDirectoryName).toBe('function');
      expect(typeof localStorage.joinPath).toBe('function');
      expect(typeof localStorage.normalizePath).toBe('function');
    });
  });
});
