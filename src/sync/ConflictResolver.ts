/**
 * Conflict Resolution System for Google Docs ↔ Markdown Sync
 *
 * Implements 3-way merge using revisionId + sha256 comparison for intelligent
 * conflict detection and resolution with configurable policies.
 */

import { GoogleDocsSyncSettings, ConflictResolutionResult } from '../types';

import { FrontMatter } from './SyncUtils';

export interface SyncState {
  local: {
    content: string;
    sha256: string;
    revisionId?: string;
    lastSynced?: string;
    lastModified?: number; // Local file modification timestamp
  };
  remote: {
    content: string;
    sha256: string;
    revisionId: string;
    modifiedTime: string; // ISO string from Google Drive
  };
  lastKnown?: {
    sha256: string;
    revisionId: string;
  };
}

export interface ConflictInfo {
  type: 'no_conflict' | 'local_only' | 'remote_only' | 'both_changed';
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
  canAutoResolve: boolean;
  description: string;
}

export class ConflictResolver {
  constructor(private settings: GoogleDocsSyncSettings) {}

  /**
   * Detect conflict state using 3-way comparison
   */
  async detectConflict(state: SyncState): Promise<ConflictInfo> {
    const { local, remote, lastKnown } = state;

    // If we don't have last known state, assume first sync
    if (!lastKnown) {
      const localChanged = local.content.trim() !== '';
      const remoteChanged = remote.content.trim() !== '';

      if (!localChanged && !remoteChanged) {
        return {
          type: 'no_conflict',
          hasLocalChanges: false,
          hasRemoteChanges: false,
          canAutoResolve: true,
          description: 'No changes detected',
        };
      } else if (localChanged && !remoteChanged) {
        return {
          type: 'local_only',
          hasLocalChanges: true,
          hasRemoteChanges: false,
          canAutoResolve: true,
          description: 'Local changes only - will push to remote',
        };
      } else if (!localChanged && remoteChanged) {
        return {
          type: 'remote_only',
          hasLocalChanges: false,
          hasRemoteChanges: true,
          canAutoResolve: true,
          description: 'Remote changes only - will pull from remote',
        };
      } else {
        return {
          type: 'both_changed',
          hasLocalChanges: true,
          hasRemoteChanges: true,
          canAutoResolve: false,
          description: 'Both local and remote have changes - requires conflict resolution',
        };
      }
    }

    // 3-way comparison with last known state
    const localChangedFromBase = local.sha256 !== lastKnown.sha256;
    const remoteChangedFromBase = remote.revisionId !== lastKnown.revisionId;

    if (!localChangedFromBase && !remoteChangedFromBase) {
      return {
        type: 'no_conflict',
        hasLocalChanges: false,
        hasRemoteChanges: false,
        canAutoResolve: true,
        description: 'No changes since last sync',
      };
    } else if (localChangedFromBase && !remoteChangedFromBase) {
      return {
        type: 'local_only',
        hasLocalChanges: true,
        hasRemoteChanges: false,
        canAutoResolve: true,
        description: 'Local changes only - will push to remote',
      };
    } else if (!localChangedFromBase && remoteChangedFromBase) {
      return {
        type: 'remote_only',
        hasLocalChanges: false,
        hasRemoteChanges: true,
        canAutoResolve: true,
        description: 'Remote changes only - will pull from remote',
      };
    } else {
      return {
        type: 'both_changed',
        hasLocalChanges: true,
        hasRemoteChanges: true,
        canAutoResolve: false,
        description: 'Both local and remote changed - requires conflict resolution policy',
      };
    }
  }

  /**
   * Resolve conflicts based on configured policy
   */
  async resolveConflict(
    state: SyncState,
    conflictInfo: ConflictInfo,
  ): Promise<ConflictResolutionResult> {
    // Auto-resolve non-conflicts
    if (conflictInfo.canAutoResolve) {
      switch (conflictInfo.type) {
        case 'no_conflict':
          return {
            mergedContent: state.local.content,
            hasConflicts: false,
            conflictMarkers: [],
          };

        case 'local_only':
          return {
            mergedContent: state.local.content,
            hasConflicts: false,
            conflictMarkers: [],
          };

        case 'remote_only':
          return {
            mergedContent: state.remote.content,
            hasConflicts: false,
            conflictMarkers: [],
          };
      }
    }

    // Handle true conflicts based on policy
    return this.applyConflictPolicy(state, conflictInfo);
  }

