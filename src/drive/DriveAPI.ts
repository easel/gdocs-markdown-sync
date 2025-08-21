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
  private sharedDriveId: string | null = null;
  private driveContextChecked = false;

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
   * Detect if the specified folder is in a shared drive
   * Sets sharedDriveId for use in subsequent queries
   */
  private async detectSharedDriveContext(folderId: string): Promise<void> {
    if (this.driveContextChecked) return;
    
    try {
      const url = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=driveId,parents`;
      const response = await NetworkUtils.fetchWithRetry(
        url,
        { headers: this.authHeaders },
        this.defaultRequestConfig,
      );
      const data = await response.json();
      
      if (data.driveId) {
        this.sharedDriveId = data.driveId;
        console.log(`📁 Folder detected in Shared Drive: ${data.driveId}`);
      } else {
        console.log(`📁 Folder is in My Drive (no shared drive context)`);
      }
      
      this.driveContextChecked = true;
    } catch (error) {
      console.log(`⚠️ Could not detect drive context for folder ${folderId}:`, error);
      this.driveContextChecked = true; // Don't keep retrying
    }
  }

  /**
   * Build query parameters appropriate for the drive context (My Drive vs Shared Drive)
   */
  private getQueryParams(baseParams: Record<string, any> = {}): Record<string, any> {
    const params = {
      ...baseParams,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };

    if (this.sharedDriveId) {
      console.log(`🔍 Using corpora=drive for Shared Drive queries (driveId: ${this.sharedDriveId})`);
      return {
        ...params,
        corpora: 'drive',
        driveId: this.sharedDriveId,
      };
    } else {
      console.log(`🔍 Using default corpora for My Drive queries`);
      return params;
    }
  }

  /**
   * Build a Drive API URL with proper query parameters for current drive context
   */
  private buildDriveApiUrl(baseParams: Record<string, any> = {}): string {
    const queryParams = this.getQueryParams(baseParams);
    const paramString = Object.entries(queryParams)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    return `https://www.googleapis.com/drive/v3/files?${paramString}`;
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
        const query = `name='${encodeURIComponent(trimmed)}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
        const url = this.buildDriveApiUrl({
          q: query,
          fields: 'files(id,name)'
        });
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

  /**
   * Enhanced root detection using multiple query strategies
   */
  private async enhancedRootDetection(folderId: string): Promise<any[]> {
    const additionalFiles: any[] = [];
    const seenIds = new Set<string>();

    try {
      // Strategy 1: Alternative parent query syntax with shared drives
      console.log(`🔍 Strategy 1: Alternative parent query for ${folderId}`);
      const altQuery = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.document'`;
      const altUrl = this.buildDriveApiUrl({
        q: altQuery,
        fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink)'
      });
      
      try {
        const altResponse = await NetworkUtils.fetchWithRetry(altUrl, { headers: this.authHeaders }, this.defaultRequestConfig);
        const altData = await altResponse.json();
        console.log(`📄 Strategy 1 found ${altData.files?.length || 0} documents`);
        
        for (const file of altData.files || []) {
          if (!seenIds.has(file.id)) {
            seenIds.add(file.id);
            additionalFiles.push(file);
            console.log(`   + Found document: "${file.name}" (${file.id})`);
          }
        }
      } catch (error) {
        console.log(`⚠️ Strategy 1 failed:`, error);
      }

      // Strategy 2: Search for accessible Google Docs (broader scope) with shared drives
      console.log(`🔍 Strategy 2: Broad document search with folder filter`);
      const broadQuery = `mimeType='application/vnd.google-apps.document' and trashed=false`;
      const broadUrl = this.buildDriveApiUrl({
        q: broadQuery,
        fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink)'
      });
      
      try {
        const broadResponse = await NetworkUtils.fetchWithRetry(broadUrl, { headers: this.authHeaders }, this.defaultRequestConfig);
        const broadData = await broadResponse.json();
        console.log(`📄 Strategy 2 found ${broadData.files?.length || 0} total accessible documents`);
        
        // Filter for documents in our target folder
        for (const file of broadData.files || []) {
          if (!seenIds.has(file.id) && file.parents?.includes(folderId)) {
            seenIds.add(file.id);
            additionalFiles.push(file);
            console.log(`   + Found document in target folder: "${file.name}" (${file.id})`);
          }
        }
      } catch (error) {
        console.log(`⚠️ Strategy 2 failed:`, error);
      }

      // Strategy 3: Check for shortcuts (sometimes documents appear as shortcuts) with shared drives
      console.log(`🔍 Strategy 3: Search for shortcuts in folder`);
      const shortcutQuery = `'${folderId}' in parents and mimeType='application/vnd.google-apps.shortcut' and trashed=false`;
      const shortcutUrl = this.buildDriveApiUrl({
        q: shortcutQuery,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink,shortcutDetails)',
        pageSize: 1000
      });
      
      try {
        const shortcutResponse = await NetworkUtils.fetchWithRetry(shortcutUrl, { headers: this.authHeaders }, this.defaultRequestConfig);
        const shortcutData = await shortcutResponse.json();
        console.log(`🔗 Strategy 3 found ${shortcutData.files?.length || 0} shortcuts`);
        
        for (const file of shortcutData.files || []) {
          // Check if shortcut points to a Google Doc
          if (file.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.document') {
            const targetId = file.shortcutDetails.targetId;
            if (!seenIds.has(targetId)) {
              seenIds.add(targetId);
              // Create a pseudo-file entry for the target document
              const pseudoFile = {
                id: targetId,
                name: file.name,
                mimeType: 'application/vnd.google-apps.document',
                modifiedTime: file.modifiedTime,
                parents: [folderId],
                webViewLink: file.webViewLink,
                isShortcut: true
              };
              additionalFiles.push(pseudoFile);
              console.log(`   + Found document via shortcut: "${file.name}" -> ${targetId}`);
            }
          }
        }
      } catch (error) {
        console.log(`⚠️ Strategy 3 failed:`, error);
      }

      // Strategy 4: Direct file listing without parent constraints (last resort)
      if (additionalFiles.length === 0) {
        console.log(`🔍 Strategy 4: Direct document search in user's Drive`);
        const directQuery = `mimeType='application/vnd.google-apps.document' and trashed=false`;
        const directUrl = this.buildDriveApiUrl({
          q: directQuery,
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink)',
          pageSize: 1000
        });
        
        try {
          const directResponse = await NetworkUtils.fetchWithRetry(directUrl, { headers: this.authHeaders }, this.defaultRequestConfig);
          const directData = await directResponse.json();
          console.log(`📄 Strategy 4 scanning ${directData.files?.length || 0} documents for orphaned files`);
          
          // Look for documents with no parents or unusual parent relationships
          for (const file of directData.files || []) {
            if (!seenIds.has(file.id)) {
              // Check if document might belong to our target folder
              const hasNoParents = !file.parents || file.parents.length === 0;
              const hasRootParent = file.parents?.includes('root');
              const hasTargetParent = file.parents?.includes(folderId);
              
              if (hasTargetParent || (hasNoParents && folderId === 'root') || (hasRootParent && folderId === 'root')) {
                seenIds.add(file.id);
                additionalFiles.push(file);
                console.log(`   + Found potential orphaned/root document: "${file.name}" (${file.id}) - Parents: ${JSON.stringify(file.parents)}`);
              }
            }
          }
        } catch (error) {
          console.log(`⚠️ Strategy 4 failed:`, error);
        }
      }

      // Strategy 5: AGGRESSIVE - List ALL documents with detailed logging (debug mode)
      console.log(`🔍 Strategy 5: AGGRESSIVE - Complete document audit`);
      try {
        const auditQuery = `mimeType='application/vnd.google-apps.document' and trashed=false`;
        const auditUrl = this.buildDriveApiUrl({
          q: auditQuery,
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink,shared,capabilities)',
          pageSize: 1000
        });
        
        const auditResponse = await NetworkUtils.fetchWithRetry(auditUrl, { headers: this.authHeaders }, this.defaultRequestConfig);
        const auditData = await auditResponse.json();
        console.log(`🔍 AUDIT: Found ${auditData.files?.length || 0} total documents in user's Drive`);
        
        // Log detailed information about ALL documents
        console.log(`🔍 AUDIT: Detailed document analysis for folder ${folderId}:`);
        
        let rootCandidates = 0;
        let exactMatches = 0;
        let orphanedDocs = 0;
        
        for (const file of auditData.files || []) {
          const hasTargetAsParent = file.parents?.includes(folderId);
          const hasRootAsParent = file.parents?.includes('root');
          const hasNoParents = !file.parents || file.parents.length === 0;
          const isShared = file.shared;
          
          // Log every document for debugging
          console.log(`   📄 "${file.name}" (${file.id})`);
          console.log(`      Parents: ${JSON.stringify(file.parents || [])}`);
          console.log(`      Shared: ${isShared || false}`);
          console.log(`      Target match: ${hasTargetAsParent}`);
          console.log(`      Root match: ${hasRootAsParent}`);
          console.log(`      No parents: ${hasNoParents}`);
          
          if (hasTargetAsParent) {
            exactMatches++;
            if (!seenIds.has(file.id)) {
              seenIds.add(file.id);
              additionalFiles.push(file);
              console.log(`   ✅ EXACT MATCH - Adding to sync: "${file.name}"`);
            }
          } else if (hasRootAsParent && folderId !== 'root') {
            rootCandidates++;
            console.log(`   🎯 ROOT CANDIDATE - "${file.name}" has 'root' as parent but target is ${folderId}`);
          } else if (hasNoParents) {
            orphanedDocs++;
            console.log(`   🚫 ORPHANED - "${file.name}" has no parents`);
          }
        }
        
        console.log(`🔍 AUDIT SUMMARY:`);
        console.log(`   📊 Total documents: ${auditData.files?.length || 0}`);
        console.log(`   ✅ Exact matches for folder ${folderId}: ${exactMatches}`);
        console.log(`   🎯 Root candidates: ${rootCandidates}`);
        console.log(`   🚫 Orphaned documents: ${orphanedDocs}`);
        console.log(`   📈 Additional files found for sync: ${additionalFiles.length}`);
        
        // Special handling for 'root' folder detection
        if (folderId !== 'root' && rootCandidates > 0) {
          console.log(`🔍 SPECIAL: Target folder might actually be 'root' instead of ${folderId}`);
          console.log(`🔍 SPECIAL: Consider checking if the folder ID is correct in plugin settings`);
        }
        
      } catch (error) {
        console.log(`⚠️ Strategy 5 failed:`, error);
      }

      // Strategy 6: Direct search for "The Synaptitudes" document
      console.log(`🔍 Strategy 6: Specific search for "The Synaptitudes" document`);
      try {
        const synaptitudesQuery = `name contains 'Synaptitudes' and mimeType='application/vnd.google-apps.document' and trashed=false`;
        const synaptitudesUrl = this.buildDriveApiUrl({
          q: synaptitudesQuery,
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink)',
          pageSize: 100
        });
        
        const synaptitudesResponse = await NetworkUtils.fetchWithRetry(synaptitudesUrl, { headers: this.authHeaders }, this.defaultRequestConfig);
        const synaptitudesData = await synaptitudesResponse.json();
        console.log(`🎯 Strategy 6 found ${synaptitudesData.files?.length || 0} documents matching "Synaptitudes"`);
        
        for (const file of synaptitudesData.files || []) {
          console.log(`   🎯 Found Synaptitudes document: "${file.name}" (${file.id}) - Parents: ${JSON.stringify(file.parents)}`);
          
          // Check if this document belongs to our target folder
          const hasTargetAsParent = file.parents?.includes(folderId);
          const hasRootAsParent = file.parents?.includes('root');
          
          if (hasTargetAsParent || (hasRootAsParent && folderId === 'root')) {
            if (!seenIds.has(file.id)) {
              seenIds.add(file.id);
              additionalFiles.push(file);
              console.log(`   + Adding Synaptitudes document to results: "${file.name}" (${file.id})`);
            }
          } else {
            console.log(`   ⚠️ Synaptitudes document "${file.name}" parent mismatch - Expected: ${folderId}, Got: ${JSON.stringify(file.parents)}`);
          }
        }
      } catch (error) {
        console.log(`⚠️ Strategy 6 failed:`, error);
      }

    } catch (error) {
      console.log(`⚠️ Enhanced root detection failed:`, error);
    }

    return additionalFiles;
  }

  private async listDocsRecursive(
    folderId: string,
    allDocs: DriveDocument[],
    relativePath: string,
    context: ErrorContext = {},
  ) {
    try {
      // Detect shared drive context for proper query parameters
      await this.detectSharedDriveContext(folderId);
      
      console.log(`🔍 Searching folder ${folderId} (path: "${relativePath || '(root)'}")`);
      
      // List both documents and folders in current folder with proper drive context and pagination
      const files = [];
      let pageToken = null;
      let totalPages = 0;
      
      do {
        totalPages++;
        const query = `'${folderId}' in parents and trashed=false`;
        
        // Build URL with proper query parameters for drive context
        const baseParams = {
          q: query,
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,webViewLink,shortcutDetails)',
          pageSize: 1000,
        };
        
        if (pageToken) {
          baseParams.pageToken = pageToken;
        }
        
        const url = this.buildDriveApiUrl(baseParams);
        
        console.log(`🔍 DEBUG - Query URL (page ${totalPages}): ${url}`);
        
        const response = await NetworkUtils.fetchWithRetry(
          url,
          {
            headers: this.authHeaders,
          },
          this.defaultRequestConfig,
        );

        const data = await response.json();
        const pageFiles = data.files || [];
        files.push(...pageFiles);
        pageToken = data.nextPageToken;
        
        console.log(`📄 Page ${totalPages}: Found ${pageFiles.length} items (total so far: ${files.length})`);
        
        if (pageToken) {
          console.log(`🔄 More pages available, fetching next page...`);
        }
      } while (pageToken);
      
      console.log(`📁 Found ${files.length} items total in folder ${folderId} across ${totalPages} pages`);
      
      // Debug: show ALL items found with their types
      if (files.length > 0) {
        console.log(`🔍 DEBUG - All items in folder ${folderId}:`);
        files.forEach(file => {
          console.log(`   • "${file.name}" (${file.id}) - Type: ${file.mimeType}`);
          console.log(`     Parents: ${JSON.stringify(file.parents)}`);
          console.log(`     WebViewLink: ${file.webViewLink || 'N/A'}`);
        });
      }
      
      // If this is the root folder, use enhanced root detection strategies
      if (relativePath === '(root)' || relativePath === '') {
        console.log(`🔍 Applying enhanced root detection for folder ${folderId}`);
        const additionalFiles = await this.enhancedRootDetection(folderId);
        files.push(...additionalFiles);
        console.log(`📈 Enhanced root detection found ${additionalFiles.length} additional files`);
      }

      let docsFound = 0;
      let foldersFound = 0;
      let otherFilesFound = 0;

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.document') {
          // It's a document
          console.log(`📄 Found document: "${file.name}" (${file.id}) at path: "${relativePath || '(root)'}"`);
          allDocs.push({
            ...file,
            relativePath: relativePath,
          });
          docsFound++;
        } else if (file.mimeType === 'application/vnd.google-apps.shortcut' && file.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.document') {
          // It's a shortcut to a Google Doc - resolve it
          console.log(`🔗 Found shortcut to document: "${file.name}" (${file.id}) -> target: ${file.shortcutDetails.targetId}`);
          try {
            // Get the target document details
            const targetDoc = await this.getFile(file.shortcutDetails.targetId);
            console.log(`📄 Resolved shortcut target: "${targetDoc.name}" (${targetDoc.id}) at path: "${relativePath || '(root)'}"`);
            allDocs.push({
              id: targetDoc.id,
              name: file.name, // Use shortcut name
              mimeType: 'application/vnd.google-apps.document',
              modifiedTime: targetDoc.modifiedTime,
              relativePath: relativePath,
              webViewLink: file.webViewLink || targetDoc.webViewLink,
              isShortcut: true,
              shortcutSourceId: file.id
            });
            docsFound++;
          } catch (error) {
            console.log(`⚠️ Failed to resolve shortcut "${file.name}": ${error}`);
            otherFilesFound++;
          }
        } else if (file.mimeType === 'application/vnd.google-apps.folder') {
          // It's a folder - recurse into it
          console.log(`📁 Found subfolder: "${file.name}" (${file.id})`);
          const subPath = relativePath ? `${relativePath}/${file.name}` : file.name;
          await this.listDocsRecursive(file.id, allDocs, subPath, context);
          foldersFound++;
        } else {
          // It's something else
          console.log(`❓ Found other file: "${file.name}" (${file.id}) - Type: ${file.mimeType}`);
          if (file.mimeType === 'application/vnd.google-apps.shortcut') {
            console.log(`   Shortcut target type: ${file.shortcutDetails?.targetMimeType || 'unknown'}`);
          }
          otherFilesFound++;
        }
      }
      
      console.log(`✅ Processed folder ${folderId}: ${docsFound} docs, ${foldersFound} subfolders, ${otherFilesFound} other files`);
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
   * Move a file to trash (soft delete)
   */
  async trashFile(fileId: string): Promise<void> {
    const context: ErrorContext = {
      operation: 'trash-file',
      resourceId: fileId,
    };

    return ErrorUtils.withErrorContext(async () => {
      await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
          method: 'PATCH',
          headers: {
            ...this.authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            trashed: true,
          }),
        },
        this.defaultRequestConfig,
      );
    }, context)();
  }

  /**
   * Move a file from one folder to another
   */
  async moveFile(fileId: string, newParentId: string, currentParentId?: string): Promise<void> {
    const context: ErrorContext = {
      operation: 'move-file',
      resourceId: fileId,
      targetLocation: newParentId,
    };

    return ErrorUtils.withErrorContext(async () => {
      // Get current parents if not provided
      let removeParents = currentParentId;
      if (!removeParents) {
        const fileInfo = await this.getFile(fileId);
        removeParents = fileInfo.parents?.[0]; // Usually files have one parent
      }

      // Build update parameters
      const params = new URLSearchParams();
      params.append('addParents', newParentId);
      if (removeParents) {
        params.append('removeParents', removeParents);
      }

      await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
        {
          method: 'PATCH',
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );
    }, context)();
  }

  /**
   * Get file parents (folders containing the file)
   */
  async getFileParents(fileId: string): Promise<string[]> {
    const context: ErrorContext = {
      operation: 'get-file-parents',
      resourceId: fileId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const response = await NetworkUtils.fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      const data = await response.json();
      return data.parents || [];
    }, context)();
  }

  /**
   * Get file path in Drive (folder hierarchy)
   */
  async getFilePath(fileId: string, stopAtFolderId?: string): Promise<string> {
    const context: ErrorContext = {
      operation: 'get-file-path',
      resourceId: fileId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const pathParts: string[] = [];
      
      // Get file info
      const fileInfo = await this.getFile(fileId);
      pathParts.unshift(fileInfo.name);

      // Traverse up the folder hierarchy
      let currentParents = fileInfo.parents || [];
      
      while (currentParents.length > 0 && currentParents[0] !== 'root') {
        const parentId = currentParents[0];
        
        // Stop if we've reached the specified folder
        if (stopAtFolderId && parentId === stopAtFolderId) {
          break;
        }
        
        const parentInfo = await this.getFile(parentId);
        pathParts.unshift(parentInfo.name);
        currentParents = parentInfo.parents || [];
      }

      return pathParts.join('/');
    }, context)();
  }

  /**
   * Update document properties (metadata)
   */
  async updateDocumentProperties(docId: string, properties: Record<string, string>): Promise<void> {
    const context: ErrorContext = {
      operation: 'update-doc-properties',
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
        `https://www.googleapis.com/drive/v3/files/${docId}?fields=id,name,modifiedTime,headRevisionId,parents&supportsAllDrives=true`,
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
    // Validate baseFolderId
    if (!baseFolderId || baseFolderId.trim() === '') {
      throw new Error('Cannot create nested folders with empty base folder ID. Please configure the Google Drive folder ID in plugin settings.');
    }

    const pathParts = relativePath.split('/').filter(part => part && part.trim() !== '' && part !== '.');

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
        // Validate parentFolderId - if empty, throw an error
        if (!parentFolderId || parentFolderId.trim() === '') {
          throw new Error(`Cannot create folder "${folderName}" with empty parent folder ID. Please configure the Google Drive folder ID in plugin settings.`);
        }

        // Search for existing folder with this name in the parent folder
        const searchQuery = `name='${encodeURIComponent(folderName)}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`;
        const searchUrl = this.buildDriveApiUrl({
          q: searchQuery,
          fields: 'files(id,name)'
        });
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
