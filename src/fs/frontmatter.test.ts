import { describe, it, expect } from 'bun:test';

import { parseFrontMatter, buildFrontMatter, computeSHA256 } from './frontmatter';

describe('Frontmatter Utilities', () => {
  it('should parse frontmatter correctly', () => {
    const content = '---\ndocId: "123"\nrevisionId: "456"\ncustom: value\n---\nHello world';
    const { data, content: body } = parseFrontMatter(content);

    expect(data.docId).toBe('123');
    expect(data.revisionId).toBe('456');
    expect(data.custom).toBe('value');
    expect(body).toBe('Hello world');
  });

  it('should handle content with no frontmatter', () => {
    const content = 'Hello world';
    const { data, content: body } = parseFrontMatter(content);

    expect(data).toEqual({});
    expect(body).toBe('Hello world');
  });

  it('should build frontmatter correctly', () => {
    const frontmatter = {
      docId: '123',
      revisionId: '456',
      custom: 'value',
    };
    const body = 'Hello world';

    const result = buildFrontMatter(frontmatter, body);

    expect(result).toContain('---');
    expect(result).toContain('docId:');
    expect(result).toContain('revisionId:');
    expect(result).toContain('custom: value');
    expect(result).toContain('Hello world');
  });

  it('should compute SHA256 hash correctly', async () => {
    const content = 'Hello world';
    const hash = await computeSHA256(content);

    // Just verify it's a valid SHA256 hash (64 hex characters)
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash.length).toBe(64);
  });

  it('should compute consistent SHA256 hashes', async () => {
    const content = 'test content';
    const hash1 = await computeSHA256(content);
    const hash2 = await computeSHA256(content);

    expect(hash1).toBe(hash2);
  });

  it('should handle empty content in SHA256', async () => {
    const hash = await computeSHA256('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash.length).toBe(64);
  });

  it('should handle frontmatter edge cases', () => {
    const contentWithExtraSpaces = '---\n  docId: "123"  \n  revisionId:   "456"\n---\nContent';
    const { data, content: body } = parseFrontMatter(contentWithExtraSpaces);

    expect(data.docId).toBe('123');
    expect(data.revisionId).toBe('456');
    expect(body).toBe('Content');
  });
});
