// Test standalone utility functions
import { describe, it, expect } from 'bun:test';

import { computeSHA256 } from './fs/frontmatter';

describe('Utility Functions', () => {
  it('should compute correct SHA256 hash', async () => {
    const content = 'test content';
    const hash = await computeSHA256(content);

    // Verify it's a 64-character hex string
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe('6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72');
  });

  it('should produce different hashes for different content', async () => {
    const hash1 = await computeSHA256('content1');
    const hash2 = await computeSHA256('content2');

    expect(hash1).not.toBe(hash2);
  });

  it('should produce same hash for same content', async () => {
    const content = 'same content';
    const hash1 = await computeSHA256(content);
    const hash2 = await computeSHA256(content);

    expect(hash1).toBe(hash2);
  });
});

describe('Integration Readiness', () => {
  it('should have all required dependencies available', async () => {
    // Test that all dependencies are properly installed
    const grayMatter = await import('gray-matter');
    const jsYaml = await import('js-yaml');
    const express = await import('express');
    const crypto = await import('crypto');

    expect(grayMatter.default).toBeDefined();
    expect(jsYaml.load).toBeDefined();
    expect(express.default).toBeDefined();
    expect(crypto.createHash).toBeDefined();
  });

  it('should have functional unified auth manager', async () => {
    const { UnifiedOAuthManager } = await import('./auth/UnifiedOAuthManager');
    expect(() => new UnifiedOAuthManager({})).not.toThrow();
  });

  it('should have functional drive API', async () => {
    const { DriveAPI } = await import('./drive/DriveAPI');
    expect(() => new DriveAPI('test-token')).not.toThrow();
  });
});
