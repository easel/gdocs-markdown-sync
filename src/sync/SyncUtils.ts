/**
 * Shared sync utilities for both CLI and plugin
 */

export interface FrontMatter {
  [key: string]: any;
  'google-doc-id'?: string;
  'google-doc-url'?: string;
  'google-doc-title'?: string;
  'last-synced'?: string;
  docId?: string; // Backward compatibility
  revisionId?: string;
  sha256?: string;
}

export class SyncUtils {
  /**
   * Sanitize markdown content for Google Drive upload
   * Google Drive fails with 500 errors when encountering image references to non-existent files
   */
  static sanitizeMarkdownForGoogleDrive(content: string): string {
    // Replace image references with placeholder text to avoid 500 errors
    // Pattern: ![alt text](path/to/image.png)
    const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;

    return content.replace(imagePattern, (_match, altText, imagePath) => {
      // Convert image reference to a text placeholder
      const imageDescription = altText || 'Image';
      return `[📷 ${imageDescription}: ${imagePath}]`;
    });
  }

  /**
   * Parse frontmatter from markdown content
   */
  static parseFrontMatter(content: string): { frontmatter: FrontMatter; markdown: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return { frontmatter: {}, markdown: content };
    }

    const frontmatterText = match[1];
    const markdown = match[2];
    const frontmatter: FrontMatter = {};

    // Simple YAML parsing (basic key: value pairs)
    const lines = frontmatterText.split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim();

        // Remove quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        frontmatter[key] = value;
      }
    }

    return { frontmatter, markdown };
  }

  /**
   * Build markdown content with frontmatter
   */
  static buildMarkdownWithFrontmatter(frontmatter: FrontMatter, content: string): string {
    const yamlLines = [];
    yamlLines.push('---');

    for (const [key, value] of Object.entries(frontmatter)) {
      if (value !== null && value !== undefined) {
        // Simple YAML serialization
        if (typeof value === 'string' && (value.includes(':') || value.includes('\n'))) {
          yamlLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
        } else {
          yamlLines.push(`${key}: ${value}`);
        }
      }
    }

    yamlLines.push('---');
    yamlLines.push('');

    return yamlLines.join('\n') + content;
  }

  /**
   * Sanitize filename for filesystem
   */
  static sanitizeFileName(name: string): string {
    // Replace characters that are invalid in file names
    return name
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Compute SHA256 hash of content
   */
  static async computeSHA256(content: string): Promise<string> {
    // Try Web Crypto API first (available in both browser and modern Node.js)
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    // Fallback to Node.js crypto module
    try {
      const crypto = await import('crypto');
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      console.warn('SHA256 computation not available, using timestamp as fallback');
      return Date.now().toString();
    }
  }

  /**
   * Extract directory path from file path, removing base folder if specified
   */
  static extractRelativePath(filePath: string, baseFolder?: string): string {
    const pathParts = filePath.split('/');
    pathParts.pop(); // Remove filename

    // Remove base folder from path if it exists
    if (baseFolder) {
      const baseParts = baseFolder.split('/');
      for (let i = 0; i < baseParts.length && i < pathParts.length; i++) {
        if (pathParts[i] === baseParts[i]) {
          pathParts.shift();
          i--; // Adjust for shifted array
        }
      }
    }

    return pathParts.join('/');
  }

  /**
   * Build frontmatter for pulled documents
   */
  static buildPullFrontmatter(
    doc: any,
    appProps: Record<string, any>,
    _content: string,
  ): FrontMatter {
    return {
      ...appProps, // User properties first
      'google-doc-id': doc.id,
      'google-doc-url': `https://docs.google.com/document/d/${doc.id}/edit`,
      'google-doc-title': doc.name,
      'last-synced': new Date().toISOString(),
      docId: doc.id, // Backward compatibility
      revisionId: doc.headRevisionId || doc.modifiedTime,
      // SHA256 will be computed by caller since it's async
    };
  }

  /**
   * Update frontmatter for pushed documents
   */
  static buildPushFrontmatter(
    existingFrontmatter: FrontMatter,
    docId: string,
    title: string,
    revisionId?: string,
  ): FrontMatter {
    return {
      ...existingFrontmatter,
      'google-doc-id': docId,
      'google-doc-url': `https://docs.google.com/document/d/${docId}/edit`,
      'google-doc-title': title,
      'last-synced': new Date().toISOString(),
      docId: docId, // Backward compatibility
      revisionId: revisionId,
      // SHA256 will be computed by caller
    };
  }
}
