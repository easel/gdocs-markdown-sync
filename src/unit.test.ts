// Test individual functions without Obsidian dependencies
import { describe, it, expect } from 'bun:test';

import { DriveAPI } from './drive/DriveAPI';

describe('Unit Functions Tests', () => {
  describe('SHA256 Computation', () => {
    it('should compute correct SHA256 hash', async () => {
      const crypto = await import('crypto');
      const content = 'test content';
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toBe('6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72');
    });

    it('should produce different hashes for different content', async () => {
      const crypto = await import('crypto');
      const hash1 = crypto.createHash('sha256').update('content1').digest('hex');
      const hash2 = crypto.createHash('sha256').update('content2').digest('hex');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Frontmatter Parsing with gray-matter', () => {
    it('should parse complex frontmatter correctly', async () => {
      const matter = await import('gray-matter');
      const content = `---
title: "Complex Document"
tags:
  - project
  - important
created: 2025-01-15T10:00:00Z
docId: abc123
---
# Content here`;

      const result = matter.default(content);
      expect(result.data.docId).toBe('abc123');
      expect(result.data.title).toBe('Complex Document');
      expect(Array.isArray(result.data.tags)).toBe(true);
      expect(result.data.tags).toContain('project');
      expect(result.content).toContain('# Content here');
    });

    it('should handle frontmatter with arrays', async () => {
      const matter = await import('gray-matter');
      const content = `---
docId: test123
tags:
  - tag1
  - tag2
aliases: ["alias1", "alias2"]
---
# Content`;

      const result = matter.default(content);
      expect(result.data.docId).toBe('test123');
      expect(Array.isArray(result.data.tags)).toBe(true);
      expect(result.data.tags).toContain('tag1');
      expect(Array.isArray(result.data.aliases)).toBe(true);
    });

    it('should handle content without frontmatter', async () => {
      const matter = await import('gray-matter');
      const content = `# Just content
No frontmatter here`;

      const result = matter.default(content);
      expect(result.data).toEqual({});
      expect(result.content).toBe(content);
    });
  });

  describe('YAML Building with js-yaml', () => {
    it('should build valid YAML', async () => {
      const yaml = await import('js-yaml');
      const data = {
        docId: 'abc123',
        revisionId: 'def456',
        title: 'Test Document',
        tags: ['tag1', 'tag2'],
      };

      const yamlString = yaml.dump(data);
      expect(yamlString).toContain('docId: abc123');
      expect(yamlString).toContain('title: Test Document');
      expect(yamlString).toContain('- tag1');
    });

    it('should handle complex objects', async () => {
      const yaml = await import('js-yaml');
      const data = {
        docId: 'test123',
        nested: {
          property: 'value',
          array: [1, 2, 3],
        },
        date: '2025-01-15T10:00:00Z',
      };

      const yamlString = yaml.dump(data);
      const parsed = yaml.load(yamlString);

      expect(parsed).toEqual(data);
    });
  });

  describe('Authentication Components', () => {
    it('should create TokenLoader without error', async () => {
      const { TokenLoader } = await import('./auth/TokenLoader');
      expect(() => new TokenLoader()).not.toThrow();
    });

    it('should detect token expiry correctly', async () => {
      const { TokenLoader } = await import('./auth/TokenLoader');
      const tokenLoader = new TokenLoader();

      // Token expired 1 hour ago
      const expiredCredentials = {
        access_token: 'test-token',
        expiry_date: Date.now() - 3600000,
      };

      expect(tokenLoader.isTokenExpired(expiredCredentials)).toBe(true);

      // Token expires in 1 hour
      const validCredentials = {
        access_token: 'test-token',
        expiry_date: Date.now() + 3600000,
      };

      expect(tokenLoader.isTokenExpired(validCredentials)).toBe(false);
    });
  });

  describe('DriveAPI', () => {
    it('should create DriveAPI instance with access token', () => {
      const driveAPI = new DriveAPI('test-access-token');
      expect(driveAPI).toBeDefined();
    });

    it('should create DriveAPI instance with custom token type', () => {
      const driveAPI = new DriveAPI('test-access-token', 'Bearer');
      expect(driveAPI).toBeDefined();
    });
  });

  describe('Integration Readiness', () => {
    it('should have all required dependencies available', async () => {
      // Test that all dependencies are properly installed and functional
      const grayMatter = await import('gray-matter');
      const jsYaml = await import('js-yaml');
      const express = await import('express');
      const crypto = await import('crypto');

      expect(grayMatter.default).toBeDefined();
      expect(typeof grayMatter.default).toBe('function');

      expect(jsYaml.load).toBeDefined();
      expect(jsYaml.dump).toBeDefined();

      expect(express.default).toBeDefined();
      expect(typeof express.default).toBe('function');

      expect(crypto.createHash).toBeDefined();
    });

    it('should have modern unified OAuth manager', async () => {
      const { UnifiedOAuthManager } = await import('./auth/UnifiedOAuthManager');
      expect(() => new UnifiedOAuthManager({})).not.toThrow();
    });

    it('should have modern drive API', async () => {
      const { DriveAPI } = await import('./drive/DriveAPI');
      expect(() => new DriveAPI('test-token')).not.toThrow();
    });
  });
});
