import { TFile } from 'obsidian';

import type GoogleDocsSyncPlugin from '../plugin-main';
import type { SyncState } from '../types/plugin-types';

export class ChangeDetector {
  private plugin: GoogleDocsSyncPlugin;

  constructor(plugin: GoogleDocsSyncPlugin) {
    this.plugin = plugin;
  }

  async detectChanges(file: TFile): Promise<SyncState> {
    const metadata = await this.plugin.getGoogleDocsMetadata(file);
    if (!metadata) {
      return {
        hasLocalChanges: false,
        hasRemoteChanges: false,
        hasLocalMove: false,
        hasRemoteMove: false,
        hasLocalDelete: false,
        hasRemoteDelete: false,
      };
    }

    const lastSynced = new Date(metadata.lastSynced);
    const localMtime = new Date(file.stat.mtime);

    // Check for local changes (file modified after last sync)
    const hasLocalChanges = localMtime > lastSynced;

    // Check for remote changes and deletions
    let hasRemoteChanges = false;
    let hasRemoteDelete = false;
    let deleteReason: 'remote-deleted' | 'remote-trashed' | undefined;
    let remoteDeletedAt: Date | undefined;

    try {
      if (metadata.id) {
        const driveAPI = await this.plugin.getAuthenticatedDriveAPI();

        // Check if the Google Doc still exists
        const fileInfo = await driveAPI.getFile(metadata.id);

        if (!fileInfo) {
          // File completely deleted
          hasRemoteDelete = true;
          deleteReason = 'remote-deleted';
          remoteDeletedAt = new Date();
        } else if (fileInfo.trashed) {
          // File moved to trash
          hasRemoteDelete = true;
          deleteReason = 'remote-trashed';
          remoteDeletedAt = new Date(fileInfo.modifiedTime);
        } else {
          // File exists, check for normal changes
          hasRemoteChanges = await this.plugin.hasRemoteChanges(metadata.id, metadata.lastSynced);
        }
      }
    } catch (error) {
      console.warn('Failed to check remote file status:', error);
    }

    // Check for local move (file path changed since last sync)
    const hasLocalMove = metadata.lastSyncPath && metadata.lastSyncPath !== file.path;
    const localMoveFrom = hasLocalMove ? metadata.lastSyncPath : undefined;

    // Check for remote move (only if file still exists)
    let hasRemoteMove = false;
    let remoteMoveFrom: string | undefined;

    // TODO: Temporarily disable remote move detection due to false positives
    // The issue is comparing actual Google Doc names with calculated expected names
    // which don't always match (especially for files with spaces/special chars)
    try {
      // TODO: Temporarily disable remote move detection due to false positives
      // The issue is comparing actual Google Doc names with calculated expected names
      // which don't always match (especially for files with spaces/special chars)
      // eslint-disable-next-line no-constant-condition, no-constant-binary-expression
      if (false && this.plugin.settings.syncMoves && metadata.id && !hasRemoteDelete) {
        const driveAPI = await this.plugin.getAuthenticatedDriveAPI();

        // Get relative path from the base drive folder
        const baseFolderId = await this.plugin.resolveDriveFolderId();
        const currentRemotePath = await driveAPI.getFilePath(metadata.id, baseFolderId);
        const expectedRemotePath = this.plugin.calculateExpectedRemotePath(file.path);

        console.log(
          `Move detection for ${file.path}: current="${currentRemotePath}", expected="${expectedRemotePath}"`,
        );

        if (currentRemotePath !== expectedRemotePath) {
          hasRemoteMove = true;
          remoteMoveFrom = currentRemotePath;
          console.log(`Move detected: "${currentRemotePath}" → "${expectedRemotePath}"`);
        }
      }
    } catch (error) {
      console.warn('Failed to check for remote move:', error);
    }

    // Local delete detection (file exists in our tracking but not in vault)
    // This will be handled at a higher level during sync enumeration

    return {
      hasLocalChanges,
      hasRemoteChanges,
      hasLocalMove,
      hasRemoteMove,
      hasLocalDelete: false, // Will be set during sync enumeration
      hasRemoteDelete,
      localMoveFrom,
      remoteMoveFrom,
      deleteReason,
      remoteDeletedAt,
    };
  }
}
