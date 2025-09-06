import { TFile, Notice, MarkdownView } from 'obsidian';

import { DriveAPI } from '../drive/DriveAPI';
import GoogleDocsSyncPlugin from '../plugin-main';
import { ExtendedLocalStorage } from '../storage/LocalStorage';
import { SyncState } from '../types/plugin-types';
import { ErrorUtils } from '../utils/ErrorUtils';
import { getBuildVersion, VERSION_INFO } from '../version';

import { SyncUtils } from './SyncUtils';

const PLUGIN_VERSION = getBuildVersion();

/**
 * Handles sync operations for the Google Docs Sync plugin.
 * This class contains all the major sync-related methods that were extracted
 * from the main plugin class to improve code organization.
 */
export class SyncOperations {
  private storage: ExtendedLocalStorage;

  constructor(private plugin: GoogleDocsSyncPlugin) {
    this.storage = plugin.storage;
  }

  /**
   * Sync all documents in the vault with Google Drive
   */
  async syncAllDocuments() {
    // Check if sync is already in progress
    if (this.plugin.syncInProgress) {
      this.plugin.showSyncInProgressMenu();
      return;
    }

    console.log('🔄 Starting syncAllDocuments()');
    console.log(`📦 Plugin version: ${PLUGIN_VERSION} (${VERSION_INFO.commit || 'unknown'})`);

    // Validate folder configuration before proceeding
    try {
      await this.plugin.resolveDriveFolderId();
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : 'Invalid Google Drive folder configuration',
        8000,
      );
      this.plugin.syncInProgress = false;
      return;
    }
    this.plugin.syncCancelled = false;
    this.plugin.syncInProgress = true;
    this.plugin.currentSyncStatus = {
      isRunning: true,
      progress: { current: 0, total: 0 },
      operation: 'Starting sync...',
      startTime: Date.now(),
    };

    try {
      // Test authentication first
      console.log('🔐 Testing authentication...');
      const driveAPI = await this.plugin.getAuthenticatedDriveAPI();
      console.log('✅ Authentication successful');

      // Build and log comprehensive sync plan
      console.log('📋 Building sync plan for comprehensive analysis...');
      this.plugin.currentSyncStatus.operation = 'Building sync plan...';
      const syncPlan = await this.plugin.buildSyncPlan();
      this.plugin.logSyncPlan(syncPlan);

      // Safety check before proceeding - only block on real conflicts
      if (!syncPlan.operations.safe) {
        const duplicateDocs = syncPlan.operations.warnings.filter(
          (w: any) => w.type === 'duplicate-document',
        ).length;
        const conflicts = syncPlan.operations.conflicts.length;

        console.error('🛑 SYNC ABORTED - Real conflicts detected:');
        if (duplicateDocs > 0)
          console.error(`   - ${duplicateDocs} duplicate document conflict(s) in Google Drive`);
        if (conflicts > 0) console.error(`   - ${conflicts} sync conflict(s) detected`);

        const errorMessage = `Sync aborted due to conflicts: ${duplicateDocs} duplicate document conflicts, ${conflicts} sync conflicts. Please resolve conflicts manually.`;
        new Notice(errorMessage, 15000);

        // Reset sync state and abort
        this.plugin.syncInProgress = false;
        this.plugin.currentSyncStatus = {
          isRunning: false,
          progress: { current: 0, total: 0 },
          operation: 'Sync aborted - conflicts detected',
          startTime: 0,
        };
        this.plugin.statusBarItem.setText('Sync aborted');

        console.log('\n🔧 RECOMMENDED ACTIONS TO FIX:');
        if (duplicateDocs > 0) {
          console.log('1. Resolve duplicate Google Doc IDs or path conflicts');
          console.log('2. Ensure no two documents sync to the same local path');
        }
        if (conflicts > 0) {
          console.log('1. Resolve local vs remote conflicts manually');
          console.log('2. Choose which version to keep for each conflicted file');
        }
        console.log('3. Re-run sync after resolving conflicts');

        return; // Abort the sync operation
      } else {
        console.log('✅ Sync plan safety check passed - proceeding with sync');
      }

      const files = this.plugin.app.vault.getMarkdownFiles();

      let syncCount = 0;
      let createCount = 0;
      let updateCount = 0;
      let moveCount = 0;
      let archiveCount = 0;
      let errorCount = 0;

      console.log(`📁 Found ${files.length} markdown files to process`);

      // Update sync status
      this.plugin.currentSyncStatus.progress.total = files.length;
      this.plugin.currentSyncStatus.operation = 'Enumerating files';

      // Use only status bar for progress
      this.plugin.statusBarItem.setText(`Syncing 0/${files.length}...`);

      for (const file of files) {
        // Check for cancellation
        if (this.plugin.syncCancelled) {
          console.log('🛑 Sync cancelled by user');
          break;
        }

        try {
          // Update status bar with progress (only progress indicator)
          this.plugin.statusBarItem.setText(`Syncing ${syncCount + 1}/${files.length}...`);
          this.plugin.currentSyncStatus.progress.current = syncCount + 1;
          this.plugin.currentSyncStatus.operation = `Syncing ${file.name}`;

          // Check if file has Google Drive metadata
          const metadata = await this.plugin.getGoogleDocsMetadata(file);

          if (!metadata) {
            // File not linked to Google Drive - create new doc
            console.log(`Creating new Google Doc for ${file.path}`);
            await this.performSmartSync(file);
            createCount++;
            syncCount++;
          } else {
            // File linked to Google Drive - check for changes and moves
            const syncState = await this.plugin.changeDetector.detectChanges(file);

            let needsSync = false;
            let syncReason = '';

            // Handle moves first (if enabled)
            if (this.plugin.settings.syncMoves) {
              if (syncState.hasLocalMove && syncState.hasRemoteMove) {
                // Move conflict - need to resolve
                console.log(
                  `Move conflict detected for ${file.path}: local moved from ${syncState.localMoveFrom}, remote moved from ${syncState.remoteMoveFrom}`,
                );
                const resolvedMove = await this.resolveMoveConflict(file, syncState, driveAPI);
                if (resolvedMove) {
                  moveCount++;
                  syncCount++;
                  needsSync = true;
                  syncReason = 'move conflict resolved';
                }
              } else if (syncState.hasLocalMove) {
                // Local file moved - move Google Doc to match
                console.log(`Local move detected: ${syncState.localMoveFrom} → ${file.path}`);
                await this.syncLocalMoveToRemote(file, metadata.id, driveAPI);
                moveCount++;
                syncCount++;
                needsSync = true;
                syncReason = 'local move synced';
              } else if (syncState.hasRemoteMove && syncState.remoteMoveFrom) {
                // Remote file moved - move local file to match (requires careful handling)
                console.log(
                  `Remote move detected: ${syncState.remoteMoveFrom} → current remote location`,
                );
                await this.syncRemoteMoveToLocal(file, syncState.remoteMoveFrom, driveAPI);
                moveCount++;
                syncCount++;
                needsSync = true;
                syncReason = 'remote move synced';
              }
            }

            // Handle delete operations (process before content changes)
            if (syncState.hasRemoteDelete) {
              const deleteResult = await this.handleRemoteDelete(file, syncState, driveAPI);
              if (deleteResult.archived) {
                archiveCount++;
                syncCount++;
                needsSync = true;
                syncReason = deleteResult.reason;
              } else if (deleteResult.restored) {
                updateCount++;
                syncCount++;
                needsSync = true;
                syncReason = 'restored from delete conflict';
              }
            }

            // Handle content changes (only if file wasn't deleted)
            if (
              !syncState.hasRemoteDelete &&
              (syncState.hasLocalChanges || syncState.hasRemoteChanges)
            ) {
              console.log(
                `Content changes for ${file.path} (local: ${syncState.hasLocalChanges}, remote: ${syncState.hasRemoteChanges})`,
              );
              await this.performSmartSync(file);
              updateCount++;
              syncCount++;
              needsSync = true;
              syncReason += syncReason ? ' + content changes' : 'content changes';
            }

            if (!needsSync) {
              console.log(`No changes detected for ${file.path}`);
            } else {
              console.log(`Synced ${file.path}: ${syncReason}`);
            }
          }
        } catch (error) {
          errorCount++;
          console.error(`Failed to sync ${file.path}:`, error);
        }
      }

      // Update status bar with final result
      const totalFiles = files.length;
      const statusMessage = this.plugin.syncCancelled ? 'cancelled' : 'synced';
      this.plugin.statusBarItem.setText(`Google Docs: ${syncCount}/${totalFiles} ${statusMessage}`);

      // Show brief completion notice only
      if (this.plugin.syncCancelled) {
        new Notice(
          `Sync cancelled: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived`,
          2000,
        );
      } else if (errorCount > 0) {
        new Notice(
          `Sync completed: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived, ${errorCount} errors`,
          3000,
        );
      } else {
        new Notice(
          `Sync completed: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived`,
          2000,
        );
      }

      console.log(
        `✅ Sync ${this.plugin.syncCancelled ? 'cancelled' : 'completed'}: ${createCount} created, ${updateCount} updated, ${moveCount} moved, ${archiveCount} archived, ${errorCount} errors`,
      );
    } catch (error) {
      console.error('❌ Sync failed:', error);
      new Notice(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      this.plugin.statusBarItem.setText('Google Docs: sync failed');
    } finally {
      // Reset sync state
      this.plugin.syncInProgress = false;
      this.plugin.syncCancelled = false;
      this.plugin.currentSyncStatus = {
        isRunning: false,
        progress: { current: 0, total: 0 },
        operation: '',
        startTime: 0,
      };
    }
  }

