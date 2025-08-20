import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { IgnoreParser, createIgnoreParser, shouldIgnoreFile } from './ignore';

describe('IgnoreParser', () => {
  let tempDir: string;
  let parser: IgnoreParser;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = join(tmpdir(), 'gdocs-sync-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temporary directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Basic Pattern Matching', () => {
    it('should ignore files matching simple patterns', () => {
      const ignoreContent = `
# Ignore all .tmp files
*.tmp

# Ignore specific file
secrets.md
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'file.tmp'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'secrets.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'normal.md'))).toBe(false);
    });

    it('should handle directory patterns', () => {
      const ignoreContent = `
# Ignore entire directories
node_modules/
.git/
temp/
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'node_modules/package.json'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, '.git/config'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'temp/file.txt'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/main.ts'))).toBe(false);
    });

    it('should handle wildcard patterns', () => {
      const ignoreContent = `
# Ignore all backup files
*.bak
*.backup

# Ignore test files
*test*
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'file.bak'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'data.backup'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'mytest.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'test.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'main.md'))).toBe(false);
    });
  });

  describe('Advanced Pattern Matching', () => {
    it('should handle double asterisk patterns', () => {
      const ignoreContent = `
# Ignore all log files anywhere
**/*.log

# Ignore all files in any test directory
**/test/**
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'app.log'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/debug.log'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'deep/nested/error.log'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/test/unit.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'test/integration.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/main.md'))).toBe(false);
    });

    it('should handle absolute patterns (starting with /)', () => {
      const ignoreContent = `
# Only ignore in root directory
/build/
/dist/

# But allow nested build directories
# (build/ in subdirectories is not ignored)
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'build/output.js'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'dist/bundle.js'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/build/temp.js'))).toBe(false);
      expect(parser.isIgnored(join(tempDir, 'modules/dist/lib.js'))).toBe(false);
    });

    it('should handle negation patterns with !', () => {
      const ignoreContent = `
# Ignore all log files
*.log

# But keep important.log
!important.log

# Ignore temp directory
temp/

# But keep temp/keep.md
!temp/keep.md
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'debug.log'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'error.log'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'important.log'))).toBe(false);
      expect(parser.isIgnored(join(tempDir, 'temp/file.txt'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'temp/keep.md'))).toBe(false);
    });
  });

  describe('Comments and Empty Lines', () => {
    it('should ignore comments and empty lines', () => {
      const ignoreContent = `
# This is a comment
*.tmp

# Another comment with explanation
# This ignores all markdown files in drafts
drafts/*.md

# Empty lines below are ignored


*.bak
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'file.tmp'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'drafts/draft.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'file.bak'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'normal.md'))).toBe(false);
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle typical obsidian vault ignore patterns', () => {
      const ignoreContent = `
# Obsidian vault files to ignore
.obsidian/
.trash/

# Temporary files
*.tmp
*~

# Draft and template files
drafts/
templates/

# Private notes
private/
*.private.md

# But keep the main template
!templates/main-template.md
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      // Should ignore
      expect(parser.isIgnored(join(tempDir, '.obsidian/workspace.json'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, '.trash/deleted.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'file.tmp'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'backup~'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'drafts/idea.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'templates/note.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'private/secret.md'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'personal.private.md'))).toBe(true);

      // Should not ignore
      expect(parser.isIgnored(join(tempDir, 'notes/meeting.md'))).toBe(false);
      expect(parser.isIgnored(join(tempDir, 'projects/project1.md'))).toBe(false);
      expect(parser.isIgnored(join(tempDir, 'templates/main-template.md'))).toBe(false);
    });

    it('should handle nested directory structures', () => {
      const ignoreContent = `
# Ignore all test directories but allow specific files
**/test/**
!**/test/important.md

# Ignore node_modules anywhere
**/node_modules/

# Ignore hidden files and directories
.*
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);

      expect(parser.isIgnored(join(tempDir, 'src/test/unit.test.js'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'lib/test/integration.test.js'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/test/important.md'))).toBe(false);
      expect(parser.isIgnored(join(tempDir, 'node_modules/package/index.js'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'src/node_modules/lib.js'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, '.hidden-file'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, '.git/config'))).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should work when no ignore file exists', () => {
      parser = new IgnoreParser(tempDir);
      expect(parser.isIgnored(join(tempDir, 'any-file.md'))).toBe(false);
      expect(parser.getPatterns()).toHaveLength(0);
    });

    it('should work with empty ignore file', () => {
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), '');
      parser = new IgnoreParser(tempDir);
      expect(parser.isIgnored(join(tempDir, 'any-file.md'))).toBe(false);
      expect(parser.getPatterns()).toHaveLength(0);
    });

    it('should work with only comments', () => {
      const ignoreContent = `
# This is just a comment
# Another comment
# No actual patterns
`;
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);
      parser = new IgnoreParser(tempDir);
      expect(parser.isIgnored(join(tempDir, 'any-file.md'))).toBe(false);
      expect(parser.getPatterns()).toHaveLength(0);
    });

    it('should handle reload functionality', () => {
      // Start with one pattern
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), '*.tmp');
      parser = new IgnoreParser(tempDir);
      expect(parser.isIgnored(join(tempDir, 'test.tmp'))).toBe(true);
      expect(parser.isIgnored(join(tempDir, 'test.md'))).toBe(false);

      // Update the ignore file
      writeFileSync(join(tempDir, '.gdocs-sync-ignore'), '*.md');
      parser.reload();
      expect(parser.isIgnored(join(tempDir, 'test.tmp'))).toBe(false);
      expect(parser.isIgnored(join(tempDir, 'test.md'))).toBe(true);
    });
  });
});

describe('Helper Functions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), 'gdocs-sync-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('createIgnoreParser should create a working parser', () => {
    const ignoreContent = '*.tmp';
    writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);

    const parser = createIgnoreParser(tempDir);
    expect(parser.isIgnored(join(tempDir, 'test.tmp'))).toBe(true);
    expect(parser.isIgnored(join(tempDir, 'test.md'))).toBe(false);
  });

  it('shouldIgnoreFile should work as a standalone function', () => {
    const ignoreContent = '*.log';
    writeFileSync(join(tempDir, '.gdocs-sync-ignore'), ignoreContent);

    expect(shouldIgnoreFile(join(tempDir, 'debug.log'), tempDir)).toBe(true);
    expect(shouldIgnoreFile(join(tempDir, 'readme.md'), tempDir)).toBe(false);
  });
});
