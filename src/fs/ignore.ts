import { readFileSync, existsSync } from 'fs';
import { join, relative, posix } from 'path';

/**
 * Parser for .gdocs-sync-ignore files with .gitignore-style syntax
 */
export class IgnoreParser {
  private patterns: IgnorePattern[] = [];
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.loadIgnoreFile();
  }

  /**
   * Load and parse the .gdocs-sync-ignore file
   */
  private loadIgnoreFile(): void {
    const ignoreFilePath = join(this.basePath, '.gdocs-sync-ignore');

    if (!existsSync(ignoreFilePath)) {
      return;
    }

    try {
      const content = readFileSync(ignoreFilePath, 'utf-8');
      this.parseIgnoreContent(content);
    } catch (error) {
      console.warn(`Failed to read .gdocs-sync-ignore file: ${error}`);
    }
  }

  /**
   * Parse ignore file content into patterns
   */
  private parseIgnoreContent(content: string): void {
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Handle negation (!)
      const isNegation = trimmed.startsWith('!');
      const pattern = isNegation ? trimmed.slice(1) : trimmed;

      this.patterns.push({
        pattern: this.normalizePattern(pattern),
        isNegation,
        regex: this.patternToRegex(pattern),
      });
    }
  }

  /**
   * Normalize pattern paths to use forward slashes
   */
  private normalizePattern(pattern: string): string {
    return pattern.replace(/\\/g, '/');
  }

  /**
   * Convert gitignore pattern to regex
   */
  private patternToRegex(pattern: string): RegExp {
    // Pre-handle double-star with slash to allow matching zero or more directories
    // e.g. "**/foo" should match "foo" and "a/foo" and "a/b/foo"
    let work = pattern.replace(/\*\*\//g, '§DSLASH§');

    // Escape special regex characters except * and ?
    let escaped = work.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Handle ** (match zero or more directories and files)
    escaped = escaped.replace(/\*\*/g, '§DOUBLESTAR§');

    // Handle * (match anything except /)
    escaped = escaped.replace(/\*/g, '[^/]*');

    // Handle ? (match any single character except /)
    escaped = escaped.replace(/\?/g, '[^/]');

    // Replace placeholders back to proper regex
    escaped = escaped.replace(/§DOUBLESTAR§/g, '.*');
    escaped = escaped.replace(/§DSLASH§/g, '(?:.*/)?');

    // Handle directory-only patterns (ending with /)
    const isDirectoryOnly = pattern.endsWith('/');
    if (isDirectoryOnly) {
      escaped = escaped.slice(0, -1); // Remove trailing /
    }

    // Handle patterns starting with / (absolute from base)
    if (pattern.startsWith('/')) {
      escaped = '^' + escaped.slice(1);
    } else {
      // For patterns not starting with /, they can match:
      // 1. At the beginning of the path
      // 2. After a / in the path
      if (pattern.includes('/') || escaped.includes('\\.*')) {
        // Pattern contains path separators or ** - match at any level
        escaped = '(^|/)' + escaped;
      } else {
        // Simple filename pattern - match just the filename at any level
        escaped = '(^|/)' + escaped;
      }
    }

    // End pattern
    if (isDirectoryOnly) {
      escaped += '(/.*)?$';
    } else {
      escaped += '($|/.*)';
    }

    return new RegExp(escaped);
  }

  /**
   * Check if a file path should be ignored
   */
  public isIgnored(filePath: string): boolean {
    // Normalize the file path relative to base
    const normalizedPath = this.normalizePath(filePath);

    let isIgnored = false;

    // Apply patterns in order
    for (const pattern of this.patterns) {
      if (pattern.regex.test(normalizedPath)) {
        isIgnored = !pattern.isNegation;
      }
    }

    return isIgnored;
  }

  /**
   * Normalize file path for matching
   */
  private normalizePath(filePath: string): string {
    // Get relative path from base
    const relativePath = relative(this.basePath, filePath);

    // Use forward slashes and remove leading ./
    return posix.normalize(relativePath.replace(/\\/g, '/')).replace(/^\.\//, '');
  }

  /**
   * Get all current patterns (for debugging)
   */
  public getPatterns(): IgnorePattern[] {
    return [...this.patterns];
  }

  /**
   * Reload the ignore file (useful if it was modified)
   */
  public reload(): void {
    this.patterns = [];
    this.loadIgnoreFile();
  }
}

interface IgnorePattern {
  pattern: string;
  isNegation: boolean;
  regex: RegExp;
}

/**
 * Helper function to create an ignore parser for a given directory
 */
export function createIgnoreParser(basePath: string): IgnoreParser {
  return new IgnoreParser(basePath);
}

/**
 * Helper function to check if a file should be ignored using a default ignore parser
 */
export function shouldIgnoreFile(filePath: string, basePath: string): boolean {
  const parser = new IgnoreParser(basePath);
  return parser.isIgnored(filePath);
}