  /**
   * Apply configured conflict resolution policy
   */
  private async applyConflictPolicy(
    state: SyncState,
    conflictInfo: ConflictInfo,
  ): Promise<ConflictResolutionResult> {
    const { local, remote } = state;

    switch (this.settings.conflictPolicy) {
      case 'prefer-doc':
        return {
          mergedContent: remote.content,
          hasConflicts: false,
          conflictMarkers: [
            `🔄 Conflict resolved using 'prefer-doc' policy`,
            `📝 Local changes were overwritten by Google Doc version`,
            `🕒 Remote modified: ${new Date(remote.modifiedTime).toLocaleString()}`,
          ],
        };

      case 'prefer-md':
        return {
          mergedContent: local.content,
          hasConflicts: false,
          conflictMarkers: [
            `🔄 Conflict resolved using 'prefer-md' policy`,
            `📝 Google Doc will be updated with local changes`,
            `🕒 Local changes preserved over remote version`,
          ],
        };

      case 'merge':
        return this.attemptMerge(state, conflictInfo);

      case 'last-write-wins':
        return this.applyLastWriteWins(state);

      default:
        throw new Error(`Unknown conflict policy: ${this.settings.conflictPolicy}`);
    }
  }

  /**
   * Apply last-write-wins policy based on modification times
   */
  private async applyLastWriteWins(state: SyncState): Promise<ConflictResolutionResult> {
    const { local, remote } = state;

    // Get timestamps for comparison
    const localModified = local.lastModified || 0;
    const remoteModified = new Date(remote.modifiedTime).getTime();

    // Determine which version was modified more recently
    if (localModified > remoteModified) {
      // Local file is newer
      return {
        mergedContent: local.content,
        hasConflicts: false,
        conflictMarkers: [
          `🔄 Conflict resolved using 'last-write-wins' policy`,
          `📝 Local changes are newer - Google Doc will be updated`,
          `🕒 Local: ${new Date(localModified).toLocaleString()}`,
          `🕒 Remote: ${new Date(remoteModified).toLocaleString()}`,
        ],
      };
    } else if (remoteModified > localModified) {
      // Remote file is newer
      return {
        mergedContent: remote.content,
        hasConflicts: false,
        conflictMarkers: [
          `🔄 Conflict resolved using 'last-write-wins' policy`,
          `📝 Remote changes are newer - local file will be updated`,
          `🕒 Local: ${new Date(localModified).toLocaleString()}`,
          `🕒 Remote: ${new Date(remoteModified).toLocaleString()}`,
        ],
      };
    } else {
      // Same timestamp - prefer local as tie-breaker
      return {
        mergedContent: local.content,
        hasConflicts: false,
        conflictMarkers: [
          `🔄 Conflict resolved using 'last-write-wins' policy`,
          `📝 Timestamps identical - preferring local changes as tie-breaker`,
          `🕒 Both modified: ${new Date(localModified).toLocaleString()}`,
        ],
      };
    }
  }

  /**
   * Attempt intelligent merge of conflicting changes
   */
  private async attemptMerge(
    state: SyncState,
    _conflictInfo: ConflictInfo,
  ): Promise<ConflictResolutionResult> {
    const { local, remote } = state;

    // For now, implement a simple line-based merge
    // This can be enhanced with more sophisticated merge algorithms
    const localLines = local.content.split('\n');
    const remoteLines = remote.content.split('\n');

    // Simple heuristic: if one version is clearly an extension of the other, merge them
    const isLocalExtension = this.isExtensionOf(localLines, remoteLines);
    const isRemoteExtension = this.isExtensionOf(remoteLines, localLines);

    if (isLocalExtension) {
      return {
        mergedContent: local.content,
        hasConflicts: false,
        conflictMarkers: [
          `🔄 Merge successful: Local version includes all remote changes`,
          `📝 Using local version as it extends remote content`,
        ],
      };
    }

    if (isRemoteExtension) {
      return {
        mergedContent: remote.content,
        hasConflicts: false,
        conflictMarkers: [
          `🔄 Merge successful: Remote version includes all local changes`,
          `📝 Using remote version as it extends local content`,
        ],
      };
    }

    // Cannot auto-merge - create conflict markers for manual resolution
    return this.createConflictMarkers(state);
  }

