/**
 * Unified Google Drive API client using fetch API
 * Works in both Node.js and browser environments
 * Enhanced with retry logic, timeouts, and better error handling
 */

import { DriveAPIError, ErrorContext, ErrorUtils } from '../utils/ErrorUtils.js';
import { NetworkUtils, RequestConfig } from '../utils/NetworkUtils.js';

export interface DriveDocument {
  id: string;
  name: string;
  modifiedTime?: string;
  relativePath?: string;
}

export interface GoogleDocInfo {
  id: string;
  name: string;
  modifiedTime?: string;
  relativePath: string; // Path relative to the base Drive folder
  parentId: string;
  webViewLink?: string;
}

export type AuthHeaders = Record<string, string>;

export class DriveAPI {
  private authHeaders: AuthHeaders;
  private folderCache = new Map<string, string>();
  private defaultRequestConfig: RequestConfig;

  constructor(
    accessToken: string,
    tokenType: string = 'Bearer',
    requestConfig: Partial<RequestConfig> = {},
  ) {
    this.authHeaders = {
      Authorization: `${tokenType} ${accessToken}`,
    };

    this.defaultRequestConfig = {
      timeout: 30000, // 30 seconds
      retryConfig: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        retryableStatusCodes: [408, 429, 500, 502, 503, 504],
        retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
      },
      ...requestConfig,
    };
  }

  /**
   * Resolve folder name or ID to actual folder ID
   */
  async resolveFolderId(folderNameOrId: string): Promise<string> {
    const context: ErrorContext = {
      operation: 'resolve-folder',
      resourceName: folderNameOrId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const trimmed = folderNameOrId.trim();

      // Check if it looks like a folder ID (Google Drive IDs are typically long alphanumeric strings)
      const folderIdPattern = /^[a-zA-Z0-9_-]{25,}$/;

      if (folderIdPattern.test(trimmed)) {
        // Assume it's already a folder ID
        console.log(`Using provided folder ID: ${trimmed}`);
        return trimmed;
      }

      // Treat as folder name - find or create
      console.log(`Resolving folder name: "${trimmed}"`);

      try {
        // Search for folder by name in root directory
        const url = `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(trimmed)}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
        const response = await NetworkUtils.fetchWithRetry(
          url,
          {
            headers: this.authHeaders,
          },
          this.defaultRequestConfig,
        );

        const data = await response.json();

        if (data.files && data.files.length > 0) {
          // Found existing folder(s) - use the first one
          const folder = data.files[0];
          const folderId = folder.id;
          console.log(
            `Found existing folder "${trimmed}" with ID: ${folderId}${data.files.length > 1 ? ` (${data.files.length} folders with this name, using first one)` : ''}`,
          );
          return folderId;
        }

        // Create new folder in root directory
        console.log(`Creating new folder: "${trimmed}" in root directory`);
        const createResponse = await NetworkUtils.fetchWithRetry(
          'https://www.googleapis.com/drive/v3/files',
          {
            method: 'POST',
            headers: {
              ...this.authHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: trimmed,
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['root'],
            }),
          },
          this.defaultRequestConfig,
        );

        const newFolder = await createResponse.json();
        console.log(`Created new folder "${trimmed}" with ID: ${newFolder.id}`);
        return newFolder.id;
      } catch (error) {
        throw new DriveAPIError(
          `Failed to resolve folder "${trimmed}": ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error && 'statusCode' in error ? (error as any).statusCode : undefined,
          context,
          error instanceof Error ? error : undefined,
        );
      }
    }, context)();
  }

  /**
   * List all documents in folder and subfolders recursively
   */
  async listDocsInFolder(folderId: string): Promise<DriveDocument[]> {
    const context: ErrorContext = {
      operation: 'list-docs',
      resourceId: folderId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const allDocs: DriveDocument[] = [];
      await this.listDocsRecursive(folderId, allDocs, '', context);
      return allDocs;
    }, context)();
  }

  private async listDocsRecursive(
    folderId: string,
    allDocs: DriveDocument[],
    relativePath: string,
    context: ErrorContext = {},
  ) {
    try {
      // List both documents and folders in current folder
      const url = `https://www.googleapis.com/drive/v3/files?q=parents in '${folderId}' and trashed=false&fields=files(id,name,mimeType,modifiedTime)`;
      const response = await NetworkUtils.fetchWithRetry(
        url,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      const data = await response.json();
      const files = data.files || [];

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.document') {
          // It's a document
          allDocs.push({
            ...file,
            relativePath: relativePath,
          });
        } else if (file.mimeType === 'application/vnd.google-apps.folder') {
          // It's a folder - recurse into it
          const subPath = relativePath ? `${relativePath}/${file.name}` : file.name;
          await this.listDocsRecursive(file.id, allDocs, subPath, context);
        }
      }
    } catch (error) {
      throw new DriveAPIError(
        `Failed to list files in folder ${folderId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error && 'statusCode' in error ? (error as any).statusCode : undefined,
        { ...context, resourceId: folderId },
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Create a folder in Google Drive
   */
  async createFolder(
    parentFolderId: string | null,
    folderName: string,
  ): Promise<{ id: string; name: string }> {
    const context: ErrorContext = {
      operation: 'create-folder',
      resourceName: folderName,
      resourceId: parentFolderId || 'root',
    };

    return ErrorUtils.withErrorContext(async () => {
      const createResponse = await NetworkUtils.fetchWithRetry(
        'https://www.googleapis.com/drive/v3/files',
        {
          method: 'POST',
          headers: {
            ...this.authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentFolderId || 'root'],
          }),
        },
        this.defaultRequestConfig,
      );

      const newFolder = await createResponse.json();
      return { id: newFolder.id, name: newFolder.name };
    }, context)();
  }

  /**
   * Upload markdown content as a Google Doc
   */
  async uploadMarkdownAsDoc(
    title: string,
    content: string,
    folderId: string,
  ): Promise<{ id: string; headRevisionId?: string }> {
    const context: ErrorContext = {
      operation: 'upload-doc',
      resourceName: title,
      resourceId: folderId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const docId = await this.createGoogleDoc(title, content, folderId);
      const docInfo = await this.getFile(docId);
      return { id: docId, headRevisionId: docInfo.headRevisionId };
    }, context)();
  }

  /**
   * Export Google Doc as markdown
   */
  async exportDocMarkdown(docId: string): Promise<string> {
    const context: ErrorContext = {
      operation: 'export-doc',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      return this.exportDocAsMarkdown(docId);
    }, context)();
  }

  /**
   * Update Google Doc with markdown content
   */
  async updateDocMarkdown(docId: string, content: string): Promise<void> {
    const context: ErrorContext = {
      operation: 'update-doc',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      return this.updateGoogleDoc(docId, content);
    }, context)();
  }

  /**
   * Delete a file or folder
   */
  async deleteFile(fileId: string): Promise<void> {
    const context: ErrorContext = {
      operation: 'delete-file',
      resourceId: fileId,
    };

    return ErrorUtils.withErrorContext(async () => {
      await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
          method: 'DELETE',
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );
    }, context)();
  }

  /**
   * Export Google Doc as plain text (closest to markdown)
   */
  async exportDocAsMarkdown(docId: string): Promise<string> {
    const context: ErrorContext = {
      operation: 'export-doc-markdown',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const response = await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      const text = await response.text();

      // Basic conversion to markdown-like format
      return text
        .replace(/\n\n+/g, '\n\n') // Normalize paragraph breaks
        .trim();
    }, context)();
  }

  /**
   * Get app properties for a document
   */
  async getAppProperties(docId: string): Promise<Record<string, string>> {
    const context: ErrorContext = {
      operation: 'get-app-properties',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const response = await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${docId}?fields=appProperties`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      const data = await response.json();
      return data.appProperties || {};
    }, context)();
  }

  /**
   * Set app properties for a document
   */
  async setAppProperties(docId: string, properties: Record<string, string>): Promise<void> {
    const context: ErrorContext = {
      operation: 'set-app-properties',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${docId}`,
        {
          method: 'PATCH',
          headers: {
            ...this.authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appProperties: properties,
          }),
        },
        this.defaultRequestConfig,
      );
    }, context)();
  }

  /**
   * Check if document exists
   */
  async documentExists(docId: string): Promise<boolean> {
    try {
      const response = await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${docId}?fields=id`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get document metadata
   */
  async getFile(docId: string): Promise<any> {
    const context: ErrorContext = {
      operation: 'get-file',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const response = await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${docId}?fields=id,name,modifiedTime,headRevisionId`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      return await response.json();
    }, context)();
  }

  /**
   * Create a new Google Doc
   */
  async createGoogleDoc(title: string, content: string, folderId: string): Promise<string> {
    const context: ErrorContext = {
      operation: 'create-google-doc',
      resourceName: title,
      resourceId: folderId,
    };

    return ErrorUtils.withErrorContext(async () => {
      // Create the document
      const createResponse = await NetworkUtils.fetchWithRetry(
        'https://www.googleapis.com/drive/v3/files',
        {
          method: 'POST',
          headers: {
            ...this.authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: title,
            mimeType: 'application/vnd.google-apps.document',
            parents: [folderId],
          }),
        },
        this.defaultRequestConfig,
      );

      const doc = await createResponse.json();

      // Update the document content
      await this.updateGoogleDoc(doc.id, content);

      return doc.id;
    }, context)();
  }

  /**
   * Update Google Doc content
   */
  async updateGoogleDoc(docId: string, content: string): Promise<void> {
    const context: ErrorContext = {
      operation: 'update-google-doc',
      resourceId: docId,
    };

    return ErrorUtils.withErrorContext(async () => {
      // First, get the document to find the content range
      const docResponse = await NetworkUtils.fetchWithRetry(
        `https://docs.googleapis.com/v1/documents/${docId}`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      const docData = await docResponse.json();
      const endIndex = docData.body.content[docData.body.content.length - 1].endIndex - 1;

      // Build requests - only delete if there's content to delete
      const requests: any[] = [];

      if (endIndex > 1) {
        // There's content to delete
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: 1,
              endIndex: endIndex,
            },
          },
        });
      }

      // Always insert new content
      requests.push({
        insertText: {
          location: { index: 1 },
          text: content,
        },
      });

      const updateResponse = await NetworkUtils.fetchWithRetry(
        `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            ...this.authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requests }),
        },
        this.defaultRequestConfig,
      );

      const errorData = await updateResponse.text();
      if (errorData) {
        console.warn('Update response data:', errorData);
      }
    }, context)();
  }

  /**
   * Ensure nested folder structure exists in Google Drive
   */
  async ensureNestedFolders(relativePath: string, baseFolderId: string): Promise<string> {
    const pathParts = relativePath.split('/').filter((part) => part !== '.');

    if (pathParts.length === 0) {
      return baseFolderId; // File is in root directory
    }

    let currentFolderId = baseFolderId;
    let folderPath = '';

    for (const folderName of pathParts) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      const cacheKey = `${currentFolderId}:${folderPath}`;

      // Check cache first
      if (this.folderCache.has(cacheKey)) {
        currentFolderId = this.folderCache.get(cacheKey)!;
        continue;
      }

      // Find or create folder
      currentFolderId = await this.findOrCreateFolder(folderName, currentFolderId);

      // Cache the result
      this.folderCache.set(cacheKey, currentFolderId);
    }

    return currentFolderId;
  }

  /**
   * Find or create a folder in Google Drive
   */
  async findOrCreateFolder(folderName: string, parentFolderId: string): Promise<string> {
    const context: ErrorContext = {
      operation: 'find-or-create-folder',
      resourceName: folderName,
      resourceId: parentFolderId,
    };

    return ErrorUtils.withErrorContext(async () => {
      try {
        // Search for existing folder with this name in the parent folder
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(folderName)}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`;
        const searchResponse = await NetworkUtils.fetchWithRetry(
          searchUrl,
          {
            headers: this.authHeaders,
          },
          this.defaultRequestConfig,
        );

        const searchData = await searchResponse.json();

        if (searchData.files && searchData.files.length > 0) {
          // Found existing folder
          const folderId = searchData.files[0].id;
          console.log(`Found existing Drive folder: ${folderName}`);
          return folderId;
        }

        // Create new folder
        console.log(`Creating Drive folder: ${folderName}`);
        const createResponse = await NetworkUtils.fetchWithRetry(
          'https://www.googleapis.com/drive/v3/files',
          {
            method: 'POST',
            headers: {
              ...this.authHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: folderName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [parentFolderId],
            }),
          },
          this.defaultRequestConfig,
        );

        const newFolder = await createResponse.json();
        return newFolder.id;
      } catch (error) {
        throw new DriveAPIError(
          `Error in findOrCreateFolder for "${folderName}": ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error && 'statusCode' in error ? (error as any).statusCode : undefined,
          context,
          error instanceof Error ? error : undefined,
        );
      }
    }, context)();
  }

  /**
   * PLUGIN COMPATIBILITY ALIASES
   * These methods provide aliases for plugin compatibility
   * Plugin calls these method names but they map to existing functionality
   */

  /**
   * Alias for exportDocAsMarkdown() - called by plugin
   */
  async exportDocument(docId: string): Promise<string> {
    return this.exportDocAsMarkdown(docId);
  }

  /**
   * Alias for updateGoogleDoc() - called by plugin
   */
  async updateDocument(docId: string, content: string): Promise<void> {
    return this.updateGoogleDoc(docId, content);
  }

  /**
   * Alternative alias for exportDocAsMarkdown()
   */
  async exportDocMarkdown(docId: string): Promise<string> {
    return this.exportDocAsMarkdown(docId);
  }

  /**
   * Alternative alias for updateGoogleDoc()
   */
  async updateDocMarkdown(docId: string, content: string): Promise<void> {
    return this.updateGoogleDoc(docId, content);
  }
}
