/**
 * Tests for Last Write Wins conflict resolution policy
 */

import { ConflictResolver, SyncState } from './ConflictResolver';
import { GoogleDocsSyncSettings } from '../types';

describe('Last Write Wins Conflict Resolution', () => {
  let resolver: ConflictResolver;
  let settings: GoogleDocsSyncSettings;

  beforeEach(() => {
    settings = {
      driveFolderId: 'test-folder',
      conflictPolicy: 'last-write-wins',
      pollInterval: 60,
    };
    resolver = new ConflictResolver(settings);
  });

  it('should prefer local when local is newer', async () => {
    const now = Date.now();
    const localNewer = now;
    const remoteOlder = now - 60000; // 1 minute older

    const state: SyncState = {
      local: {
        content: 'Local content (newer)',
        sha256: 'local-hash',
        lastModified: localNewer,
      },
      remote: {
        content: 'Remote content (older)',
        sha256: 'remote-hash',
        revisionId: 'remote-rev',
        modifiedTime: new Date(remoteOlder).toISOString(),
      },
    };

    const conflictInfo = {
      type: 'both_changed' as const,
      hasLocalChanges: true,
      hasRemoteChanges: true,
      canAutoResolve: false,
      description: 'Both changed',
    };

    const result = await resolver.resolveConflict(state, conflictInfo);

    expect(result.mergedContent).toBe('Local content (newer)');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflictMarkers.join(' ')).toContain('Local changes are newer');
  });

  it('should prefer remote when remote is newer', async () => {
    const now = Date.now();
    const localOlder = now - 60000; // 1 minute older
    const remoteNewer = now;

    const state: SyncState = {
      local: {
        content: 'Local content (older)',
        sha256: 'local-hash',
        lastModified: localOlder,
      },
      remote: {
        content: 'Remote content (newer)',
        sha256: 'remote-hash',
        revisionId: 'remote-rev',
        modifiedTime: new Date(remoteNewer).toISOString(),
      },
    };

    const conflictInfo = {
      type: 'both_changed' as const,
      hasLocalChanges: true,
      hasRemoteChanges: true,
      canAutoResolve: false,
      description: 'Both changed',
    };

    const result = await resolver.resolveConflict(state, conflictInfo);

    expect(result.mergedContent).toBe('Remote content (newer)');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflictMarkers.join(' ')).toContain('Remote changes are newer');
  });

  it('should prefer local as tie-breaker when timestamps are identical', async () => {
    const sameTime = Date.now();

    const state: SyncState = {
      local: {
        content: 'Local content',
        sha256: 'local-hash',
        lastModified: sameTime,
      },
      remote: {
        content: 'Remote content',
        sha256: 'remote-hash',
        revisionId: 'remote-rev',
        modifiedTime: new Date(sameTime).toISOString(),
      },
    };

    const conflictInfo = {
      type: 'both_changed' as const,
      hasLocalChanges: true,
      hasRemoteChanges: true,
      canAutoResolve: false,
      description: 'Both changed',
    };

    const result = await resolver.resolveConflict(state, conflictInfo);

    expect(result.mergedContent).toBe('Local content');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflictMarkers.join(' ')).toContain('Timestamps identical');
  });

  it('should handle missing local timestamp gracefully', async () => {
    const remoteTime = Date.now();

    const state: SyncState = {
      local: {
        content: 'Local content',
        sha256: 'local-hash',
        // lastModified is undefined
      },
      remote: {
        content: 'Remote content',
        sha256: 'remote-hash',
        revisionId: 'remote-rev',
        modifiedTime: new Date(remoteTime).toISOString(),
      },
    };

    const conflictInfo = {
      type: 'both_changed' as const,
      hasLocalChanges: true,
      hasRemoteChanges: true,
      canAutoResolve: false,
      description: 'Both changed',
    };

    const result = await resolver.resolveConflict(state, conflictInfo);

    expect(result.mergedContent).toBe('Remote content');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflictMarkers.join(' ')).toContain('Remote changes are newer');
  });

  it('should validate last-write-wins policy', () => {
    expect(ConflictResolver.isValidPolicy('last-write-wins')).toBe(true);
    expect(ConflictResolver.isValidPolicy('prefer-doc')).toBe(true);
    expect(ConflictResolver.isValidPolicy('invalid')).toBe(false);
  });

  it('should provide correct policy description', () => {
    const description = ConflictResolver.getPolicyDescription('last-write-wins');
    expect(description).toBe('Use the version that was modified most recently');
  });
});