/**
 * Unified Sync Service for Google Docs ↔ Markdown Sync
 *
 * Provides high-level sync operations with integrated conflict resolution
 * for both CLI and plugin usage.
 */

import { GoogleDocsSyncSettings } from '../types';

import { ConflictResolver, SyncState, ConflictInfo } from './ConflictResolver';
import { SyncUtils, FrontMatter } from './SyncUtils';

export interface SyncResult {
  success: boolean;
  action: 'no_change' | 'pull' | 'push' | 'conflict_resolved' | 'conflict_manual';
  conflictInfo?: ConflictInfo;
  conflictMarkers?: string[];
  error?: string;
}

export interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
  skipConflictCheck?: boolean;
}

export class SyncService {
  private conflictResolver: ConflictResolver;

  constructor(private settings: GoogleDocsSyncSettings) {
    this.conflictResolver = new ConflictResolver(settings);
  }

  /**
   * Perform intelligent sync operation with conflict resolution
   */
  async syncDocument(
    localContent: string,
    localFrontmatter: FrontMatter,
    remoteContent: string,
    remoteRevisionId: string,
    remoteModifiedTime: string,
    options: SyncOptions = {},
  ): Promise<{ result: SyncResult; updatedContent?: string; updatedFrontmatter?: FrontMatter }> {
    try {
      // Compute current content hashes
      const localSha256 = await SyncUtils.computeSHA256(localContent);
      const remoteSha256 = await SyncUtils.computeSHA256(remoteContent);

      // Build sync state for 3-way comparison
      const syncState: SyncState = {
        local: {
          content: localContent,
          sha256: localSha256,
          revisionId: localFrontmatter.revisionId,
          lastSynced: localFrontmatter['last-synced'],
        },
        remote: {
          content: remoteContent,
          sha256: remoteSha256,
          revisionId: remoteRevisionId,
          modifiedTime: remoteModifiedTime,
        },
        lastKnown:
          localFrontmatter.sha256 && localFrontmatter.revisionId
            ? {
                sha256: localFrontmatter.sha256,
                revisionId: localFrontmatter.revisionId,
              }
            : undefined,
      };

      // Detect conflict state
      const conflictInfo = await this.conflictResolver.detectConflict(syncState);

      // Return early for dry run
      if (options.dryRun) {
        return {
          result: {
            success: true,
            action: this.getActionFromConflictInfo(conflictInfo),
            conflictInfo,
            conflictMarkers: conflictInfo.canAutoResolve
              ? []
              : ['Would require conflict resolution'],
          },
        };
      }

      // Handle no-conflict cases
      if (conflictInfo.type === 'no_conflict') {
        // Update metadata even if content unchanged
        const updatedFrontmatter = this.updateSyncMetadata(
          localFrontmatter,
          remoteRevisionId,
          localSha256,
        );

        return {
          result: {
            success: true,
            action: 'no_change',
          },
          updatedContent: localContent,
          updatedFrontmatter,
        };
      }

      // Handle auto-resolvable conflicts
      if (conflictInfo.canAutoResolve) {
        const resolutionResult = await this.conflictResolver.resolveConflict(
          syncState,
          conflictInfo,
        );
        const isLocalWinner = conflictInfo.type === 'local_only';

        const resolvedState = this.conflictResolver.buildResolvedState(
          localFrontmatter,
          resolutionResult.mergedContent,
          remoteRevisionId,
          isLocalWinner,
        );

        // Update SHA256 with resolved content
        resolvedState.frontmatter.sha256 = await SyncUtils.computeSHA256(
          resolutionResult.mergedContent,
        );

        return {
          result: {
            success: true,
            action: conflictInfo.type === 'local_only' ? 'push' : 'pull',
            conflictInfo,
            conflictMarkers: resolutionResult.conflictMarkers,
          },
          updatedContent: resolutionResult.mergedContent,
          updatedFrontmatter: resolvedState.frontmatter,
        };
      }

      // Handle true conflicts requiring policy resolution
      const resolutionResult = await this.conflictResolver.resolveConflict(syncState, conflictInfo);
      const isLocalWinner = this.settings.conflictPolicy === 'prefer-md';

      const resolvedState = this.conflictResolver.buildResolvedState(
        localFrontmatter,
        resolutionResult.mergedContent,
        remoteRevisionId,
        isLocalWinner,
      );

      // Update SHA256 with resolved content
      resolvedState.frontmatter.sha256 = await SyncUtils.computeSHA256(
        resolutionResult.mergedContent,
      );

      return {
        result: {
          success: true,
          action: resolutionResult.hasConflicts ? 'conflict_manual' : 'conflict_resolved',
          conflictInfo,
          conflictMarkers: resolutionResult.conflictMarkers,
        },
        updatedContent: resolutionResult.mergedContent,
        updatedFrontmatter: resolvedState.frontmatter,
      };
    } catch (error) {
      return {
        result: {
          success: false,
          action: 'no_change',
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      };
    }
  }

  /**
   * Check if local file has unresolved conflicts
   */
  hasUnresolvedConflicts(content: string): boolean {
    return this.conflictResolver.hasUnresolvedConflicts(content);
  }

  /**
   * Extract resolved content from user-edited conflict markers
   */
  extractResolvedContent(content: string): string {
    return this.conflictResolver.extractResolvedContent(content);
  }

  /**
   * Update sync metadata after successful sync
   */
  private updateSyncMetadata(
    frontmatter: FrontMatter,
    newRevisionId: string,
    newSha256: string,
  ): FrontMatter {
    return {
      ...frontmatter,
      revisionId: newRevisionId,
      sha256: newSha256,
      'last-synced': new Date().toISOString(),
    };
  }

  /**
   * Convert conflict info to action type
   */
  private getActionFromConflictInfo(conflictInfo: ConflictInfo): SyncResult['action'] {
    switch (conflictInfo.type) {
      case 'no_conflict':
        return 'no_change';
      case 'local_only':
        return 'push';
      case 'remote_only':
        return 'pull';
      case 'both_changed':
        return 'conflict_resolved';
      default:
        return 'no_change';
    }
  }

  /**
   * Validate sync preconditions
   */
  validateSyncPreconditions(
    localContent: string,
    localFrontmatter: FrontMatter,
  ): { valid: boolean; error?: string } {
    // Check for unresolved conflicts
    if (this.hasUnresolvedConflicts(localContent)) {
      return {
        valid: false,
        error:
          'File contains unresolved conflict markers. Please resolve conflicts manually before syncing.',
      };
    }

    // Check for required metadata
    if (!localFrontmatter.docId && !localFrontmatter['google-doc-id']) {
      return {
        valid: false,
        error: 'File is not linked to a Google Doc. Use push command to create a new document.',
      };
    }

    return { valid: true };
  }

  /**
   * Generate sync summary for user feedback
   */
  generateSyncSummary(result: SyncResult): string {
    if (!result.success) {
      return `❌ Sync failed: ${result.error}`;
    }

    switch (result.action) {
      case 'no_change':
        return '✅ No changes detected - files are in sync';

      case 'pull':
        return '📥 Pulled remote changes to local file';

      case 'push':
        return '📤 Pushed local changes to Google Doc';

      case 'conflict_resolved':
        const policy = this.settings.conflictPolicy;
        const policyDesc = ConflictResolver.getPolicyDescription(policy);
        return `🔄 Conflict resolved using '${policy}' policy: ${policyDesc}`;

      case 'conflict_manual':
        return `⚠️ Manual conflict resolution required - conflict markers have been added to the file`;

      default:
        return '✅ Sync completed';
    }
  }

  /**
   * Get detailed conflict explanation for user
   */
  getConflictExplanation(conflictInfo: ConflictInfo): string {
    switch (conflictInfo.type) {
      case 'no_conflict':
        return 'Files are identical or no changes detected since last sync.';

      case 'local_only':
        return 'Only local file has changes since last sync. Will push to Google Doc.';

      case 'remote_only':
        return 'Only Google Doc has changes since last sync. Will pull to local file.';

      case 'both_changed':
        return 'Both local file and Google Doc have changes since last sync. Conflict resolution required.';

      default:
        return 'Unknown conflict state.';
    }
  }

  /**
   * Create a new sync service instance with different settings
   */
  withSettings(newSettings: GoogleDocsSyncSettings): SyncService {
    return new SyncService(newSettings);
  }
}

/**
 * Utility function to create a configured sync service
 */
export function createSyncService(settings: GoogleDocsSyncSettings): SyncService {
  return new SyncService(settings);
}
