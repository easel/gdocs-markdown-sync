import matter from 'gray-matter';

export interface FrontMatter {
  docId?: string;
  revisionId?: string;
  sha256?: string;
  [key: string]: any;
}

// Sanitize a string value to be safe for YAML
function sanitizeYamlString(value: string): string {
  // Check if it's a simple alphanumeric string (like document IDs) - these are safe as-is
  const isSimpleAlphanumeric = /^[a-zA-Z0-9_-]+$/.test(value);
  if (isSimpleAlphanumeric) {
    return value;
  }

  // If the string contains problematic characters, use YAML literal block style
  const problematicPatterns = [
    /:\s/, // colon followed by space (key-value separator)
    /^[\s]/, // starts with whitespace
    /[\s]$/, // ends with whitespace
    /\n/, // contains newlines
    /[<>]/, // contains XML/HTML tags
    /["']/, // contains quotes
    /^[!&*\[\]{}|>]/, // starts with YAML special characters
  ];

  const hasProblematicContent = problematicPatterns.some((pattern) => pattern.test(value));

  if (hasProblematicContent) {
    // Use YAML literal block scalar style for complex strings
    return `|\n  ${value.split('\n').join('\n  ')}`;
  }

  return value;
}

// Sanitize frontmatter data to be YAML-safe
function sanitizeFrontMatterData(data: any): any {
  if (typeof data === 'string') {
    return sanitizeYamlString(data);
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeFrontMatterData);
  }

  if (data && typeof data === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = sanitizeFrontMatterData(value);
    }
    return sanitized;
  }

  return data;
}

export function parseFrontMatter(content: string): { data: FrontMatter; content: string } {
  try {
    const { data, content: body } = matter(content);
    return { data, content: body };
  } catch (error: any) {
    // If YAML parsing fails, try to extract and sanitize the frontmatter
    console.warn('YAML parsing failed, attempting recovery:', error.message);

    // Extract the frontmatter block
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      // No frontmatter found, return empty data
      return { data: {}, content: content };
    }

    const [, yamlContent, bodyContent] = frontmatterMatch;

    // Try to parse as simple key-value pairs with better logic
    const data: FrontMatter = {};
    const lines = yamlContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;

      // Look for key: value pattern at the start of the line (no indentation for top-level keys)
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
      if (match) {
        const [, key, value] = match;

        if (value.trim()) {
          // Single line value
          data[key] = value.trim();
        } else {
          // Multi-line value - collect until next key or end
          let multilineValue = '';
          let j = i + 1;

          while (j < lines.length) {
            const nextLine = lines[j];

            // Check if this line starts a new key (not indented and has colon)
            if (nextLine.match(/^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/)) {
              break;
            }

            // Add this line to the multiline value
            if (multilineValue) {
              multilineValue += '\n';
            }
            multilineValue += nextLine;
            j++;
          }

          data[key] = multilineValue.trim();
          i = j - 1; // Skip the lines we've processed
        }
      }
    }

    return { data, content: bodyContent || content };
  }
}

export function buildFrontMatter(data: FrontMatter, content: string): string {
  // Filter out undefined values to prevent YAML serialization errors
  const cleanData = Object.fromEntries(
    Object.entries(data).filter(([_, value]) => value !== undefined),
  );

  // Sanitize the data to be YAML-safe
  const sanitizedData = sanitizeFrontMatterData(cleanData);

  try {
    return matter.stringify(content, sanitizedData);
  } catch (error: any) {
    console.warn('YAML stringify failed, using manual approach:', error.message);

    // Fallback to manual YAML construction
    const yamlLines: string[] = ['---'];

    for (const [key, value] of Object.entries(sanitizedData)) {
      if (typeof value === 'string' && value.includes('\n')) {
        // Use literal block style for multiline strings
        yamlLines.push(`${key}: |`);
        const indentedLines = value.split('\n').map((line) => `  ${line}`);
        yamlLines.push(...indentedLines);
      } else {
        yamlLines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }

    yamlLines.push('---');
    yamlLines.push('');
    yamlLines.push(content);

    return yamlLines.join('\n');
  }
}

export async function computeSHA256(content: string): Promise<string> {
  // Unified crypto implementation using Web Crypto API
  //
  // WHY WEB CRYPTO API FOR BOTH CLI AND PLUGIN:
  // - Bun supports Web Crypto API (crypto.subtle) natively
  // - Obsidian/Electron provides Web Crypto API reliably
  // - Eliminates platform-specific crypto handling
  // - More consistent behavior across environments
  // - Avoids Node.js crypto import issues in Electron

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // Use Web Crypto API for both Bun CLI and Obsidian plugin
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } else if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    // Pure Node.js environment fallback (should be rare, mainly for older test environments)
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  } else {
    throw new Error('No crypto implementation available for SHA256 hashing');
  }
}
