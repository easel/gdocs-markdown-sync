/**
 * Bidirectional Folder Sync Integration Tests
 * 
 * Tests comprehensive folder synchronization between local filesystem and Google Drive,
 * validating that nested folder structures and document relationships are maintained
 * correctly in both directions.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';

import { DriveAPI, DriveDocument } from './drive/DriveAPI';
import { parseFrontMatter, buildFrontMatter, computeSHA256, FrontMatter } from './fs/frontmatter';
import { FilesystemStorage } from './storage/FilesystemStorage';
import { GoogleDocsSyncSettings } from './types';
import {
  checkAuthenticationAvailable,
  loadCLIToken,
  createLiveDriveClient,
} from './test-utils/auth-helpers';

// Test configuration
const TEST_SESSION_ID = `folder-sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
const ITEST_PROFILE = process.env.ITEST_PROFILE || 'default';
const TEMP_DIR = path.join(os.tmpdir(), 'gdocs-sync-test', TEST_SESSION_ID);

// Test folder structures
interface TestFolderStructure {
  [folderName: string]: TestFolderStructure | string; // string = file content
}

interface FolderComparisonResult {
  matches: boolean;
  localOnly: string[];
  remoteOnly: string[];
  contentMismatches: { path: string; reason: string }[];
}

const SAMPLE_FOLDER_STRUCTURE: TestFolderStructure = {
  'project-docs': {
    'overview.md': '# Project Overview\n\nThis is the main project overview document.',
    'architecture': {
      'system-design.md': '# System Design\n\nDetailed system architecture documentation.',
      'api-spec.md': '# API Specification\n\nREST API endpoints and schemas.',
    },
    'guides': {
      'setup': {
        'installation.md': '# Installation Guide\n\nStep by step installation instructions.',
        'configuration.md': '# Configuration\n\nHow to configure the application.',
      },
      'user-guide.md': '# User Guide\n\nComprehensive user documentation.',
    },
    'changelog.md': '# Changelog\n\nVersion history and release notes.',
  },
  'meeting-notes': {
    'q1-planning.md': '# Q1 Planning Meeting\n\nMeeting notes from quarterly planning.',
    'daily-standups': {
      '2024-01-15.md': '# Daily Standup - Jan 15\n\nDaily team sync notes.',
      '2024-01-16.md': '# Daily Standup - Jan 16\n\nDaily team sync notes.',
    },
  },
  'root-doc.md': '# Root Document\n\nA document at the root level.',
};

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true';
const SHOULD_RUN = RUN_INTEGRATION_TESTS && checkAuthenticationAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

d('Bidirectional Folder Sync Integration Tests', () => {
  let driveClient: DriveAPI;
  let localStorage: FilesystemStorage;
  let testRemoteFolderId: string;
  let testLocalPath: string;
  let createdFileIds: string[] = [];
  let createdFolderIds: string[] = [];

  beforeAll(async () => {
    console.log(`🧪 Starting folder sync integration tests session: ${TEST_SESSION_ID}`);
    
    // Setup authentication
    driveClient = await createLiveDriveClient();
    
    // Create test local directory
    testLocalPath = TEMP_DIR;
    await fs.mkdir(testLocalPath, { recursive: true });
    localStorage = new FilesystemStorage(testLocalPath);
    console.log(`📁 Created local test directory: ${testLocalPath}`);
    
    // Create test remote folder
    const remoteFolder = await driveClient.createFolder(null, `test-${TEST_SESSION_ID}`);
    testRemoteFolderId = remoteFolder.id;
    createdFolderIds.push(testRemoteFolderId);
    console.log(`🗂️  Created remote test folder: ${remoteFolder.name} (${testRemoteFolderId})`);
  });

  beforeEach(() => {
    // Reset tracking arrays for each test
    createdFileIds = [];
  });

  afterEach(async () => {
    // Clean up files created in this specific test
    console.log(`🧹 Cleaning up ${createdFileIds.length} test files...`);
    for (const fileId of createdFileIds) {
      try {
        await driveClient.deleteFile(fileId);
      } catch (error) {
        console.warn(`⚠️  Could not delete file ${fileId}: ${error}`);
      }
    }
    createdFileIds = [];
  });

  afterAll(async () => {
    // Clean up all test artifacts
    console.log(`🧹 Final cleanup: removing ${createdFolderIds.length} test folders...`);
    
    // Delete remote folders (in reverse order to handle nesting)
    for (let i = createdFolderIds.length - 1; i >= 0; i--) {
      try {
        await driveClient.deleteFile(createdFolderIds[i]);
      } catch (error) {
        console.warn(`⚠️  Could not delete folder ${createdFolderIds[i]}: ${error}`);
      }
    }
    
    // Clean up local test directory
    try {
      await fs.rm(testLocalPath, { recursive: true, force: true });
      console.log(`🗑️  Removed local test directory: ${testLocalPath}`);
    } catch (error) {
      console.warn(`⚠️  Could not remove local directory: ${error}`);
    }
  });

  /**
   * Utility: Create nested folder structure locally
   */
  async function createLocalFolderStructure(
    structure: TestFolderStructure, 
    basePath: string = testLocalPath
  ): Promise<void> {
    for (const [name, content] of Object.entries(structure)) {
      const itemPath = path.join(basePath, name);
      
      if (typeof content === 'string') {
        // It's a file
        await fs.mkdir(path.dirname(itemPath), { recursive: true });
        await fs.writeFile(itemPath, content, 'utf8');
        console.log(`📄 Created local file: ${path.relative(testLocalPath, itemPath)}`);
      } else {
        // It's a folder
        await fs.mkdir(itemPath, { recursive: true });
        console.log(`📁 Created local folder: ${path.relative(testLocalPath, itemPath)}`);
        await createLocalFolderStructure(content, itemPath);
      }
    }
  }

  /**
   * Utility: Create nested folder structure in Google Drive
   */
  async function createRemoteFolderStructure(
    structure: TestFolderStructure,
    parentFolderId: string
  ): Promise<void> {
    for (const [name, content] of Object.entries(structure)) {
      if (typeof content === 'string') {
        // It's a document
        const docResult = await driveClient.uploadMarkdownAsDoc(name.replace('.md', ''), content, parentFolderId);
        createdFileIds.push(docResult.id);
        console.log(`📄 Created remote document: ${name} (${docResult.id})`);
      } else {
        // It's a folder
        const folder = await driveClient.createFolder(parentFolderId, name);
        createdFolderIds.push(folder.id);
        console.log(`📁 Created remote folder: ${name} (${folder.id})`);
        await createRemoteFolderStructure(content, folder.id);
      }
    }
  }

  /**
   * Utility: Get all markdown files recursively from local directory
   */
  async function getLocalMarkdownFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          const subFiles = await getLocalMarkdownFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not read directory ${dirPath}: ${error}`);
    }
    
    return files;
  }

  /**
   * Utility: Get all documents recursively from remote folder
   */
  async function getRemoteDocuments(folderId: string): Promise<DriveDocument[]> {
    return await driveClient.listDocsInFolder(folderId);
  }

  /**
   * Utility: Compare folder structures between local and remote
   */
  async function compareFolderStructures(
    localPath: string, 
    remoteFolderId: string
  ): Promise<FolderComparisonResult> {
    const result: FolderComparisonResult = {
      matches: true,
      localOnly: [],
      remoteOnly: [],
      contentMismatches: [],
    };

    // Get local files
    const localFiles = await getLocalMarkdownFiles(localPath);
    const localRelativePaths = localFiles.map(f => 
      path.relative(localPath, f).replace(/\\.md$/, '').replace(/\\\\/g, '/')
    );

    // Get remote documents
    const remoteDocuments = await getRemoteDocuments(remoteFolderId);
    const remoteRelativePaths = remoteDocuments.map(d => 
      d.relativePath ? d.relativePath + '/' + d.name : d.name
    );

    // Find local-only files
    for (const localPath of localRelativePaths) {
      if (!remoteRelativePaths.includes(localPath)) {
        result.localOnly.push(localPath);
        result.matches = false;
      }
    }

    // Find remote-only documents
    for (const remotePath of remoteRelativePaths) {
      if (!localRelativePaths.includes(remotePath)) {
        result.remoteOnly.push(remotePath);
        result.matches = false;
      }
    }

    return result;
  }

  /**
   * Utility: Perform local-to-remote sync simulation
   */
  async function performLocalToRemoteSync(): Promise<{ created: number; updated: number }> {
    const localFiles = await getLocalMarkdownFiles(testLocalPath);
    let created = 0;
    let updated = 0;

    for (const filePath of localFiles) {
      const content = await fs.readFile(filePath, 'utf8');
      const { data: frontmatter, content: bodyContent } = parseFrontMatter(content);
      const relativePath = path.relative(testLocalPath, filePath);
      const docName = path.basename(relativePath, '.md');
      const folderPath = path.dirname(relativePath);

      // Determine target folder in Drive
      let targetFolderId = testRemoteFolderId;
      if (folderPath !== '.') {
        targetFolderId = await driveClient.ensureNestedFolders(folderPath, testRemoteFolderId);
        if (!createdFolderIds.includes(targetFolderId)) {
          createdFolderIds.push(targetFolderId);
        }
      }

      if (frontmatter.docId) {
        // Update existing document
        await driveClient.updateDocument(frontmatter.docId, bodyContent);
        updated++;
        console.log(`📝 Updated document: ${docName} (${frontmatter.docId})`);
      } else {
        // Create new document
        const docResult = await driveClient.uploadMarkdownAsDoc(docName, bodyContent, targetFolderId);
        createdFileIds.push(docResult.id);
        created++;
        
        // Update local file with frontmatter
        const sha256 = await computeSHA256(bodyContent);
        const updatedFrontmatter: FrontMatter = {
          ...frontmatter,
          docId: docResult.id,
          sha256,
          'last-synced': new Date().toISOString(),
        };
        const updatedContent = buildFrontMatter(updatedFrontmatter, bodyContent);
        await fs.writeFile(filePath, updatedContent, 'utf8');
        
        console.log(`📄 Created document: ${docName} (${docResult.id})`);
      }
    }

    return { created, updated };
  }

  /**
   * Utility: Perform remote-to-local sync simulation
   */
  async function performRemoteToLocalSync(): Promise<{ created: number; updated: number }> {
    const remoteDocuments = await getRemoteDocuments(testRemoteFolderId);
    let created = 0;
    let updated = 0;

    for (const doc of remoteDocuments) {
      const content = await driveClient.exportDocAsMarkdown(doc.id);
      const fileName = doc.name + '.md';
      const relativePath = doc.relativePath ? path.join(doc.relativePath, fileName) : fileName;
      const localPath = path.join(testLocalPath, relativePath);

      // Ensure local directory exists
      await fs.mkdir(path.dirname(localPath), { recursive: true });

      const sha256 = await computeSHA256(content);
      const frontmatter = {
        docId: doc.id,
        sha256,
        'last-synced': new Date().toISOString(),
      };

      const fileContent = buildFrontMatter(frontmatter, content);

      try {
        await fs.access(localPath);
        // File exists, update it
        await fs.writeFile(localPath, fileContent, 'utf8');
        updated++;
        console.log(`📝 Updated local file: ${relativePath}`);
      } catch {
        // File doesn't exist, create it
        await fs.writeFile(localPath, fileContent, 'utf8');
        created++;
        console.log(`📄 Created local file: ${relativePath}`);
      }
    }

    return { created, updated };
  }

  // Test Cases

  it('should create and sync complex nested folder structure from local to remote', async () => {
    console.log('🧪 Testing local-to-remote folder sync with complex structure');

    // Create complex local folder structure
    await createLocalFolderStructure(SAMPLE_FOLDER_STRUCTURE);
    
    // Verify local structure was created
    const localFiles = await getLocalMarkdownFiles(testLocalPath);
    console.log(`📊 Created ${localFiles.length} local files`);
    expect(localFiles.length).toBeGreaterThan(5);

    // Sync to remote
    const syncResult = await performLocalToRemoteSync();
    console.log(`📤 Sync result: ${syncResult.created} created, ${syncResult.updated} updated`);
    expect(syncResult.created).toBe(localFiles.length);
    expect(syncResult.updated).toBe(0);

    // Verify remote structure matches local
    const comparison = await compareFolderStructures(testLocalPath, testRemoteFolderId);
    console.log(`📋 Comparison - Local only: ${comparison.localOnly.length}, Remote only: ${comparison.remoteOnly.length}`);
    
    expect(comparison.matches).toBe(true);
    expect(comparison.localOnly).toHaveLength(0);
    expect(comparison.remoteOnly).toHaveLength(0);

    // Verify all local files now have frontmatter with docId
    for (const filePath of localFiles) {
      const content = await fs.readFile(filePath, 'utf8');
      const { data } = parseFrontMatter(content);
      expect(data.docId).toBeDefined();
      expect(data.sha256).toBeDefined();
      expect(data['last-synced']).toBeDefined();
    }
  }, 120000);

  it('should create and sync folder structure from remote to local', async () => {
    console.log('🧪 Testing remote-to-local folder sync');

    // Create structure in remote first
    await createRemoteFolderStructure(SAMPLE_FOLDER_STRUCTURE, testRemoteFolderId);
    
    // Verify remote structure was created
    const remoteDocuments = await getRemoteDocuments(testRemoteFolderId);
    console.log(`📊 Created ${remoteDocuments.length} remote documents`);
    expect(remoteDocuments.length).toBeGreaterThan(5);

    // Sync to local
    const syncResult = await performRemoteToLocalSync();
    console.log(`📥 Sync result: ${syncResult.created} created, ${syncResult.updated} updated`);
    expect(syncResult.created).toBe(remoteDocuments.length);
    expect(syncResult.updated).toBe(0);

    // Verify local structure was created correctly
    const localFiles = await getLocalMarkdownFiles(testLocalPath);
    console.log(`📄 Found ${localFiles.length} local files after sync`);
    expect(localFiles.length).toBe(remoteDocuments.length);

    // Verify folder structure comparison
    const comparison = await compareFolderStructures(testLocalPath, testRemoteFolderId);
    expect(comparison.matches).toBe(true);

    // Verify all created files have proper frontmatter
    for (const filePath of localFiles) {
      const content = await fs.readFile(filePath, 'utf8');
      const { data } = parseFrontMatter(content);
      expect(data.docId).toBeDefined();
      expect(data.sha256).toBeDefined();
      expect(data['last-synced']).toBeDefined();
    }
  }, 120000);

  it('should handle bidirectional updates correctly', async () => {
    console.log('🧪 Testing bidirectional updates');

    // Start with a simple structure
    const simpleStructure: TestFolderStructure = {
      'doc1.md': '# Document 1\n\nOriginal content.',
      'folder1': {
        'doc2.md': '# Document 2\n\nOriginal content.',
      },
    };

    // Create locally and sync to remote
    await createLocalFolderStructure(simpleStructure);
    let syncResult = await performLocalToRemoteSync();
    expect(syncResult.created).toBe(2);

    // Modify local files
    const doc1Path = path.join(testLocalPath, 'doc1.md');
    const doc1Content = await fs.readFile(doc1Path, 'utf8');
    const { data: doc1Frontmatter, content: doc1Body } = parseFrontMatter(doc1Content);
    
    const modifiedDoc1Body = doc1Body + '\n\nAdded locally.';
    const modifiedDoc1Content = buildFrontMatter(doc1Frontmatter, modifiedDoc1Body);
    await fs.writeFile(doc1Path, modifiedDoc1Content, 'utf8');

    // Sync local changes to remote
    syncResult = await performLocalToRemoteSync();
    expect(syncResult.updated).toBe(1);

    // Verify remote document was updated
    const updatedRemoteContent = await driveClient.exportDocAsMarkdown(doc1Frontmatter.docId);
    expect(updatedRemoteContent).toContain('Added locally.');

    // Now modify the same document remotely (simulate concurrent edit)
    const finalRemoteContent = updatedRemoteContent + '\n\nAdded remotely.';
    await driveClient.updateDocument(doc1Frontmatter.docId, finalRemoteContent);

    // Sync remote changes back to local
    syncResult = await performRemoteToLocalSync();
    expect(syncResult.updated).toBeGreaterThanOrEqual(1);

    // Verify local file was updated with remote changes
    const finalLocalContent = await fs.readFile(doc1Path, 'utf8');
    const { content: finalLocalBody } = parseFrontMatter(finalLocalContent);
    expect(finalLocalBody).toContain('Added remotely.');
    expect(finalLocalBody).toContain('Added locally.');
  }, 120000);

  it('should handle empty folders correctly', async () => {
    console.log('🧪 Testing empty folder handling');

    // Create empty folder locally
    const emptyFolderPath = path.join(testLocalPath, 'empty-folder');
    await fs.mkdir(emptyFolderPath, { recursive: true });

    // Create folder with nested empty folders
    const nestedEmptyPath = path.join(testLocalPath, 'parent', 'empty-child');
    await fs.mkdir(nestedEmptyPath, { recursive: true });
    
    // Add one file to parent to ensure folder sync
    const docInParentPath = path.join(testLocalPath, 'parent', 'doc.md');
    await fs.writeFile(docInParentPath, '# Parent Doc\n\nContent in parent folder.');

    // Sync to remote
    const syncResult = await performLocalToRemoteSync();
    expect(syncResult.created).toBe(1); // Only the document, folders created as needed

    // Verify parent folder exists in remote
    const remoteDocs = await getRemoteDocuments(testRemoteFolderId);
    const parentDoc = remoteDocs.find(d => d.name === 'doc' && d.relativePath === 'parent');
    expect(parentDoc).toBeDefined();
  }, 60000);

  it('should handle deep nesting (5+ levels)', async () => {
    console.log('🧪 Testing deep folder nesting');

    // Create deeply nested structure
    const deepStructure: TestFolderStructure = {
      'level1': {
        'level2': {
          'level3': {
            'level4': {
              'level5': {
                'deep-doc.md': '# Deep Document\n\nThis is 5 levels deep!',
              },
            },
          },
        },
      },
    };

    await createLocalFolderStructure(deepStructure);
    const syncResult = await performLocalToRemoteSync();
    expect(syncResult.created).toBe(1);

    // Verify deep document exists in remote with correct path
    const remoteDocs = await getRemoteDocuments(testRemoteFolderId);
    const deepDoc = remoteDocs.find(d => d.name === 'deep-doc');
    expect(deepDoc).toBeDefined();
    expect(deepDoc?.relativePath).toBe('level1/level2/level3/level4/level5');
  }, 90000);

  it('should handle special characters in folder and file names', async () => {
    console.log('🧪 Testing special characters in names');

    // Create structure with special characters
    const specialCharsStructure: TestFolderStructure = {
      'folder with spaces': {
        'doc-with-dashes.md': '# Document with Dashes\n\nContent here.',
      },
      'folder_with_underscores': {
        'doc with spaces.md': '# Document with Spaces\n\nContent here.',
      },
      'números-y-acentos': {
        'café-resumé.md': '# Café Resumé\n\nSpecial characters in content.',
      },
    };

    await createLocalFolderStructure(specialCharsStructure);
    const syncResult = await performLocalToRemoteSync();
    expect(syncResult.created).toBe(3);

    // Verify all documents were created successfully
    const remoteDocs = await getRemoteDocuments(testRemoteFolderId);
    expect(remoteDocs).toHaveLength(3);

    // Verify paths are preserved correctly
    const spaceDoc = remoteDocs.find(d => d.name === 'doc with spaces');
    expect(spaceDoc).toBeDefined();
    expect(spaceDoc?.relativePath).toBe('folder_with_underscores');
  }, 90000);

  it('should maintain content integrity across sync cycles', async () => {
    console.log('🧪 Testing content integrity across multiple sync cycles');

    // Create initial content with various markdown features
    const complexContent = `# Complex Document

