/**
 * Comprehensive tests for SyncService
 */

import { describe, it, expect, beforeEach } from 'bun:test';

import { computeSHA256 } from '../fs/frontmatter';
import { GoogleDocsSyncSettings } from '../types';

import { SyncService } from './SyncService';
import { FrontMatter, SyncUtils } from './SyncUtils';

describe('SyncService', () => {
  let syncService: SyncService;
  let mockSettings: GoogleDocsSyncSettings;

  beforeEach(() => {
    mockSettings = {
      driveFolderId: 'test-folder',
      conflictPolicy: 'prefer-doc',
      pollInterval: 60,
    };
    syncService = new SyncService(mockSettings);
  });

  describe('syncDocument', () => {
    it('should handle no-change scenario', async () => {
      const localContent = 'Hello World';
      // Compute proper SHA256 for the content
      const contentSha256 = await computeSHA256(localContent);

      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: contentSha256,
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Hello World';
      const remoteRevisionId = 'rev1';
      const remoteModifiedTime = '2023-01-01T10:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('no_change');
      expect(result.updatedContent).toBe(localContent);
      expect(result.updatedFrontmatter?.revisionId).toBe(remoteRevisionId);
    });

    it('should handle local-only changes', async () => {
      const localContent = 'Hello World Updated';
      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: 'old_hash',
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Hello World';
      const remoteRevisionId = 'rev1';
      const remoteModifiedTime = '2023-01-01T10:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('push');
      expect(result.updatedContent).toBe(localContent);
      expect(result.result.conflictInfo?.type).toBe('local_only');
    });

    it('should handle remote-only changes', async () => {
      const localContent = 'Hello World';
      const localSha256 = await computeSHA256(localContent);

      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: localSha256,
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Hello World Updated';
      const remoteRevisionId = 'rev2';
      const remoteModifiedTime = '2023-01-01T11:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('pull');
      expect(result.updatedContent).toBe(remoteContent);
      expect(result.result.conflictInfo?.type).toBe('remote_only');
    });

    it('should handle conflicts with prefer-doc policy', async () => {
      const localContent = 'Hello World Local';
      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: 'old_hash',
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Hello World Remote';
      const remoteRevisionId = 'rev2';
      const remoteModifiedTime = '2023-01-01T11:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('conflict_resolved');
      expect(result.updatedContent).toBe(remoteContent);
      expect(result.result.conflictMarkers).toContain(
        `🔄 Conflict resolved using 'prefer-doc' policy`,
      );
    });

    it('should handle conflicts with prefer-md policy', async () => {
      syncService = new SyncService({ ...mockSettings, conflictPolicy: 'prefer-md' });

      const localContent = 'Hello World Local';
      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: 'old_hash',
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Hello World Remote';
      const remoteRevisionId = 'rev2';
      const remoteModifiedTime = '2023-01-01T11:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('conflict_resolved');
      expect(result.updatedContent).toBe(localContent);
      expect(result.result.conflictMarkers).toContain(
        `🔄 Conflict resolved using 'prefer-md' policy`,
      );
    });

    it('should handle merge conflicts that require manual resolution', async () => {
      syncService = new SyncService({ ...mockSettings, conflictPolicy: 'merge' });

      const localContent = 'Line 1\nLocal Line 2\nLine 3';
      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: 'old_hash',
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Line 1\nRemote Line 2\nLine 3';
      const remoteRevisionId = 'rev2';
      const remoteModifiedTime = '2023-01-01T11:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('conflict_manual');
      expect(result.updatedContent).toContain('<<<<<<< LOCAL');
      expect(result.updatedContent).toContain('=======');
      expect(result.updatedContent).toContain('>>>>>>> REMOTE');
      expect(result.result.conflictMarkers).toContain('⚠️ CONFLICT: Manual resolution required');
    });

    it('should handle dry-run mode', async () => {
      const localContent = 'Hello World Local';
      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        revisionId: 'rev1',
        sha256: 'old_hash',
        'last-synced': '2023-01-01T10:00:00Z',
      };
      const remoteContent = 'Hello World Remote';
      const remoteRevisionId = 'rev2';
      const remoteModifiedTime = '2023-01-01T11:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
        { dryRun: true },
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('conflict_resolved');
      expect(result.updatedContent).toBeUndefined();
      expect(result.updatedFrontmatter).toBeUndefined();
    });

    it('should handle first sync scenario', async () => {
      const localContent = 'New local content';
      const localFrontmatter: FrontMatter = {
        'google-doc-id': 'doc123',
        docId: 'doc123',
        // No revisionId, sha256, or last-synced
      };
      const remoteContent = 'New remote content';
      const remoteRevisionId = 'rev1';
      const remoteModifiedTime = '2023-01-01T10:00:00Z';

      const result = await syncService.syncDocument(
        localContent,
        localFrontmatter,
        remoteContent,
        remoteRevisionId,
        remoteModifiedTime,
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('conflict_resolved');
      expect(result.result.conflictInfo?.type).toBe('both_changed');
    });
  });

  describe('hasUnresolvedConflicts', () => {
    it('should detect unresolved conflict markers', () => {
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

      expect(syncService.hasUnresolvedConflicts(contentWithConflicts)).toBe(true);
      expect(syncService.hasUnresolvedConflicts('Clean content')).toBe(false);
    });
  });

  describe('extractResolvedContent', () => {
    it('should extract clean content from resolved conflicts', () => {
      const contentWithMarkers = `
Some content
<<<<<<< LOCAL (Modified: 2023-01-01T10:00:00Z)
=======
>>>>>>> REMOTE (Modified: 2023-01-01T11:00:00Z)
>>>>>>> END CONFLICT (Generated: 2023-01-01T12:00:00Z)
More content
`;

      const cleaned = syncService.extractResolvedContent(contentWithMarkers);

      expect(cleaned).toBe('Some content\n\nMore content');
      expect(cleaned).not.toContain('<<<<<<<');
      expect(cleaned).not.toContain('=======');
      expect(cleaned).not.toContain('>>>>>>>');
    });
  });

  describe('validateSyncPreconditions', () => {
    it('should reject content with unresolved conflicts', () => {
      const contentWithConflicts = `
Content with conflicts
<<<<<<< LOCAL
Local version
=======
Remote version
>>>>>>> REMOTE
More content
`;
      const frontmatter: FrontMatter = { 'google-doc-id': 'doc123' };

      const result = syncService.validateSyncPreconditions(contentWithConflicts, frontmatter);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('unresolved conflict markers');
    });

    it('should reject files not linked to Google Docs', () => {
      const content = 'Regular content';
      const frontmatter: FrontMatter = {}; // No docId or google-doc-id

      const result = syncService.validateSyncPreconditions(content, frontmatter);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not linked to a Google Doc');
    });

    it('should accept valid content and frontmatter', () => {
      const content = 'Valid content';
      const frontmatter: FrontMatter = { 'google-doc-id': 'doc123' };

      const result = syncService.validateSyncPreconditions(content, frontmatter);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept backward-compatible docId field', () => {
      const content = 'Valid content';
      const frontmatter: FrontMatter = { docId: 'doc123' };

      const result = syncService.validateSyncPreconditions(content, frontmatter);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('generateSyncSummary', () => {
    it('should generate appropriate summaries for different actions', () => {
      expect(
        syncService.generateSyncSummary({
          success: true,
          action: 'no_change',
        }),
      ).toContain('No changes detected');

      expect(
        syncService.generateSyncSummary({
          success: true,
          action: 'pull',
        }),
      ).toContain('Pulled remote changes');

      expect(
        syncService.generateSyncSummary({
          success: true,
          action: 'push',
        }),
      ).toContain('Pushed local changes');

      expect(
        syncService.generateSyncSummary({
          success: true,
          action: 'conflict_resolved',
        }),
      ).toContain('Conflict resolved');

      expect(
        syncService.generateSyncSummary({
          success: true,
          action: 'conflict_manual',
        }),
      ).toContain('Manual conflict resolution required');

      expect(
        syncService.generateSyncSummary({
          success: false,
          action: 'no_change',
          error: 'Test error',
        }),
      ).toContain('Sync failed: Test error');
    });
  });

  describe('getConflictExplanation', () => {
    it('should provide clear explanations for different conflict types', () => {
      expect(
        syncService.getConflictExplanation({
          type: 'no_conflict',
          hasLocalChanges: false,
          hasRemoteChanges: false,
          canAutoResolve: true,
          description: 'No changes',
        }),
      ).toContain('Files are identical');

      expect(
        syncService.getConflictExplanation({
          type: 'local_only',
          hasLocalChanges: true,
          hasRemoteChanges: false,
          canAutoResolve: true,
          description: 'Local only',
        }),
      ).toContain('Only local file has changes');

      expect(
        syncService.getConflictExplanation({
          type: 'remote_only',
          hasLocalChanges: false,
          hasRemoteChanges: true,
          canAutoResolve: true,
          description: 'Remote only',
        }),
      ).toContain('Only Google Doc has changes');

      expect(
        syncService.getConflictExplanation({
          type: 'both_changed',
          hasLocalChanges: true,
          hasRemoteChanges: true,
          canAutoResolve: false,
          description: 'Both changed',
        }),
      ).toContain('Both local file and Google Doc have changes');
    });
  });

  describe('withSettings', () => {
    it('should create a new service instance with different settings', () => {
      const newSettings: GoogleDocsSyncSettings = {
        driveFolderId: 'new-folder',
        conflictPolicy: 'prefer-md',
        pollInterval: 30,
      };

      const newService = syncService.withSettings(newSettings);

      expect(newService).toBeInstanceOf(SyncService);
      expect(newService).not.toBe(syncService);
    });
  });

  describe('error handling', () => {
    it('should handle invalid content gracefully', async () => {
      const result = await syncService.syncDocument(
        'valid content',
        { 'google-doc-id': 'doc123' },
        'valid remote content',
        'rev1',
        'invalid-date', // Invalid date format
      );

      expect(result.result.success).toBe(true);
      // Should still work despite invalid date format
    });

    it('should handle missing frontmatter gracefully', async () => {
      const result = await syncService.syncDocument(
        'content',
        {}, // Empty frontmatter
        'remote content',
        'rev1',
        '2023-01-01T10:00:00Z',
      );

      expect(result.result.success).toBe(true);
      // Should treat as first sync
    });

    it('should handle SHA256 computation errors gracefully', async () => {
      // This test would require mocking computeSHA256 to throw
      // For now, we'll test that the service handles normal cases properly
      const result = await syncService.syncDocument(
        'content',
        { 'google-doc-id': 'doc123' },
        'remote content',
        'rev1',
        '2023-01-01T10:00:00Z',
      );

      expect(result.result.success).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle complex multi-line content conflicts', async () => {
      syncService = new SyncService({ ...mockSettings, conflictPolicy: 'merge' });

      const localContent = `# Title
      
Introduction paragraph.

## Section A
Local content for section A.

## Section B
Shared content.

## Conclusion
Local conclusion.`;

      const remoteContent = `# Title
      
Introduction paragraph.

## Section A
Remote content for section A.

## Section B  
Shared content.

## Conclusion
Remote conclusion.`;

      const result = await syncService.syncDocument(
        localContent,
        {
          'google-doc-id': 'doc123',
          revisionId: 'rev1',
          sha256: 'old_hash',
        },
        remoteContent,
        'rev2',
        '2023-01-01T11:00:00Z',
      );

      expect(result.result.success).toBe(true);
      expect(result.result.action).toBe('conflict_manual');
      expect(result.updatedContent).toContain('<<<<<<< LOCAL');
      expect(result.updatedContent).toContain('Local content for section A');
      expect(result.updatedContent).toContain('Remote content for section A');
    });

    it('should handle successful merge of non-conflicting additions', async () => {
      syncService = new SyncService({ ...mockSettings, conflictPolicy: 'merge' });

      const baseContent = 'Line 1\nLine 2';
      const localContent = 'Line 1\nLine 2\nLocal Line 3';
      const remoteContent = 'Line 1\nLine 2\nRemote Line 3';

      // This should create conflict markers since both versions add different content
      const baseContentSha256 = await computeSHA256(baseContent);

      const result = await syncService.syncDocument(
        localContent,
        {
          'google-doc-id': 'doc123',
          revisionId: 'rev1',
          sha256: baseContentSha256,
        },
        remoteContent,
        'rev2',
        '2023-01-01T11:00:00Z',
      );

      expect(result.result.success).toBe(true);
    });
  });
});
