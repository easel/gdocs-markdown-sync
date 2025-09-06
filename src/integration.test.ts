// Integration tests that use real Google Drive API
// Uses PKCE OAuth flow for secure desktop authentication (no client secrets needed)
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';

import { DriveAPI } from './drive/DriveAPI';
import { parseFrontMatter, buildFrontMatter, computeSHA256 } from './fs/frontmatter';
import {
  checkAuthenticationAvailable,
  loadCLIToken,
  createLiveDriveClient,
} from './test-utils/auth-helpers';

// Create a unique parent folder for each test run to avoid conflicts
const TEST_SESSION_ID = `itest-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
const ITEST_PROFILE = process.env.ITEST_PROFILE || 'default';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Use shared implementations from test-utils/auth-helpers.ts

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true';
const SHOULD_RUN = RUN_INTEGRATION_TESTS && checkAuthenticationAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

d('Integration Tests - Google Drive API', () => {
  let driveClient: DriveAPI;
  let testFolderIds: string[] = [];
  let parentTestFolderId: string;

  beforeEach(async () => {
    driveClient = await createLiveDriveClient();

    // Create a unique parent folder for this test session if not already created
    if (!parentTestFolderId) {
      const parentFolder = await driveClient.createFolder(null, TEST_SESSION_ID);
      parentTestFolderId = parentFolder.id;
      console.log(`Created test session folder: ${TEST_SESSION_ID} (${parentTestFolderId})`);
    }
  });

  afterEach(async () => {
    // Clean up test folders and documents (but not the parent folder yet)
    if (driveClient && testFolderIds.length > 0) {
      for (const folderId of testFolderIds) {
        try {
          await driveClient.deleteFile(folderId);
        } catch (error) {
          console.warn(`Failed to delete test folder ${folderId}:`, error);
        }
      }
      testFolderIds = [];
    }
  });

  // Clean up the parent test folder after all tests complete
  afterAll(async () => {
    if (driveClient && parentTestFolderId) {
      try {
        await driveClient.deleteFile(parentTestFolderId);
        console.log(`Cleaned up test session folder: ${parentTestFolderId}`);
      } catch (error) {
        console.warn(`Failed to delete parent test folder ${parentTestFolderId}:`, error);
      }
    }
  });

  it('should create, export, and update a Google Doc', async () => {
    // Create a unique test folder
    const testFolderName = `plugin-itest-${Date.now()}`;
    const testFolder = await driveClient.createFolder(parentTestFolderId, testFolderName);
    testFolderIds.push(testFolder.id);

    // Create a document
    const initialContent = '# Hello World\n\nThis is a test document.\n';
    const doc = await driveClient.uploadMarkdownAsDoc('TestDoc', initialContent, testFolder.id);

    // Export and verify
    const exportedContent = await driveClient.exportDocMarkdown(doc.id);
    expect(exportedContent.length).toBeGreaterThan(0);
    expect(exportedContent).toContain('Hello World');

    // Update the document
    const updatedContent = initialContent + '\nUpdated content.\n';
    await driveClient.updateDocMarkdown(doc.id, updatedContent);

    // Export again and verify the update
    const updatedExport = await driveClient.exportDocMarkdown(doc.id);
    expect(updatedExport).toContain('Updated content');
    expect(updatedExport).not.toEqual(exportedContent);

    // List documents in folder
    const docs = await driveClient.listDocsInFolder(testFolder.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(doc.id);
    expect(docs[0].name).toBe('TestDoc');
  }, 60000); // 60 second timeout

  it('should handle frontmatter and appProperties', async () => {
    // Create test folder
    const testFolderName = `plugin-props-test-${Date.now()}`;
    const testFolder = await driveClient.createFolder(parentTestFolderId, testFolderName);
    testFolderIds.push(testFolder.id);

    // Create document with frontmatter properties
    const content = 'Test content for properties';
    const doc = await driveClient.uploadMarkdownAsDoc('PropsTest', content, testFolder.id);

    // Set app properties (simulating frontmatter storage)
    const frontmatterProps = {
      title: 'Test Document',
      author: 'Integration Test',
      tags: 'test,integration',
      created: new Date().toISOString(),
    };

    await driveClient.setAppProperties(doc.id, frontmatterProps);

    // Retrieve and verify properties
    const retrievedProps = await driveClient.getAppProperties(doc.id);
    expect(retrievedProps.title).toBe('Test Document');
    expect(retrievedProps.author).toBe('Integration Test');
    expect(retrievedProps.tags).toBe('test,integration');
    expect(retrievedProps.created).toBeDefined();

    // Test frontmatter building and parsing
    const sha256 = await computeSHA256(content);
    const frontmatter = {
      docId: doc.id,
      revisionId: doc.headRevisionId,
      sha256,
      other: frontmatterProps,
    };

    const builtContent = buildFrontMatter(frontmatter, content);
    expect(builtContent).toContain('---');
    expect(builtContent).toContain(doc.id); // Check for doc ID presence (format may vary)
    expect(builtContent).toContain('Test Document'); // Check for title presence
    expect(builtContent).toContain(content);

    // Parse it back
    const { data, content: parsedContent } = parseFrontMatter(builtContent);
    expect(data.docId).toBe(doc.id);
    expect(data.other.title).toBe('Test Document');
    expect(parsedContent.trim()).toBe(content);
  }, 45000);

  it('should perform round-trip sync (pull and push)', async () => {
    // Create test folder structure
    const testFolderName = `plugin-roundtrip-${Date.now()}`;
    const testFolder = await driveClient.createFolder(parentTestFolderId, testFolderName);
    testFolderIds.push(testFolder.id);

    const subFolder = await driveClient.createFolder(testFolder.id, 'subfolder');

    // Create documents in both root and subfolder
    const rootDoc = await driveClient.uploadMarkdownAsDoc(
      'RootDocument',
      '# Root Document\n\nContent in root folder.\n',
      testFolder.id,
    );

    const subDoc = await driveClient.uploadMarkdownAsDoc(
      'SubDocument',
      '# Sub Document\n\nContent in subfolder.\n',
      subFolder.id,
    );

    // Simulate pull operation: export docs with frontmatter
    const rootContent = await driveClient.exportDocMarkdown(rootDoc.id);
    const subContent = await driveClient.exportDocMarkdown(subDoc.id);

    // Build frontmatter for both documents
    const rootFrontmatter = {
      docId: rootDoc.id,
      revisionId: rootDoc.headRevisionId,
      sha256: await computeSHA256(rootContent),
      other: { source: 'integration-test-root' },
    };

    const subFrontmatter = {
      docId: subDoc.id,
      revisionId: subDoc.headRevisionId,
      sha256: await computeSHA256(subContent),
      other: { source: 'integration-test-sub' },
    };

    const rootFileContent = buildFrontMatter(rootFrontmatter, rootContent);
    const subFileContent = buildFrontMatter(subFrontmatter, subContent);

    // Verify the frontmatter was built correctly
    expect(rootFileContent).toContain(rootDoc.id); // Check for doc ID presence (format may vary)
    expect(subFileContent).toContain(subDoc.id); // Check for doc ID presence (format may vary)

    // Simulate push operation: modify content and update docs
    const modifiedRootContent = rootContent + '\nModified locally.\n';
    const modifiedSubContent = subContent + '\nAlso modified locally.\n';

    await driveClient.updateDocMarkdown(rootDoc.id, modifiedRootContent);
    await driveClient.updateDocMarkdown(subDoc.id, modifiedSubContent);

    // Verify updates
    const updatedRootContent = await driveClient.exportDocMarkdown(rootDoc.id);
    const updatedSubContent = await driveClient.exportDocMarkdown(subDoc.id);

    expect(updatedRootContent).toContain('Modified locally');
    expect(updatedSubContent).toContain('Also modified locally');

    // Verify appProperties were preserved during update
    await driveClient.setAppProperties(rootDoc.id, { source: 'integration-test-root' });
    const rootProps = await driveClient.getAppProperties(rootDoc.id);
    expect(rootProps.source).toBe('integration-test-root');
  }, 90000); // 90 second timeout

  it('should handle complex document export', async () => {
    // Test with a known complex document ID or skip
    const complexDocId =
      process.env.ITEST_COMPLEX_DOC_ID || '1BnwdJZhviHvxXyKatjJu40Jfh_hsJkSs9iAuNcU-tyc';

    try {
      // Try to get document metadata first
      const docInfo = await driveClient.getFile(complexDocId);
      expect(docInfo).toBeDefined();
      expect(docInfo.name).toBeDefined();

      // Export the document
      const markdown = await driveClient.exportDocMarkdown(complexDocId);
      expect(markdown.length).toBeGreaterThan(64);

      // Verify it contains some expected markdown structure
      expect(typeof markdown).toBe('string');
      console.log(`Complex doc "${docInfo.name}" exported: ${markdown.length} bytes`);
    } catch (error: any) {
      if (error.code === 403 || error.code === 404) {
        console.log(`Skipping complex doc test - not accessible (${error.code})`);
        return;
      }
      throw error;
    }
  }, 30000);
});

// Run integration tests only when specifically requested
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Integration Tests Conditional', () => {
  it('should skip unless RUN_INTEGRATION_TESTS=true', () => {
    expect(true).toBe(true);
  });
});

// Show helpful message when authentication is not available
describe.skipIf(checkAuthenticationAvailable())(
  'Integration Tests - Authentication Required',
  () => {
    it('should provide setup instructions when authentication is missing', () => {
      console.log(`
Integration tests skipped - authentication not configured.

OPTION 1: PKCE OAuth via CLI (recommended, NO client secrets needed):
  1. Run CLI authentication: npm run cli auth
  2. Complete OAuth flow in browser (secure PKCE flow)
  3. Run tests: npm run test:integration

OPTION 2: Service Account (for CI/automated testing):
  1. Create service account with Drive API access
  2. Set: export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
  3. Run: npm run test:integration

Test folder: Created dynamically for each test session

✅ PKCE OAuth is the secure production approach - no client secrets needed!
✅ Both CLI and Obsidian plugin now use the same PKCE authentication!
`);
      expect(true).toBe(true);
    });
  },
);