## Headers and Lists

- List item 1
- List item 2
  - Nested item
  - Another nested item

## Code Blocks

\`\`\`javascript
function hello() {
  console.log("Hello, world!");
}
\`\`\`

## Tables

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value 1  | Value 2  | Value 3  |
| Value 4  | Value 5  | Value 6  |

## Links and Emphasis

This is **bold** and *italic* text.

[Link to Google](https://google.com)

---

> This is a blockquote
> with multiple lines.

## Special Characters

Unicode: 🚀 🎉 ✅ ❌
Math: α β γ δ ε
Symbols: © ™ ® § ¶
`;

    // Create file locally
    const complexDocPath = path.join(testLocalPath, 'complex-doc.md');
    await fs.writeFile(complexDocPath, complexContent, 'utf8');

    // Initial sync to remote
    let syncResult = await performLocalToRemoteSync();
    expect(syncResult.created).toBe(1);

    // Get the document ID
    const localContent = await fs.readFile(complexDocPath, 'utf8');
    const { data } = parseFrontMatter(localContent);
    const docId = data.docId;

    // Sync back to local (to test round-trip)
    syncResult = await performRemoteToLocalSync();
    
    // Verify content integrity
    const roundTripContent = await fs.readFile(complexDocPath, 'utf8');
    const { content: roundTripBody } = parseFrontMatter(roundTripContent);
    
    // Compare original and round-trip content
    const originalSha = await computeSHA256(complexContent);
    const roundTripSha = await computeSHA256(roundTripBody);
    
    console.log(`📊 Content integrity check:`);
    console.log(`   Original SHA: ${originalSha}`);
    console.log(`   Round-trip SHA: ${roundTripSha}`);
    console.log(`   Content length: ${complexContent.length} -> ${roundTripBody.length}`);
    
    // Note: SHA256 might differ due to Google Docs formatting normalization,
    // but the essential content should be preserved
    expect(roundTripBody).toContain('# Complex Document');
    expect(roundTripBody).toContain('List item 1');
    expect(roundTripBody).toContain('function hello()');
    expect(roundTripBody).toContain('| Column 1 | Column 2 | Column 3 |');
    expect(roundTripBody).toContain('**bold** and *italic*');
    expect(roundTripBody).toContain('[Link to Google](https://google.com)');
  }, 120000);
});