  /**
   * Perform intelligent sync for a single file
   */
  async performSmartSync(file: TFile): Promise<void> {
    // No notice for individual file sync - status bar shows progress

    try {
      // Validate settings before proceeding
      if (!this.plugin.settings.driveFolderId || this.plugin.settings.driveFolderId.trim() === '') {
        throw new Error(
          'Google Drive folder not configured. Please set the Drive folder ID in plugin settings.',
        );
      }

      // Get current file content and metadata
      const content = await this.storage.readFile(file.path);
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);

      // Get authentication
      const authClient = await this.plugin.authManager.getAuthClient();
      const driveAPI = new DriveAPI(authClient.credentials.access_token);

      // Find or create the Google Doc using folder-based strategy
      const googleDocInfo = await this.plugin.findOrCreateGoogleDoc(file, driveAPI, frontmatter);

      if (!googleDocInfo) {
        throw new Error('Failed to find or create Google Doc');
      }

      // Update frontmatter with Google Doc information and enhanced tracking
      let updatedFrontmatter = frontmatter;
      const isNewLink =
        !frontmatter['google-doc-id'] || frontmatter['google-doc-id'] !== googleDocInfo.id;
      const pathChanged =
        frontmatter['last-sync-path'] && frontmatter['last-sync-path'] !== file.path;

      if (isNewLink || pathChanged) {
        const currentRevision = (frontmatter['sync-revision'] || 0) + 1;

        updatedFrontmatter = {
          ...frontmatter,
          'google-doc-id': googleDocInfo.id,
          'google-doc-url': `https://docs.google.com/document/d/${googleDocInfo.id}/edit`,
          'google-doc-title': googleDocInfo.name,
          'last-synced': new Date().toISOString(),
          'last-sync-path': file.path, // Track current path for move detection
          'sync-revision': currentRevision, // Increment sync revision
        };

        if (isNewLink) {
          console.log(`Linked ${file.path} to Google Doc: ${googleDocInfo.id}`);
        } else if (pathChanged) {
          console.log(`File moved: ${frontmatter['last-sync-path']} → ${file.path}`);
        }
      }

      // Get remote content
      const remoteContent = await driveAPI.exportDocument(googleDocInfo.id);
      const remoteRevision = await this.plugin.getDocumentRevision(googleDocInfo.id, driveAPI);

      // Status shown in status bar, no popup notice

      // Get actual file modification time
      const fileStats = await this.plugin.app.vault.adapter.stat(file.path);
      const localModificationTime = fileStats?.mtime || Date.now();

      // Perform intelligent sync with conflict resolution
      const syncResult = await this.plugin.syncService.syncDocument(
        markdown,
        updatedFrontmatter,
        remoteContent,
        remoteRevision,
        new Date().toISOString(), // remote modifiedTime
        { localModificationTime },
      );

      if (!syncResult.result.success) {
        throw new Error(syncResult.result.error || 'Sync failed');
      }

      // Apply changes based on sync result
      let shouldUpdateLocal = false;
      let shouldUpdateRemote = false;
      let finalContent = content;

      switch (syncResult.result.action) {
        case 'pull':
          // Update local file with remote content
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(
            updatedFrontmatter,
            syncResult.updatedContent || remoteContent,
          );
          shouldUpdateLocal = true;
          break;

        case 'push':
          // Update remote doc with local content
          shouldUpdateRemote = true;
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
          shouldUpdateLocal = updatedFrontmatter !== frontmatter; // Update local if frontmatter changed
          break;

        case 'conflict_resolved':
          // Apply merged content to both local and remote
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(
            updatedFrontmatter,
            syncResult.updatedContent || markdown,
          );
          shouldUpdateLocal = true;
          shouldUpdateRemote = true;
          break;

        case 'no_change':
          // Just update frontmatter if needed
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
          shouldUpdateLocal = updatedFrontmatter !== frontmatter;
          break;
      }

      // Check if we need to update frontmatter (for newly linked docs)
      const frontmatterChanged = JSON.stringify(updatedFrontmatter) !== JSON.stringify(frontmatter);

      // Apply local changes
      if (shouldUpdateLocal || frontmatterChanged) {
        if (frontmatterChanged && !shouldUpdateLocal) {
          // Just update frontmatter, keep existing content
          finalContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
        }
        await this.storage.writeFile(file.path, finalContent);
        console.log(`📝 Updated local file: ${file.path}`);
      }

      // Apply remote changes
      if (shouldUpdateRemote) {
        await driveAPI.updateDocument(googleDocInfo.id, syncResult.updatedContent || markdown);
      }

      // Log conflict markers for debugging (removed intrusive popup)
      if (syncResult.result.conflictMarkers && syncResult.result.conflictMarkers.length > 0) {
        console.log('Sync conflicts detected:', syncResult.result.conflictMarkers);
      }

      // Update header action
      const activeLeaf = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeLeaf) {
        this.plugin.updateHeaderAction(activeLeaf.leaf);
      }
    } catch (error) {
      const normalizedError = ErrorUtils.normalize(error as any, {
        operation: 'smart-sync',
        resourceName: file.name,
        filePath: file.path,
      });
      // Only show notice for sync errors
      new Notice(`❌ Sync failed: ${normalizedError.message}`, 5000);
      console.error('Smart sync failed:', normalizedError);
    }
  }

  /**
   * Discover and analyze local markdown files
   */
  async discoverLocalFiles(): Promise<{
    linked: Array<{ file: TFile; docId: string; path: string }>;
    unlinked: Array<{ file: TFile; path: string }>;
    suspicious: Array<{ file: TFile; path: string; issue: string }>;
    total: number;
  }> {
    const files = this.plugin.app.vault.getMarkdownFiles();
    const linked: Array<{ file: TFile; docId: string; path: string }> = [];
    const unlinked: Array<{ file: TFile; path: string }> = [];
    const suspicious: Array<{ file: TFile; path: string; issue: string }> = [];

    for (const file of files) {
      try {
        const content = await this.storage.readFile(file.path);
        const { frontmatter } = SyncUtils.parseFrontMatter(content);
        const docId = frontmatter['google-doc-id'];

        if (docId) {
          linked.push({ file, docId, path: file.path });

          // Check for suspicious patterns
          if (file.path.includes('New Folder')) {
            suspicious.push({ file, path: file.path, issue: 'File in "New Folder" directory' });
          }
        } else {
          unlinked.push({ file, path: file.path });
        }
      } catch (error) {
        suspicious.push({
          file,
          path: file.path,
          issue: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return {
      linked,
      unlinked,
      suspicious,
      total: files.length,
    };
  }

  /**
   * Discover and analyze remote files in Google Drive
   */
  async discoverRemoteFiles(): Promise<{
    docs: Array<{ id: string; name: string; path: string; relativePath: string }>;
    duplicateFolders: Array<{ name: string; count: number; paths: string[] }>;
    duplicateDocs: Array<{ name: string; count: number; ids: string[] }>;
    suspiciousFolders: Array<{ name: string; path: string; id: string }>;
    folderStats: Record<string, number>;
    total: number;
  }> {
    const driveAPI = await this.plugin.getAuthenticatedDriveAPI();
    const resolvedFolderId = await this.plugin.resolveDriveFolderId();
    const allDocs = await driveAPI.listDocsInFolder(resolvedFolderId);

    // Track folder paths for statistics only
    const folderPathCounts = new Map<string, number>();
    const docIdCounts = new Map<string, number>(); // Track if same Google Doc ID appears multiple times
    const fullPathCounts = new Map<string, { id: string; name: string }[]>(); // Track if multiple docs want same local path
    const suspiciousFolders: Array<{ name: string; path: string; id: string }> = [];

    allDocs.forEach((doc: any) => {
      const folderPath = doc.relativePath || '(root)';
      const fullPath = `${folderPath}/${doc.name}`.replace(/^\//, '');

      // Count documents per folder (for stats)
      folderPathCounts.set(folderPath, (folderPathCounts.get(folderPath) || 0) + 1);

      // Track Google Doc ID occurrences (real duplicates)
      docIdCounts.set(doc.id, (docIdCounts.get(doc.id) || 0) + 1);

      // Track full path conflicts (multiple docs trying to sync to same local path)
      if (!fullPathCounts.has(fullPath)) {
        fullPathCounts.set(fullPath, []);
      }
      fullPathCounts.get(fullPath)!.push({ id: doc.id, name: doc.name });

      // Flag suspicious folders (documents in "New Folder" directories)
      if (folderPath.includes('New Folder')) {
        suspiciousFolders.push({
          name: 'New Folder',
          path: folderPath,
          id: doc.id,
        });
      }
    });

    // NO duplicate folder detection - folders with same names in different locations are valid
    const duplicateFolders: Array<{ name: string; count: number; paths: string[] }> = [];

    // Find REAL duplicate issues: same Google Doc ID appearing multiple times
    const duplicateDocs: Array<{ name: string; count: number; ids: string[] }> = [];
    docIdCounts.forEach((count, docId) => {
      if (count > 1) {
        const doc = allDocs.find((d: any) => d.id === docId);
        if (doc) {
          duplicateDocs.push({
            name: doc.name,
            count,
            ids: [docId], // Same ID repeated
          });
        }
      }
    });

    // Find path conflicts: multiple different documents trying to sync to same local path
    fullPathCounts.forEach((docs, path) => {
      if (docs.length > 1) {
        // Multiple docs want the same local path - this is a real conflict
        const uniqueIds = [...new Set(docs.map((d: any) => d.id))];
        if (uniqueIds.length > 1) {
          duplicateDocs.push({
            name: `Path conflict: ${path}`,
            count: docs.length,
            ids: uniqueIds,
          });
        }
      }
    });

    // Generate folder statistics (documents per folder path)
    const folderStats: Record<string, number> = {};
    folderPathCounts.forEach((count, path) => {
      const folderName = path.split('/').pop() || '(root)';
      folderStats[folderName] = (folderStats[folderName] || 0) + count;
    });

    return {
      docs: allDocs.map((doc: any) => ({
        id: doc.id,
        name: doc.name,
        path: `${doc.relativePath || '(root)'}/${doc.name}`,
        relativePath: doc.relativePath || '(root)',
      })),
      duplicateFolders,
      duplicateDocs,
      suspiciousFolders,
      folderStats,
      total: allDocs.length,
    };
  }

  /**
   * Sync local file move to remote (move Google Doc to match new local location)
   */
  public async syncLocalMoveToRemote(
    file: TFile,
    docId: string,
    driveAPI: DriveAPI,
  ): Promise<void> {
    try {
      // Calculate target folder in Google Drive based on new local path
      const targetPath = this.plugin.calculateGoogleDrivePath(file);

      // Ensure target folder exists
      const targetFolderId = await driveAPI.ensureNestedFolders(
        targetPath.folderPath,
        this.plugin.settings.driveFolderId,
      );

      // Move the Google Doc to the new folder
      await driveAPI.moveFile(docId, targetFolderId);

      console.log(`✅ Moved Google Doc ${docId} to match local file location: ${file.path}`);
    } catch (error) {
      console.error(`Failed to sync local move to remote for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Sync remote file move to local (create new local file at new location)
   */
  public async syncRemoteMoveToLocal(
    file: TFile,
    _oldRemotePath: string,
    driveAPI: DriveAPI,
  ): Promise<void> {
    try {
      // Get current remote path
      const docId = (await this.plugin.getGoogleDocsMetadata(file))?.id;
      if (!docId) {
        throw new Error('No Google Doc ID found for file');
      }

      const baseFolderId = await this.plugin.resolveDriveFolderId();
      const currentRemotePath = await driveAPI.getFilePath(docId, baseFolderId);

      // Calculate what the new local path should be
      const newLocalPath = this.calculateLocalPathFromRemote(currentRemotePath);

      // Validate that we actually need to move the file
      if (newLocalPath === file.path) {
        console.log(`✅ File ${file.path} already at correct location, no move needed`);
        return;
      }

      // Check if destination already exists (to avoid collision)
      const destinationExists = await this.storage.exists(newLocalPath);
      if (destinationExists && newLocalPath !== file.path) {
        throw new Error(`Destination file already exists at ${newLocalPath}`);
      }

      // Need to move/rename the local file
      await this.storage.moveFile(file.path, newLocalPath);
      console.log(`✅ Moved local file ${file.path} → ${newLocalPath} to match remote location`);
    } catch (error) {
      console.error(`Failed to sync remote move to local for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Resolve move conflicts (both sides moved)
   */
  public async resolveMoveConflict(
    file: TFile,
    syncState: SyncState,
    driveAPI: DriveAPI,
  ): Promise<boolean> {
    try {
      // Use last-write-wins approach for move conflicts
      // Check which side was modified more recently
      const localMtime = file.stat.mtime;
      const docId = (await this.plugin.getGoogleDocsMetadata(file))?.id;
      if (!docId) {
        throw new Error('No Google Doc ID found for file');
      }

      const fileInfo = await driveAPI.getFile(docId);
      const remoteMtime = new Date(fileInfo.modifiedTime).getTime();

      if (localMtime > remoteMtime) {
        // Local is newer - sync local move to remote
        await this.syncLocalMoveToRemote(file, docId, driveAPI);
        console.log(`✅ Move conflict resolved: Used local location for ${file.path}`);
      } else {
        // Remote is newer - sync remote move to local
        await this.syncRemoteMoveToLocal(file, syncState.remoteMoveFrom!, driveAPI);
        console.log(`✅ Move conflict resolved: Used remote location for ${file.path}`);
      }

      return true;
    } catch (error) {
      console.error(`Failed to resolve move conflict for ${file.path}:`, error);
      return false;
    }
  }

  /**
   * Handle remote file deletion
   */
  public async handleRemoteDelete(
    file: TFile,
    syncState: SyncState,
    driveAPI: DriveAPI,
  ): Promise<{ archived: boolean; restored: boolean; reason: string }> {
    try {
      const metadata = await this.plugin.getGoogleDocsMetadata(file);
      if (!metadata) {
        return { archived: false, restored: false, reason: 'no metadata' };
      }

      // Check if local file has been modified since deletion
      const localMtime = file.stat.mtime;
      const deleteTime = syncState.remoteDeletedAt?.getTime() || Date.now();
      const hasLocalEditsAfterDelete = localMtime > deleteTime;

      // Delete vs Edit conflict resolution: ALWAYS prefer the edit
      if (hasLocalEditsAfterDelete || syncState.hasLocalChanges) {
        console.log(
          `🔄 Delete vs Edit conflict: Local file has edits after remote deletion - restoring Google Doc`,
        );

        if (this.plugin.settings.deleteHandling === 'ignore') {
          console.log(`⏸️ Delete handling set to ignore - skipping restore`);
          return { archived: false, restored: false, reason: 'delete handling ignored' };
        }

        // Restore the Google Doc by recreating it from local content
        await this.recreateDeletedGoogleDoc(file, metadata.id, driveAPI);
        return { archived: false, restored: true, reason: 'restored from delete conflict' };
      }

      // No local edits - proceed with deletion based on settings
      switch (this.plugin.settings.deleteHandling) {
        case 'archive':
          console.log(`📁 Archiving local file due to remote deletion: ${file.path}`);
          await this.archiveLocalFile(
            file,
            `Remote ${syncState.deleteReason === 'remote-trashed' ? 'trashed' : 'deleted'}: ${syncState.remoteDeletedAt?.toISOString()}`,
          );
          return { archived: true, restored: false, reason: 'archived due to remote delete' };

        case 'sync':
          console.log(`🗑️ Deleting local file due to remote deletion: ${file.path}`);
          if (this.plugin.settings.showDeletionWarnings) {
            // In a real implementation, we'd show a confirmation dialog here
            // For now, we'll proceed with deletion
          }
          await this.storage.deleteFile(file.path);
          return { archived: false, restored: false, reason: 'deleted due to remote delete' };

        case 'ignore':
        default:
          console.log(`⏸️ Ignoring remote deletion of: ${file.path}`);
          return { archived: false, restored: false, reason: 'delete handling ignored' };
      }
    } catch (error) {
      console.error(`Failed to handle remote delete for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Recreate a deleted Google Doc from local content
   */
  private async recreateDeletedGoogleDoc(
    file: TFile,
    originalDocId: string,
    driveAPI: DriveAPI,
  ): Promise<void> {
    try {
      // Get current content
      const content = await this.storage.readFile(file.path);
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);

      // Calculate target Google Drive path
      const { folderPath, documentName } = this.plugin.calculateGoogleDrivePath(file);

      // Ensure target folder exists
      const baseFolderId = await this.plugin.resolveDriveFolderId();
      const targetFolderId = await driveAPI.ensureNestedFolders(folderPath, baseFolderId);

      // Create new Google Doc
      const newDocId = await driveAPI.createGoogleDoc(documentName, markdown, targetFolderId);

      // Update frontmatter with new Google Doc information
      const updatedFrontmatter = {
        ...frontmatter,
        'google-doc-id': newDocId,
        'google-doc-url': `https://docs.google.com/document/d/${newDocId}/edit`,
        'google-doc-title': documentName,
        'last-synced': new Date().toISOString(),
        'last-sync-path': file.path,
        'sync-revision': (frontmatter['sync-revision'] || 0) + 1,
        'restored-from-delete': new Date().toISOString(),
        'original-doc-id': originalDocId, // Track the original for reference
      };

      // Update local file with new metadata
      const updatedContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
      await this.storage.writeFile(file.path, updatedContent);

      console.log(`✅ Recreated Google Doc: ${file.path} → ${newDocId} (was ${originalDocId})`);
    } catch (error) {
      console.error(`Failed to recreate deleted Google Doc for ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Calculate local path from Google Drive path
   */
  private calculateLocalPathFromRemote(remotePath: string): string {
    // Add base vault folder if configured
    let localPath = remotePath;

    if (this.plugin.settings.baseVaultFolder) {
      localPath = `${this.plugin.settings.baseVaultFolder}/${remotePath}`;
    }

    // Convert spaces back to underscores if needed
    localPath = localPath.replace(/ /g, '_');

    // Ensure .md extension
    if (!localPath.endsWith('.md')) {
      localPath += '.md';
    }

    return localPath;
  }

  /**
   * Get or create local trash folder for archived files
   */
  private async getLocalTrashFolder(): Promise<string> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const trashPath = `.trash/${today}`;

    try {
      // Ensure trash folder exists
      await this.storage.createDirectory(trashPath);
      return trashPath;
    } catch (error) {
      console.error('Failed to create local trash folder:', error);
      throw error;
    }
  }

  /**
   * Archive local file to trash (soft delete)
   */
  private async archiveLocalFile(file: TFile, reason: string): Promise<string> {
    try {
      const trashFolder = await this.getLocalTrashFolder();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivedFileName = `${file.basename}_${timestamp}.md`;
      const archivedPath = `${trashFolder}/${archivedFileName}`;

      // Read content before moving
      const content = await this.storage.readFile(file.path);

      // Add deletion metadata to frontmatter
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(content);
      const updatedFrontmatter = {
        ...frontmatter,
        'deletion-scheduled': new Date().toISOString(),
        'deletion-reason': reason,
        'original-path': file.path,
        'archived-from': 'local-delete',
      };

      // Create archived file with updated metadata
      const archivedContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
      await this.storage.writeFile(archivedPath, archivedContent);

      // Remove original file
      await this.storage.deleteFile(file.path);

      console.log(`📁 Archived local file: ${file.path} → ${archivedPath}`);
      return archivedPath;
    } catch (error) {
      console.error(`Failed to archive local file ${file.path}:`, error);
      throw error;
    }
  }

  /**
   * Pull all documents from Google Drive to local markdown files
   */
  async pullAllDocs() {
    console.log('🔄 pullAllDocs() called');
    console.log('📋 Current settings:', {
      driveFolderId: this.plugin.settings.driveFolderId,
      baseVaultFolder: this.plugin.settings.baseVaultFolder,
      profile: this.plugin.settings.profile,
    });

    const notice = new Notice('Validating Google Drive folder...', 0);

    try {
      // Resolve and validate the folder ID
      const resolvedFolderId = await this.plugin.resolveDriveFolderId();
      console.log('✅ pullAllDocs() validation passed, resolved folderId:', resolvedFolderId);

      notice.setMessage('Building comprehensive sync plan...');

      // Get authenticated Drive API
      const driveAPI = await this.plugin.getAuthenticatedDriveAPI();

      // Build and log comprehensive sync plan before pulling
      console.log('📋 Building sync plan for pull operation analysis...');
      const syncPlan = await this.plugin.buildSyncPlan();
      this.plugin.logSyncPlan(syncPlan);

      // Show specific analysis for pull operation
      const pullOperations = syncPlan.operations.pullFromRemote;
      console.log(
        `\n📥 PULL ANALYSIS: ${pullOperations.length} documents can be pulled from remote`,
      );
      pullOperations.forEach((op) => {
        console.log(`   • ${op.action.toUpperCase()}: ${op.remoteDoc.name} → ${op.targetPath}`);
        console.log(`     Reason: ${op.reason}`);
      });

      // Safety checks for pull operation
      const existingFileWarnings = syncPlan.operations.warnings.filter(
        (w) => w.type === 'existing-file',
      );
      const duplicateDocWarnings = syncPlan.operations.warnings.filter(
        (w) => w.type === 'duplicate-document',
      );

      if (existingFileWarnings.length > 0) {
        console.log(
          `\n⚠️  PULL CONFLICTS: ${existingFileWarnings.length} remote documents would conflict with existing local files:`,
        );
        existingFileWarnings.forEach((warning) => {
          console.log(
            `   • Remote "${warning.details.remoteName}" → Local "${warning.details.localPath}"`,
          );
        });
      }

      // Check for real conflicts that should abort pull
      if (duplicateDocWarnings.length > 0) {
        console.error('🛑 PULL ABORTED - Document conflicts detected:');
        duplicateDocWarnings.forEach((warning) => {
          console.error(
            `   - Document conflict: "${warning.details.name}" appears ${warning.details.count} times`,
          );
          console.error(`     • IDs: ${warning.details.ids.join(', ')}`);
        });

        const errorMessage = `Pull aborted: ${duplicateDocWarnings.length} document conflicts detected. Resolve conflicts first.`;
        notice.setMessage('❌ ' + errorMessage);
        setTimeout(() => notice.hide(), 15000);
        new Notice(errorMessage, 15000);

        console.log('\n🔧 RECOMMENDED ACTIONS:');
        console.log('1. Resolve duplicate Google Doc IDs or path conflicts');
        console.log('2. Ensure no two documents would sync to the same local path');
        console.log('3. Re-run "Pull All Documents" after resolving conflicts');

        return; // Abort the pull operation
      } else if (existingFileWarnings.length > 0) {
        console.warn(
          `⚠️ ${existingFileWarnings.length} potential file conflicts detected, but proceeding with pull...`,
        );
        const warningMessage = `${existingFileWarnings.length} remote documents may conflict with existing local files. Check console for details.`;
        new Notice(warningMessage, 8000);
      } else {
        console.log('✅ Pull safety check passed - proceeding with pull operation');
      }

      notice.setMessage('Discovering documents on Google Drive...');

      // Get all documents from Google Drive using resolved folder ID
      console.log('📡 Calling driveAPI.listDocsInFolder with resolved folderId:', resolvedFolderId);
      const remoteDocs = await driveAPI.listDocsInFolder(resolvedFolderId);
      console.log('📊 listDocsInFolder returned:', remoteDocs.length, 'documents');

      // Log the first few documents for debugging
      if (remoteDocs.length > 0) {
        console.log('📋 First few discovered documents:');
        remoteDocs.slice(0, 3).forEach((doc, i) => {
          console.log(
            `  ${i + 1}. "${doc.name}" (${doc.id}) at path: "${doc.relativePath || '(root)'}"`,
          );
        });
        if (remoteDocs.length > 3) {
          console.log(`  ... and ${remoteDocs.length - 3} more documents`);
        }
      } else {
        console.log('⚠️ No documents found in Google Drive folder');
      }

      notice.setMessage(`Found ${remoteDocs.length} document(s) on Google Drive. Pulling...`);

      let successCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      for (const doc of remoteDocs) {
        try {
          console.log(
            `Processing Google Doc: "${doc.name}" (${doc.id}) at path: "${doc.relativePath || '(root)'}"`,
          );

          // Find corresponding local file by Google Doc ID
          const localFiles = this.plugin.app.vault.getMarkdownFiles();
          let localFile: TFile | null = null;

          for (const file of localFiles) {
            const content = await this.storage.readFile(file.path);
            const { frontmatter } = SyncUtils.parseFrontMatter(content);
            if (frontmatter['google-doc-id'] === doc.id) {
              localFile = file;
              break;
            }
          }

          if (localFile) {
            // Update existing local file
            console.log(`Updating existing local file: ${localFile.path}`);
            await this.plugin.pullSingleFile(localFile);
            updatedCount++;
          } else {
            // Create new local file for this Google Doc
            console.log(
              `Creating new local file for Google Doc: "${doc.name}" with relativePath: "${doc.relativePath || '(empty)'}"`,
            );
            await this.createLocalFileFromGoogleDoc(doc, driveAPI);
            createdCount++;
          }

          successCount++;
        } catch (error) {
          errorCount++;
          console.error(`Failed to pull ${doc.name} (${doc.id}):`, error);
        }
      }

      notice.setMessage(
        `Pull completed: ${successCount} success (${createdCount} created, ${updatedCount} updated), ${errorCount} errors`,
      );
      setTimeout(() => notice.hide(), 5000);
    } catch (error) {
      console.error('Failed to pull all docs:', error);

      // Clear any cached data on errors
      this.plugin.clearDriveAPICache();

      // Provide user-friendly error messages
      let errorMessage = 'Pull failed: ';
      if (error instanceof Error) {
        if (error.message.includes('Cannot access Google Drive folder')) {
          errorMessage += 'Invalid Google Drive folder. Please check your folder ID in settings.';
        } else if (error.message.includes('Authentication')) {
          errorMessage += 'Authentication failed. Please re-authenticate in settings.';
        } else {
          errorMessage += error.message;
        }
      } else {
        errorMessage += String(error);
      }

      notice.setMessage(errorMessage);
      setTimeout(() => notice.hide(), 8000);
    }
  }

  /**
   * Create a new local file from a Google Doc
   */
  async createLocalFileFromGoogleDoc(doc: any, driveAPI: any): Promise<void> {
    try {
      console.log(`🆕 createLocalFileFromGoogleDoc for "${doc.name}" (${doc.id})`);
      console.log(`  - doc.relativePath: "${doc.relativePath || '(empty)'}"`);
      console.log(
        `  - settings.baseVaultFolder: "${this.plugin.settings.baseVaultFolder || '(not set)'}"`,
      );

      // Download the Google Doc content
      const remoteContent = await driveAPI.exportDocMarkdown(doc.id);
      console.log(`  - Downloaded content length: ${remoteContent.length} chars`);

      // Create frontmatter for the new file
      const frontmatter = {
        'google-doc-id': doc.id,
        'google-doc-url': `https://docs.google.com/document/d/${doc.id}/edit`,
        'google-doc-title': doc.name,
        'last-synced': new Date().toISOString(),
        'sync-revision': 1,
      };

      // Build the complete markdown content with frontmatter
      const completeContent = SyncUtils.buildMarkdownWithFrontmatter(frontmatter, remoteContent);

      // Generate a suitable filename (sanitize the doc name)
      const sanitizedName = SyncUtils.sanitizeFileName(doc.name);
      const fileName = `${sanitizedName}.md`;

      console.log(`  - Sanitized filename: "${fileName}"`);
      console.log(`  - Starting path calculation...`);

      // Determine the target path including Google Drive folder structure
      let targetPath = fileName;
      console.log(`  - Initial targetPath: "${targetPath}"`);

      // Start with base vault folder if configured
      if (
        this.plugin.settings.baseVaultFolder &&
        this.plugin.settings.baseVaultFolder.trim() !== ''
      ) {
        targetPath = `${this.plugin.settings.baseVaultFolder.trim()}/${fileName}`;
        console.log(`  - Applied base vault folder: "${targetPath}"`);
      }

      // Add the relative path from Google Drive folder structure
      if (doc.relativePath && doc.relativePath.trim() !== '') {
        // If we have a base folder, combine them, otherwise use just the relative path
        if (
          this.plugin.settings.baseVaultFolder &&
          this.plugin.settings.baseVaultFolder.trim() !== ''
        ) {
          targetPath = `${this.plugin.settings.baseVaultFolder.trim()}/${doc.relativePath}/${fileName}`;
          console.log(`  - Combined base + relative: "${targetPath}"`);
        } else {
          targetPath = `${doc.relativePath}/${fileName}`;
          console.log(`  - Applied relative path only: "${targetPath}"`);
        }
      } else {
        console.log(`  - No relative path (root file), final path: "${targetPath}"`);
      }

      console.log(`  - Final target path: "${targetPath}"`);

      // Ensure target directory exists
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      if (targetDir && targetDir !== targetPath) {
        console.log(`Creating directory: ${targetDir}`);
        // Create nested folders if they don't exist
        await this.storage.createDirectory(targetDir);
      }

      // Create the file in the vault using storage
      await this.storage.writeFile(targetPath, completeContent);
      console.log(`✓ Created local file ${targetPath} from Google Doc "${doc.name}" (${doc.id})`);
    } catch (error) {
      console.error(
        `Failed to create local file from Google Doc "${doc.name}" (${doc.id}):`,
        error,
      );
      throw error;
    }
  }

  /**
   * Build a comprehensive sync plan by matching local and remote files
   */
  async buildSyncPlan(): Promise<{
    localState: {
      linked: Array<{ file: TFile; docId: string; path: string }>;
      unlinked: Array<{ file: TFile; path: string }>;
      suspicious: Array<{ file: TFile; path: string; issue: string }>;
      total: number;
    };
    remoteState: {
      docs: Array<{ id: string; name: string; path: string; relativePath: string }>;
      duplicateFolders: Array<{ name: string; count: number; paths: string[] }>;
      duplicateDocs: Array<{ name: string; count: number; ids: string[] }>;
      suspiciousFolders: Array<{ name: string; path: string; id: string }>;
      folderStats: Record<string, number>;
      total: number;
    };
    operations: {
      pushToRemote: Array<{ localFile: TFile; action: 'create' | 'update'; reason: string }>;
      pullFromRemote: Array<{
        remoteDoc: { id: string; name: string; path: string };
        action: 'create' | 'update';
        reason: string;
        targetPath?: string;
      }>;
      conflicts: Array<{
        localFile: TFile;
        remoteDoc: { id: string; name: string };
        reason: string;
      }>;
      warnings: Array<{
        type: 'duplicate-folder' | 'duplicate-document' | 'suspicious-pattern' | 'existing-file';
        message: string;
        details: any;
      }>;
      safe: boolean;
    };
  }> {
    console.log('🔍 Building comprehensive sync plan...');

    // Discover current state
    const localState = await this.discoverLocalFiles();
    const remoteState = await this.discoverRemoteFiles();

    // Initialize operation collections
    const pushToRemote: Array<{ localFile: TFile; action: 'create' | 'update'; reason: string }> =
      [];
    const pullFromRemote: Array<{
      remoteDoc: { id: string; name: string; path: string };
      action: 'create' | 'update';
      reason: string;
      targetPath?: string;
    }> = [];
    const conflicts: Array<{
      localFile: TFile;
      remoteDoc: { id: string; name: string };
      reason: string;
    }> = [];
    const warnings: Array<{
      type: 'duplicate-folder' | 'duplicate-document' | 'suspicious-pattern' | 'existing-file';
      message: string;
      details: any;
    }> = [];

    // Create lookup maps for efficient matching
    const localByDocId = new Map<string, { file: TFile; docId: string; path: string }>();
    const remoteById = new Map<
      string,
      { id: string; name: string; path: string; relativePath: string }
    >();
    const localByPath = new Map<string, TFile>();

    localState.linked.forEach((local) => {
      localByDocId.set(local.docId, local);
      localByPath.set(local.path, local.file);
    });

    localState.unlinked.forEach((local) => {
      localByPath.set(local.path, local.file);
    });

    remoteState.docs.forEach((remote) => {
      remoteById.set(remote.id, remote);
    });

    // Analyze warnings for REAL issues only
    if (remoteState.duplicateDocs.length > 0) {
      remoteState.duplicateDocs.forEach((duplicate) => {
        warnings.push({
          type: 'duplicate-document',
          message: `Found ${duplicate.count} documents with conflict: "${duplicate.name}"`,
          details: { name: duplicate.name, count: duplicate.count, ids: duplicate.ids },
        });
      });
    }

    if (remoteState.suspiciousFolders.length > 0) {
      warnings.push({
        type: 'suspicious-pattern',
        message: `Found ${remoteState.suspiciousFolders.length} suspicious "New Folder" entries`,
        details: remoteState.suspiciousFolders,
      });
    }

    if (localState.suspicious.length > 0) {
      localState.suspicious.forEach((suspicious) => {
        warnings.push({
          type: 'suspicious-pattern',
          message: `Local file issue: ${suspicious.issue}`,
          details: { path: suspicious.path, issue: suspicious.issue },
        });
      });
    }

    // Process linked local files (files with google-doc-id)
    for (const localLinked of localState.linked) {
      const remoteDoc = remoteById.get(localLinked.docId);

      // Validate that the document belongs to the current workspace
      const driveAPI = await this.plugin.getAuthenticatedDriveAPI();
      const isValidWorkspace = await driveAPI.validateDocumentInCurrentWorkspace(localLinked.docId);

      if (!isValidWorkspace) {
        const handleCrossWorkspace = this.plugin.settings.handleCrossWorkspaceDocs || 'auto-relink';
        console.log(
          `🚫 Document ${localLinked.docId} not accessible in current workspace, handling with policy: ${handleCrossWorkspace}`,
        );

        if (handleCrossWorkspace === 'skip') {
          console.log(`⏭️ Skipping ${localLinked.path} (cross-workspace document, skip policy)`);
          continue;
        } else if (handleCrossWorkspace === 'warn') {
          console.log(
            `⚠️ Warning: ${localLinked.path} has cross-workspace document, skipping sync`,
          );
          warnings.push({
            type: 'suspicious-pattern',
            message: `Document ${localLinked.docId} belongs to different workspace: ${localLinked.path}`,
            details: {
              path: localLinked.path,
              oldDocId: localLinked.docId,
              reason: 'cross-workspace-document-warning',
            },
          });
          continue;
        } else if (handleCrossWorkspace === 'auto-relink') {
          console.log(`🔗 Attempting to auto-relink ${localLinked.path} by name...`);

          // Try to find a document with the same name in the current workspace
          const expectedFileName = localLinked.file.name.replace(/\.md$/, '');
          const expectedPath = localLinked.path.replace(/\.md$/, '');

          const nameMatchedDoc = remoteState.docs.find((doc) => {
            const docPath =
              doc.relativePath === '(root)' ? doc.name : `${doc.relativePath}/${doc.name}`;
            return doc.name === expectedFileName || docPath === expectedPath;
          });

          if (nameMatchedDoc) {
            console.log(
              `🔗 Auto-relinking ${localLinked.path}: wrong workspace ID ${localLinked.docId} → correct ID ${nameMatchedDoc.id}`,
            );

            // Re-link to the document in the current workspace
            pushToRemote.push({
              localFile: localLinked.file,
              action: 'update',
              reason: `Auto-relinking to document in current workspace (ID changed from ${localLinked.docId} to ${nameMatchedDoc.id})`,
            });

            // Update lookup maps
            localByDocId.delete(localLinked.docId);
            localByDocId.set(nameMatchedDoc.id, { ...localLinked, docId: nameMatchedDoc.id });

            warnings.push({
              type: 'suspicious-pattern',
              message: `Auto-relinked cross-workspace document: ${localLinked.path}`,
              details: {
                path: localLinked.path,
                oldDocId: localLinked.docId,
                newDocId: nameMatchedDoc.id,
                reason: 'cross-workspace-auto-relink',
              },
            });

            // Continue processing with the new valid document
            continue;
          } else {
            console.log(
              `⚠️ No matching document found for ${localLinked.path} in current workspace, treating as new document`,
            );

            // Treat as new document to be created
            pushToRemote.push({
              localFile: localLinked.file,
              action: 'create',
              reason: `Document ID ${localLinked.docId} belongs to different workspace, no matching document found - creating new document`,
            });

            warnings.push({
              type: 'suspicious-pattern',
              message: `Cross-workspace document ${localLinked.docId} cleared from ${localLinked.path}, will create new document`,
              details: {
                path: localLinked.path,
                oldDocId: localLinked.docId,
                reason: 'cross-workspace-document-cleared',
              },
            });

            continue;
          }
        }
      }

      if (remoteDoc) {
        // Both local and remote exist - check for updates needed
        try {
          const hasRemoteChanges = await this.plugin.hasRemoteChanges(
            localLinked.docId,
            localLinked.file.stat.mtime.toString(),
          );
          const hasLocalChanges = await this.hasLocalChanges(localLinked.file);

          if (hasLocalChanges && hasRemoteChanges) {
            conflicts.push({
              localFile: localLinked.file,
              remoteDoc: { id: remoteDoc.id, name: remoteDoc.name },
              reason: 'Both local and remote files have been modified',
            });
          } else if (hasLocalChanges) {
            pushToRemote.push({
              localFile: localLinked.file,
              action: 'update',
              reason: 'Local file has been modified',
            });
          } else if (hasRemoteChanges) {
            pullFromRemote.push({
              remoteDoc,
              action: 'update',
              reason: 'Remote document has been modified',
              targetPath: localLinked.path,
            });
          }
        } catch (error) {
          warnings.push({
            type: 'suspicious-pattern',
            message: `Failed to check sync status for ${localLinked.path}`,
            details: {
              path: localLinked.path,
              docId: localLinked.docId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else {
        // Local file exists but remote is missing - check for path-based match
        const expectedPath = localLinked.path.replace(/\.md$/, '');
        const pathMatchedDoc = remoteState.docs.find((doc) => {
          const docPath =
            doc.relativePath === '(root)' ? doc.name : `${doc.relativePath}/${doc.name}`;
          return docPath === expectedPath;
        });

        if (pathMatchedDoc) {
          // Found a document at the same path but with different ID - re-link it
          console.log(
            `🔗 Re-linking ${localLinked.path}: old ID ${localLinked.docId} → new ID ${pathMatchedDoc.id}`,
          );

          // Update the local file with the correct Google Doc ID
          pushToRemote.push({
            localFile: localLinked.file,
            action: 'update',
            reason: `Re-linking to existing document at same path (ID changed from ${localLinked.docId} to ${pathMatchedDoc.id})`,
          });

          // Add this to our lookup so it's not processed again
          localByDocId.delete(localLinked.docId); // Remove old mapping
          localByDocId.set(pathMatchedDoc.id, { ...localLinked, docId: pathMatchedDoc.id }); // Add new mapping
          remoteById.set(pathMatchedDoc.id, pathMatchedDoc); // Ensure it's in remote lookup
        } else {
          // No document found at expected path - create new one
          pushToRemote.push({
            localFile: localLinked.file,
            action: 'create',
            reason:
              'Local file has google-doc-id but document not found in Google Drive (no path match either)',
          });
        }
      }
    }

    // Process unlinked local files (files without google-doc-id)
    for (const localUnlinked of localState.unlinked) {
      // These could potentially be pushed to create new documents
      pushToRemote.push({
        localFile: localUnlinked.file,
        action: 'create',
        reason: 'Local file has no google-doc-id, could create new Google Doc',
      });
    }

    // Process remote docs that don't have local counterparts
    for (const remoteDoc of remoteState.docs) {
      const localLinked = localByDocId.get(remoteDoc.id);

      if (!localLinked) {
        // Remote doc exists but no local file - should we pull?
        const potentialLocalPath = this.calculateTargetPath(remoteDoc);
        const existingFile = localByPath.get(potentialLocalPath);

        if (existingFile) {
          // Check if this local file is in our linked files list
          const existingLocalLinked = localState.linked.find(
            (local) => local.file === existingFile,
          );
          const existingLocalUnlinked = localState.unlinked.find(
            (local) => local.file === existingFile,
          );

          if (existingLocalLinked && existingLocalLinked.docId !== remoteDoc.id) {
            // Local file has a different ID but same path - re-link to the found remote doc
            console.log(
              `🔗 Re-linking existing file ${potentialLocalPath}: ${existingLocalLinked.docId} → ${remoteDoc.id}`,
            );
            pullFromRemote.push({
              remoteDoc,
              action: 'update',
              reason: `Re-linking existing local file to correct remote document (ID ${existingLocalLinked.docId} → ${remoteDoc.id})`,
              targetPath: potentialLocalPath,
            });
          } else if (existingLocalUnlinked) {
            // Local file has no ID - link it to the remote doc
            console.log(
              `🔗 Linking unlinked file ${potentialLocalPath} to remote doc ${remoteDoc.id}`,
            );
            pullFromRemote.push({
              remoteDoc,
              action: 'update',
              reason: 'Linking existing unlinked local file to remote document',
              targetPath: potentialLocalPath,
            });
          } else {
            // This shouldn't happen as it means same ID in both places (already processed above)
            warnings.push({
              type: 'existing-file',
              message: `Remote document "${remoteDoc.name}" conflicts with existing local file (already processed or unexpected state)`,
              details: {
                remoteName: remoteDoc.name,
                remoteId: remoteDoc.id,
                localPath: potentialLocalPath,
                remoteRelativePath: remoteDoc.relativePath,
              },
            });
          }
        } else {
          pullFromRemote.push({
            remoteDoc,
            action: 'create',
            reason: 'Remote document has no local counterpart',
            targetPath: potentialLocalPath,
          });
        }
      }
    }

    // Determine if sync plan is safe to execute - only block on real conflicts
    const safe =
      warnings.filter((w) => w.type === 'duplicate-document').length === 0 &&
      conflicts.length === 0;

    return {
      localState,
      remoteState,
      operations: {
        pushToRemote,
        pullFromRemote,
        conflicts,
        warnings,
        safe,
      },
    };
  }

  /**
   * Calculate the target local path for a remote document
   */
  private calculateTargetPath(remoteDoc: { name: string; relativePath: string }): string {
    if (remoteDoc.relativePath && remoteDoc.relativePath !== '(root)') {
      return `${remoteDoc.relativePath}/${remoteDoc.name}.md`;
    }
    return `${remoteDoc.name}.md`;
  }

  /**
   * Check if local file has been modified since last sync
   */
  private async hasLocalChanges(file: TFile): Promise<boolean> {
    try {
      const content = await this.storage.readFile(file.path);
      const { frontmatter } = SyncUtils.parseFrontMatter(content);
      const lastSynced = frontmatter['last-synced'];

      if (!lastSynced) {
        return true; // No sync history, assume changes
      }

      const lastSyncTime = new Date(lastSynced);
      const fileModified = new Date(file.stat.mtime);

      return fileModified > lastSyncTime;
    } catch (error) {
      console.error(`Failed to check local changes for ${file.path}:`, error);
      return true; // If we can't check, assume changes
    }
  }
}
