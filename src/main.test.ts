// Unit tests for standalone utilities
import { describe, it, expect } from 'bun:test';

import { parseFrontMatter, buildFrontMatter, computeSHA256 } from './fs/frontmatter';

describe('Frontmatter Utilities', () => {
  it('should parse basic frontmatter correctly', () => {
    const content = `---
docId: abc123
revisionId: def456
sha256: ghi789
title: Test Document
author: John Doe
---
# Content here
`;

    const { data } = parseFrontMatter(content);
    expect(data.docId).toBe('abc123');
    expect(data.revisionId).toBe('def456');
    expect(data.sha256).toBe('ghi789');
    expect(data.title).toBe('Test Document');
    expect(data.author).toBe('John Doe');
  });

  it('should handle empty frontmatter', () => {
    const content = `# Content here`;

    const { data } = parseFrontMatter(content);
    expect(data).toEqual({});
  });

  it('should build frontmatter correctly', () => {
    const frontMatter = {
      docId: 'abc123',
      revisionId: 'def456',
      sha256: 'ghi789',
      title: 'Test Document',
      author: 'John Doe',
    };
    const body = '# Content here';

    const result = buildFrontMatter(frontMatter, body);
    expect(result).toContain('docId: abc123');
    expect(result).toContain('revisionId: def456');
    expect(result).toContain('sha256: ghi789');
    expect(result).toContain('title: Test Document');
    expect(result).toContain('author: John Doe');
    expect(result).toContain('# Content here');
  });

  it('should handle minimal frontmatter', () => {
    const frontMatter = {
      docId: 'abc123',
      revisionId: 'def456',
    };
    const body = '# Content';

    const result = buildFrontMatter(frontMatter, body);
    expect(result).toContain('docId: abc123');
    expect(result).toContain('revisionId: def456');
    expect(result).not.toContain('sha256:');
  });

  it('should compute SHA256 correctly', async () => {
    const content = 'test content';
    const result = await computeSHA256(content);
    expect(typeof result).toBe('string');
    expect(result.length).toBe(64);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should handle various frontmatter formats', () => {
    const content1 = `---
docId: abc123
---
# Content`;

    const content2 = `---
docId: "abc123"
revisionId: 'def456'
---
# Content`;

    const result1 = parseFrontMatter(content1);
    expect(result1.data.docId).toBe('abc123');

    const result2 = parseFrontMatter(content2);
    expect(result2.data.docId).toBe('abc123');
    expect(result2.data.revisionId).toBe('def456');
  });
});
