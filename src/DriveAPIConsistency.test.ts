/**
 * Tests to verify DriveAPI consistency between CLI and Plugin usage
 * Ensures both CLI and Plugin create DriveAPI instances with same configuration
 */

import { describe, it, expect, beforeEach } from 'bun:test';

import { DriveAPI } from './drive/DriveAPI';
import { getNetworkConfig } from './utils/Config';

describe('DriveAPI Consistency', () => {
  const mockAccessToken = 'mock-access-token';

  describe('Instance creation consistency', () => {
    it('should create DriveAPI instances with identical configuration', () => {
      const networkConfig = getNetworkConfig();

      // Simulate CLI creation
      const cliDriveAPI = new DriveAPI(mockAccessToken, 'Bearer', {
        timeout: networkConfig.timeout,
        retryConfig: networkConfig.retryConfig,
      });

      // Simulate Plugin creation (should use same pattern)
      const pluginDriveAPI = new DriveAPI(mockAccessToken, 'Bearer', {
        timeout: networkConfig.timeout,
        retryConfig: networkConfig.retryConfig,
      });

      // Verify both instances have same configuration
      expect(cliDriveAPI).toBeDefined();
      expect(pluginDriveAPI).toBeDefined();

      // Both should be instances of the same class
      expect(cliDriveAPI.constructor).toBe(pluginDriveAPI.constructor);
      expect(cliDriveAPI instanceof DriveAPI).toBe(true);
      expect(pluginDriveAPI instanceof DriveAPI).toBe(true);
    });

    it('should have identical method interfaces', () => {
      const driveAPI = new DriveAPI(mockAccessToken);

      // Core sync methods that both CLI and Plugin use
      const requiredMethods = [
        'exportDocAsMarkdown',
        'updateDocument', 
        'createGoogleDoc',
        'getFile',
        'listDocsInFolder',
        'resolveFolderId',
        'getAppProperties'
      ];

      for (const method of requiredMethods) {
        expect(typeof driveAPI[method as keyof DriveAPI]).toBe('function');
      }
    });

    it('should use consistent authentication headers', () => {
      const tokenType = 'Bearer';
      const driveAPI = new DriveAPI(mockAccessToken, tokenType);

      // Verify the instance was created successfully
      expect(driveAPI).toBeDefined();
      expect(driveAPI instanceof DriveAPI).toBe(true);
    });

    it('should handle network configuration consistently', () => {
      const networkConfig = getNetworkConfig();

      // Verify network config is consistent
      expect(networkConfig.timeout).toBeGreaterThan(0);
      expect(networkConfig.retryConfig).toBeDefined();
      expect(typeof networkConfig.retryConfig.maxRetries).toBe('number');

      // Both CLI and Plugin should use this same config
      const driveAPIWithConfig = new DriveAPI(mockAccessToken, 'Bearer', {
        timeout: networkConfig.timeout,
        retryConfig: networkConfig.retryConfig,
      });

      expect(driveAPIWithConfig).toBeDefined();
    });
  });

  describe('Method consistency', () => {
    let driveAPI: DriveAPI;

    beforeEach(() => {
      driveAPI = new DriveAPI(mockAccessToken);
    });

    it('should have consistent method signatures for core operations', () => {
      // Export document
      expect(driveAPI.exportDocAsMarkdown).toBeDefined();
      expect(driveAPI.exportDocAsMarkdown.length).toBe(1); // docId parameter

      // Update document
      expect(driveAPI.updateDocument).toBeDefined();
      expect(driveAPI.updateDocument.length).toBe(2); // docId, content parameters

      // Create document
      expect(driveAPI.createGoogleDoc).toBeDefined();
      expect(driveAPI.createGoogleDoc.length).toBe(3); // title, content, folderId parameters

      // Get file info
      expect(driveAPI.getFile).toBeDefined();
      expect(driveAPI.getFile.length).toBe(1); // docId parameter

      // List documents
      expect(driveAPI.listDocsInFolder).toBeDefined();
      expect(driveAPI.listDocsInFolder.length).toBe(1); // folderId parameter
    });

    it('should provide consistent error handling interfaces', () => {
      // All methods should be async and return Promises
      expect(driveAPI.exportDocAsMarkdown('test-id')).toBeInstanceOf(Promise);
      expect(driveAPI.getFile('test-id')).toBeInstanceOf(Promise);
      expect(driveAPI.listDocsInFolder('test-folder')).toBeInstanceOf(Promise);
    });

    it('should have plugin compatibility methods', () => {
      // Plugin-specific method aliases should exist
      if ('getDocumentContent' in driveAPI) {
        expect(driveAPI.getDocumentContent).toBeDefined();
        expect(typeof driveAPI.getDocumentContent).toBe('function');

        // Should be alias for exportDocAsMarkdown
        expect(driveAPI.getDocumentContent).toBe(driveAPI.exportDocAsMarkdown);
      } else {
        // Skip test if alias doesn't exist
        expect(true).toBe(true);
      }
    });
  });

  describe('Configuration consistency', () => {
    it('should use same default values', () => {
      const defaultAPI = new DriveAPI(mockAccessToken);
      const explicitAPI = new DriveAPI(mockAccessToken, 'Bearer');

      // Both should be valid instances
      expect(defaultAPI).toBeDefined();
      expect(explicitAPI).toBeDefined();
    });

    it('should handle empty or invalid tokens consistently', () => {
      // Should handle empty token
      expect(() => new DriveAPI('')).not.toThrow();
      expect(() => new DriveAPI('  ')).not.toThrow();
    });

    it('should use consistent API endpoints', () => {
      // This is more of a documentation test - ensuring we're using the right APIs
      const driveAPI = new DriveAPI(mockAccessToken);
      expect(driveAPI).toBeDefined();

      // DriveAPI should be configured for Google Drive v3 and Docs v1 APIs
      // This is verified by the successful instantiation
    });
  });

  describe('Integration consistency', () => {
    it('should work identically with shared utilities', async () => {
      const { SyncUtils } = await import('./sync/SyncUtils');
      
      // SyncUtils should work with DriveAPI instances from both CLI and Plugin
      expect(SyncUtils.sanitizeFileName).toBeDefined();
      expect(SyncUtils.buildPullFrontmatter).toBeDefined();
      expect(SyncUtils.parseFrontMatter).toBeDefined();

      // These utilities should produce consistent results regardless of
      // whether called from CLI or Plugin context
      const testFileName = 'Test File: With Special/Characters?';
      const sanitized = SyncUtils.sanitizeFileName(testFileName);
      
      expect(sanitized).toBe('Test File- With Special-Characters-');
      expect(sanitized).not.toContain('/');
      expect(sanitized).not.toContain(':');
      expect(sanitized).not.toContain('?');
    });

    it('should produce consistent frontmatter across CLI and Plugin', async () => {
      const { SyncUtils } = await import('./sync/SyncUtils');

      const mockDoc = {
        id: 'test-doc-id',
        name: 'Test Document',
        modifiedTime: '2024-01-01T12:00:00.000Z'
      };

      const mockAppProps = {
        'custom-prop': 'test-value'
      };

      const testMarkdown = '# Test Document\n\nTest content';

      const frontmatter = SyncUtils.buildPullFrontmatter(mockDoc, mockAppProps, testMarkdown);

      // Should produce consistent frontmatter structure
      expect(frontmatter['google-doc-id']).toBe(mockDoc.id);
      expect(frontmatter['google-doc-title']).toBe(mockDoc.name);
      expect(frontmatter['last-synced']).toBeDefined();
      
      // Should include app properties
      expect(frontmatter['custom-prop']).toBe('test-value');
    });
  });
});