  /**
   * Check if one set of lines is an extension of another
   */
  private isExtensionOf(longer: string[], shorter: string[]): boolean {
    if (longer.length <= shorter.length) return false;

    // Check if shorter version matches the beginning of longer version
    for (let i = 0; i < shorter.length; i++) {
      if (longer[i] !== shorter[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Create conflict markers for manual resolution
   */
  private createConflictMarkers(state: SyncState): ConflictResolutionResult {
    const { local, remote } = state;
    const timestamp = new Date().toISOString();

    const conflictContent = [
      `<<<<<<< LOCAL (Modified: ${state.local.lastSynced || 'Unknown'})`,
      local.content,
      '=======',
      `>>>>>>> REMOTE (Modified: ${remote.modifiedTime})`,
      remote.content,
      `>>>>>>> END CONFLICT (Generated: ${timestamp})`,
    ].join('\n');

    const conflictMarkers = [
      `⚠️ CONFLICT: Manual resolution required`,
      `🏠 Local changes: ${local.sha256.substring(0, 8)}`,
      `☁️ Remote changes: ${remote.sha256.substring(0, 8)}`,
      `📝 Both versions have been preserved in conflict markers`,
      `✏️ Please manually edit the file to resolve conflicts and remove markers`,
      `🔄 Re-sync after resolving conflicts to complete the merge`,
    ];

    return {
      mergedContent: conflictContent,
      hasConflicts: true,
      conflictMarkers,
    };
  }

  /**
   * Build updated sync state after conflict resolution
   */
  buildResolvedState(
    originalFrontmatter: FrontMatter,
    resolvedContent: string,
    remoteRevisionId: string,
    isLocalWinner: boolean,
  ): { frontmatter: FrontMatter; content: string } {
    return {
      frontmatter: {
        ...originalFrontmatter,
        revisionId: remoteRevisionId,
        sha256: '', // Will be computed by caller
        'last-synced': new Date().toISOString(),
        'conflict-resolved': new Date().toISOString(),
        'resolution-policy': this.settings.conflictPolicy,
        'resolution-winner': isLocalWinner ? 'local' : 'remote',
      },
      content: resolvedContent,
    };
  }

  /**
   * Detect if content contains unresolved conflict markers
   */
  hasUnresolvedConflicts(content: string): boolean {
    const conflictMarkers = ['<<<<<<< LOCAL', '=======', '>>>>>>> REMOTE', '>>>>>>> END CONFLICT'];

    return conflictMarkers.some((marker) => content.includes(marker));
  }

  /**
   * Extract clean content from conflict markers (for user-resolved conflicts)
   */
  extractResolvedContent(content: string): string {
    // Remove conflict markers that may be left over
    return content
      .replace(/^<<<<<<< LOCAL.*$/gm, '')
      .replace(/^=======$/gm, '')
      .replace(/^>>>>>>> REMOTE.*$/gm, '')
      .replace(/^>>>>>>> END CONFLICT.*$/gm, '')
      .replace(/^\n+/gm, '\n') // Clean up extra newlines
      .trim();
  }

  /**
   * Validate that a policy string is valid
   */
  static isValidPolicy(
    policy: string,
  ): policy is 'last-write-wins' | 'prefer-doc' | 'prefer-md' | 'merge' {
    return ['last-write-wins', 'prefer-doc', 'prefer-md', 'merge'].includes(policy);
  }

  /**
   * Get human-readable description of conflict policy
   */
  static getPolicyDescription(
    policy: 'last-write-wins' | 'prefer-doc' | 'prefer-md' | 'merge',
  ): string {
    switch (policy) {
      case 'last-write-wins':
        return 'Use the version that was modified most recently';
      case 'prefer-doc':
        return 'Always use Google Doc version when conflicts occur';
      case 'prefer-md':
        return 'Always use Markdown file version when conflicts occur';
      case 'merge':
        return 'Attempt intelligent merge, fall back to conflict markers';
      default:
        return 'Unknown policy';
    }
  }
}
