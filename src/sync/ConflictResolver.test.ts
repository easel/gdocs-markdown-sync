/**
 * Comprehensive tests for ConflictResolver
 */

import { describe, it, expect, beforeEach } from 'bun:test';

import { GoogleDocsSyncSettings } from '../types';

import { ConflictResolver, SyncState } from './ConflictResolver';

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;
  let mockSettings: GoogleDocsSyncSettings;

  beforeEach(() => {
    mockSettings = {
      driveFolderId: 'test-folder',
      conflictPolicy: 'prefer-doc',
      pollInterval: 60,
    };
    resolver = new ConflictResolver(mockSettings);
  });

  describe('detectConflict', () => {
    it('should detect no conflict when nothing has changed', async () => {
      const state: SyncState = {
        local: {
          content: 'Hello World',
          sha256: 'abc123',
          revisionId: 'rev1',
          lastSynced: '2023-01-01T10:00:00Z',
        },
        remote: {
          content: 'Hello World',
          sha256: 'abc123',
          revisionId: 'rev1',
          modifiedTime: '2023-01-01T10:00:00Z',
        },
        lastKnown: {
          sha256: 'abc123',
          revisionId: 'rev1',
        },
      };

      const result = await resolver.detectConflict(state);

      expect(result.type).toBe('no_conflict');
      expect(result.hasLocalChanges).toBe(false);
      expect(result.hasRemoteChanges).toBe(false);
      expect(result.canAutoResolve).toBe(true);
    });

    it('should detect local-only changes', async () => {
      const state: SyncState = {
        local: {
          content: 'Hello World Updated',
          sha256: 'xyz789',
          revisionId: 'rev1',
          lastSynced: '2023-01-01T10:00:00Z',
        },
        remote: {
          content: 'Hello World',
          sha256: 'abc123',
          revisionId: 'rev1',
          modifiedTime: '2023-01-01T10:00:00Z',
        },
        lastKnown: {
          sha256: 'abc123',
          revisionId: 'rev1',
        },
      };

      const result = await resolver.detectConflict(state);

      expect(result.type).toBe('local_only');
      expect(result.hasLocalChanges).toBe(true);
      expect(result.hasRemoteChanges).toBe(false);
      expect(result.canAutoResolve).toBe(true);
    });

    it('should detect remote-only changes', async () => {
      const state: SyncState = {
        local: {
          content: 'Hello World',
          sha256: 'abc123',
          revisionId: 'rev1',
          lastSynced: '2023-01-01T10:00:00Z',
        },
        remote: {
          content: 'Hello World Updated',
          sha256: 'xyz789',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'abc123',
          revisionId: 'rev1',
        },
      };

      const result = await resolver.detectConflict(state);

      expect(result.type).toBe('remote_only');
      expect(result.hasLocalChanges).toBe(false);
      expect(result.hasRemoteChanges).toBe(true);
      expect(result.canAutoResolve).toBe(true);
    });

    it('should detect both-changed conflicts', async () => {
      const state: SyncState = {
        local: {
          content: 'Hello World Local',
          sha256: 'local123',
          revisionId: 'rev1',
          lastSynced: '2023-01-01T10:00:00Z',
        },
        remote: {
          content: 'Hello World Remote',
          sha256: 'remote456',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'abc123',
          revisionId: 'rev1',
        },
      };

      const result = await resolver.detectConflict(state);

      expect(result.type).toBe('both_changed');
      expect(result.hasLocalChanges).toBe(true);
      expect(result.hasRemoteChanges).toBe(true);
      expect(result.canAutoResolve).toBe(false);
    });

    it('should handle first sync when no lastKnown state exists', async () => {
      const state: SyncState = {
        local: {
          content: 'New local content',
          sha256: 'local123',
          revisionId: undefined,
          lastSynced: undefined,
        },
        remote: {
          content: 'New remote content',
          sha256: 'remote456',
          revisionId: 'rev1',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        // No lastKnown state
      };

      const result = await resolver.detectConflict(state);

      expect(result.type).toBe('both_changed');
      expect(result.hasLocalChanges).toBe(true);
      expect(result.hasRemoteChanges).toBe(true);
      expect(result.canAutoResolve).toBe(false);
    });
  });

  describe('resolveConflict - prefer-doc policy', () => {
    beforeEach(() => {
      mockSettings.conflictPolicy = 'prefer-doc';
      resolver = new ConflictResolver(mockSettings);
    });

    it('should prefer remote content for conflicts', async () => {
      const state: SyncState = {
        local: {
          content: 'Local content',
          sha256: 'local123',
          revisionId: 'rev1',
        },
        remote: {
          content: 'Remote content',
          sha256: 'remote456',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'old123',
          revisionId: 'rev1',
        },
      };

      const conflictInfo = await resolver.detectConflict(state);
      const result = await resolver.resolveConflict(state, conflictInfo);

      expect(result.mergedContent).toBe('Remote content');
      expect(result.hasConflicts).toBe(false);
      expect(result.conflictMarkers).toContain(`🔄 Conflict resolved using 'prefer-doc' policy`);
    });
  });

  describe('resolveConflict - prefer-md policy', () => {
    beforeEach(() => {
      mockSettings.conflictPolicy = 'prefer-md';
      resolver = new ConflictResolver(mockSettings);
    });

    it('should prefer local content for conflicts', async () => {
      const state: SyncState = {
        local: {
          content: 'Local content',
          sha256: 'local123',
          revisionId: 'rev1',
        },
        remote: {
          content: 'Remote content',
          sha256: 'remote456',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'old123',
          revisionId: 'rev1',
        },
      };

      const conflictInfo = await resolver.detectConflict(state);
      const result = await resolver.resolveConflict(state, conflictInfo);

      expect(result.mergedContent).toBe('Local content');
      expect(result.hasConflicts).toBe(false);
      expect(result.conflictMarkers).toContain(`🔄 Conflict resolved using 'prefer-md' policy`);
    });
  });

  describe('resolveConflict - merge policy', () => {
    beforeEach(() => {
      mockSettings.conflictPolicy = 'merge';
      resolver = new ConflictResolver(mockSettings);
    });

    it('should successfully merge when local is extension of remote', async () => {
      const state: SyncState = {
        local: {
          content: 'Line 1\nLine 2\nLine 3',
          sha256: 'local123',
          revisionId: 'rev1',
        },
        remote: {
          content: 'Line 1\nLine 2',
          sha256: 'remote456',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'old123',
          revisionId: 'rev1',
        },
      };

      const conflictInfo = await resolver.detectConflict(state);
      const result = await resolver.resolveConflict(state, conflictInfo);

      expect(result.mergedContent).toBe('Line 1\nLine 2\nLine 3');
      expect(result.hasConflicts).toBe(false);
      expect(result.conflictMarkers).toContain(
        '🔄 Merge successful: Local version includes all remote changes',
      );
    });

    it('should successfully merge when remote is extension of local', async () => {
      const state: SyncState = {
        local: {
          content: 'Line 1\nLine 2',
          sha256: 'local123',
          revisionId: 'rev1',
        },
        remote: {
          content: 'Line 1\nLine 2\nLine 3',
          sha256: 'remote456',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'old123',
          revisionId: 'rev1',
        },
      };

      const conflictInfo = await resolver.detectConflict(state);
      const result = await resolver.resolveConflict(state, conflictInfo);

      expect(result.mergedContent).toBe('Line 1\nLine 2\nLine 3');
      expect(result.hasConflicts).toBe(false);
      expect(result.conflictMarkers).toContain(
        '🔄 Merge successful: Remote version includes all local changes',
      );
    });

    it('should create conflict markers when merge is not possible', async () => {
      const state: SyncState = {
        local: {
          content: 'Line 1\nLocal Line 2\nLine 3',
          sha256: 'local123',
          revisionId: 'rev1',
          lastSynced: '2023-01-01T10:00:00Z',
        },
        remote: {
          content: 'Line 1\nRemote Line 2\nLine 3',
          sha256: 'remote456',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'old123',
          revisionId: 'rev1',
        },
      };

      const conflictInfo = await resolver.detectConflict(state);
      const result = await resolver.resolveConflict(state, conflictInfo);

      expect(result.hasConflicts).toBe(true);
      expect(result.mergedContent).toContain('<<<<<<< LOCAL');
      expect(result.mergedContent).toContain('=======');
      expect(result.mergedContent).toContain('>>>>>>> REMOTE');
      expect(result.mergedContent).toContain('>>>>>>> END CONFLICT');
      expect(result.conflictMarkers).toContain('⚠️ CONFLICT: Manual resolution required');
    });
  });

  describe('buildResolvedState', () => {
    it('should build proper resolved state with conflict metadata', () => {
      const originalFrontmatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        'google-doc-title': 'Test Doc',
      };

      const result = resolver.buildResolvedState(
        originalFrontmatter,
        'resolved content',
        'rev2',
        true,
      );

      expect(result.frontmatter).toMatchObject({
        'google-doc-id': 'doc123',
        docId: 'doc123',
        'google-doc-title': 'Test Doc',
        revisionId: 'rev2',
        'resolution-policy': 'prefer-doc',
        'resolution-winner': 'local',
      });
      expect(result.frontmatter['last-synced']).toBeDefined();
      expect(result.frontmatter['conflict-resolved']).toBeDefined();
      expect(result.content).toBe('resolved content');
    });
  });

  describe('hasUnresolvedConflicts', () => {
    it('should detect conflict markers in content', () => {
      const contentWithConflicts = `
Some content
<<<<<<< LOCAL (Modified: 2023-01-01T10:00:00Z)
Local changes
=======
>>>>>>> REMOTE (Modified: 2023-01-01T11:00:00Z)
Remote changes
>>>>>>> END CONFLICT (Generated: 2023-01-01T12:00:00Z)
More content
`;

      expect(resolver.hasUnresolvedConflicts(contentWithConflicts)).toBe(true);
      expect(resolver.hasUnresolvedConflicts('Clean content')).toBe(false);
    });
  });

  describe('extractResolvedContent', () => {
    it('should clean up conflict markers', () => {
      const contentWithMarkers = `
Some content
<<<<<<< LOCAL (Modified: 2023-01-01T10:00:00Z)
=======
>>>>>>> REMOTE (Modified: 2023-01-01T11:00:00Z)
>>>>>>> END CONFLICT (Generated: 2023-01-01T12:00:00Z)
More content
`;

      const cleaned = resolver.extractResolvedContent(contentWithMarkers);

      expect(cleaned).toBe('Some content\n\nMore content');
      expect(cleaned).not.toContain('<<<<<<<');
      expect(cleaned).not.toContain('=======');
      expect(cleaned).not.toContain('>>>>>>>');
    });
  });

  describe('static utility methods', () => {
    it('should validate conflict policies', () => {
      expect(ConflictResolver.isValidPolicy('prefer-doc')).toBe(true);
      expect(ConflictResolver.isValidPolicy('prefer-md')).toBe(true);
      expect(ConflictResolver.isValidPolicy('merge')).toBe(true);
      expect(ConflictResolver.isValidPolicy('invalid')).toBe(false);
    });

    it('should provide policy descriptions', () => {
      expect(ConflictResolver.getPolicyDescription('prefer-doc')).toBe(
        'Always use Google Doc version when conflicts occur',
      );
      expect(ConflictResolver.getPolicyDescription('prefer-md')).toBe(
        'Always use Markdown file version when conflicts occur',
      );
      expect(ConflictResolver.getPolicyDescription('merge')).toBe(
        'Attempt intelligent merge, fall back to conflict markers',
      );
    });
  });

  describe('edge cases', () => {
    it('should handle empty content gracefully', async () => {
      const state: SyncState = {
        local: {
          content: '',
          sha256: 'empty1',
          revisionId: 'rev1',
        },
        remote: {
          content: '',
          sha256: 'empty2',
          revisionId: 'rev1',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'empty1',
          revisionId: 'rev1',
        },
      };

      const result = await resolver.detectConflict(state);
      expect(result.type).toBe('no_conflict');
    });

    it('should handle very large content efficiently', async () => {
      const largeContent = 'A'.repeat(100000);
      const state: SyncState = {
        local: {
          content: largeContent,
          sha256: 'large1',
          revisionId: 'rev1',
        },
        remote: {
          content: largeContent + 'B',
          sha256: 'large2',
          revisionId: 'rev2',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'large1',
          revisionId: 'rev1',
        },
      };

      const result = await resolver.detectConflict(state);
      expect(result.type).toBe('remote_only');
    });

    it('should handle malformed revision IDs', async () => {
      const state: SyncState = {
        local: {
          content: 'content',
          sha256: 'hash1',
          revisionId: '',
        },
        remote: {
          content: 'content',
          sha256: 'hash1',
          revisionId: '',
          modifiedTime: '2023-01-01T11:00:00Z',
        },
        lastKnown: {
          sha256: 'hash1',
          revisionId: '',
        },
      };

      const result = await resolver.detectConflict(state);
      expect(result.type).toBe('no_conflict');
    });
  });
});
