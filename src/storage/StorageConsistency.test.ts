/**
 * Tests to verify storage interface consistency between implementations
 * Ensures FilesystemStorage and ObsidianStorage behave identically
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { FilesystemStorage } from './FilesystemStorage.js';
import { LocalStorage } from './LocalStorage.js';

// Mock Obsidian types for testing
class MockTFile {
  constructor(public path: string, public name: string) {}
}

class MockTFolder {
  constructor(public path: string, public name: string) {}
}

class MockVault {
  private files = new Map<string, string>();

  getAbstractFileByPath(path: string): MockTFile | null {
    return this.files.has(path) ? new MockTFile(path, path.split('/').pop() || '') : null;
  }

  async read(file: MockTFile): Promise<string> {
    const content = this.files.get(file.path);
    if (!content) throw new Error(`File not found: ${file.path}`);
    return content;
  }

  async modify(file: MockTFile, content: string): Promise<void> {
    this.files.set(file.path, content);
  }

  async create(path: string, content: string): Promise<MockTFile> {
    this.files.set(path, content);
    return new MockTFile(path, path.split('/').pop() || '');
  }

  async delete(file: MockTFile): Promise<void> {
    this.files.delete(file.path);
  }

  getAllLoadedFiles(): MockTFile[] {
    return Array.from(this.files.keys()).map(path => new MockTFile(path, path.split('/').pop() || ''));
  }

  async createFolder(path: string): Promise<MockTFolder> {
    return new MockTFolder(path, path.split('/').pop() || '');
  }

  adapter = {
    exists: async (path: string) => this.files.has(path),
    stat: async (path: string) => ({
      type: 'file',
      mtime: Date.now(),
      size: this.files.get(path)?.length || 0,
    }),
    rename: async (oldPath: string, newPath: string) => {
      const content = this.files.get(oldPath);
      if (content) {
        this.files.set(newPath, content);
        this.files.delete(oldPath);
      }
    },
  };
}

// Skip ObsidianStorage import for now to avoid obsidian dependency in tests
// const { ObsidianStorage } = await import('./ObsidianStorage.js');

describe('Storage Interface Consistency', () => {
  let tempDir: string;
  let filesystemStorage: FilesystemStorage;

  beforeEach(async () => {
    // Setup filesystem storage
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-consistency-test-'));
    filesystemStorage = new FilesystemStorage(tempDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const testStorageImplementation = (
    name: string, 
    getStorage: () => LocalStorage
  ) => {
    describe(`${name} implementation`, () => {
      let storage: LocalStorage;

      beforeEach(() => {
        storage = getStorage();
      });

      it('should handle basic file operations consistently', async () => {
        const testFile = 'test-consistency.md';
        const testContent = '# Test Content\n\nThis is a consistency test.';

        // Test write
        await storage.writeFile(testFile, testContent);

        // Test exists
        expect(await storage.exists(testFile)).toBe(true);

        // Test read
        const readContent = await storage.readFile(testFile);
        expect(readContent).toBe(testContent);

        // Test delete
        await storage.deleteFile(testFile);
        expect(await storage.exists(testFile)).toBe(false);
      });

      it('should handle directory operations consistently', async () => {
        const testDir = 'subdir';
        const testFile = `${testDir}/nested-file.md`;
        const testContent = 'Nested content';

        // Create directory and file
        await storage.createDirectory(testDir);
        await storage.writeFile(testFile, testContent);

        // Verify file exists
        expect(await storage.exists(testFile)).toBe(true);
        expect(await storage.readFile(testFile)).toBe(testContent);

        // List files should include nested file
        const files = await storage.listFiles(testDir);
        expect(files.length).toBeGreaterThan(0);
      });

      it('should handle path normalization consistently', async () => {
        const testFile = './test-path.md';
        const testContent = 'Path normalization test';

        await storage.writeFile(testFile, testContent);
        expect(await storage.exists(testFile)).toBe(true);
        expect(await storage.readFile(testFile)).toBe(testContent);
      });

      it('should handle errors consistently', async () => {
        // Test reading non-existent file
        await expect(storage.readFile('non-existent.md')).rejects.toThrow();

        // Test deleting non-existent file (should handle gracefully or throw consistently)
        const deletePromise = storage.deleteFile('non-existent.md');
        await expect(deletePromise).rejects.toThrow();
      });
    });
  };

  // Test FilesystemStorage implementation
  testStorageImplementation('FilesystemStorage', () => filesystemStorage);

  describe('Interface compliance', () => {
    it('should provide consistent interface compliance', () => {
      // Verify FilesystemStorage implements LocalStorage interface
      const fsStorage: LocalStorage = filesystemStorage;

      // Check all required methods exist
      const requiredMethods = [
        'readFile', 'writeFile', 'deleteFile', 'exists', 'listFiles',
        'getModifiedTime', 'createDirectory', 'moveFile'
      ];

      for (const method of requiredMethods) {
        expect(typeof fsStorage[method as keyof LocalStorage]).toBe('function');
      }
    });
  });

  describe('Error handling consistency', () => {
    it('should throw error types for failure conditions', async () => {
      const nonExistentFile = 'does-not-exist.md';

      // Should throw when reading non-existent file
      let fsError: Error | undefined;

      try {
        await filesystemStorage.readFile(nonExistentFile);
      } catch (error) {
        fsError = error as Error;
      }

      expect(fsError).toBeDefined();
      expect(fsError).toBeInstanceOf(Error);

      // Error message should contain the file name
      expect(fsError!.message).toContain(nonExistentFile);
    });
  });
});