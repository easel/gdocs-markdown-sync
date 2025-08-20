// Tests for Obsidian plugin-specific features
import { describe, it, expect, beforeEach } from 'bun:test';

// Mock classes to simulate the plugin components we implemented
class MockChangeDetector {
  private localChanges = new Set<string>();
  private remoteChanges = new Set<string>();

  addLocalChange(filePath: string) {
    this.localChanges.add(filePath);
  }

  addRemoteChange(filePath: string) {
    this.remoteChanges.add(filePath);
  }

  hasLocalChanges(filePath: string): boolean {
    return this.localChanges.has(filePath);
  }

  hasRemoteChanges(filePath: string): boolean {
    return this.remoteChanges.has(filePath);
  }

  getChangeType(filePath: string): 'none' | 'local' | 'remote' | 'both' {
    const hasLocal = this.hasLocalChanges(filePath);
    const hasRemote = this.hasRemoteChanges(filePath);

    if (hasLocal && hasRemote) return 'both';
    if (hasLocal) return 'local';
    if (hasRemote) return 'remote';
    return 'none';
  }

  clearChanges(filePath: string) {
    this.localChanges.delete(filePath);
    this.remoteChanges.delete(filePath);
  }
}

describe('Plugin Features', () => {
  describe('ChangeDetector', () => {
    let detector: MockChangeDetector;

    beforeEach(() => {
      detector = new MockChangeDetector();
    });

    it('should detect local changes correctly', () => {
      const filePath = 'test.md';

      expect(detector.hasLocalChanges(filePath)).toBe(false);

      detector.addLocalChange(filePath);
      expect(detector.hasLocalChanges(filePath)).toBe(true);
    });

    it('should detect remote changes correctly', () => {
      const filePath = 'test.md';

      expect(detector.hasRemoteChanges(filePath)).toBe(false);

      detector.addRemoteChange(filePath);
      expect(detector.hasRemoteChanges(filePath)).toBe(true);
    });

    it('should determine correct change types', () => {
      const filePath = 'test.md';

      // No changes
      expect(detector.getChangeType(filePath)).toBe('none');

      // Local changes only
      detector.addLocalChange(filePath);
      expect(detector.getChangeType(filePath)).toBe('local');

      // Clear and add remote changes
      detector.clearChanges(filePath);
      detector.addRemoteChange(filePath);
      expect(detector.getChangeType(filePath)).toBe('remote');

      // Both local and remote changes
      detector.addLocalChange(filePath);
      expect(detector.getChangeType(filePath)).toBe('both');
    });

    it('should clear changes correctly', () => {
      const filePath = 'test.md';

      detector.addLocalChange(filePath);
      detector.addRemoteChange(filePath);

      expect(detector.hasLocalChanges(filePath)).toBe(true);
      expect(detector.hasRemoteChanges(filePath)).toBe(true);

      detector.clearChanges(filePath);

      expect(detector.hasLocalChanges(filePath)).toBe(false);
      expect(detector.hasRemoteChanges(filePath)).toBe(false);
    });

    it('should handle multiple files independently', () => {
      const file1 = 'file1.md';
      const file2 = 'file2.md';

      detector.addLocalChange(file1);
      detector.addRemoteChange(file2);

      expect(detector.getChangeType(file1)).toBe('local');
      expect(detector.getChangeType(file2)).toBe('remote');

      detector.clearChanges(file1);

      expect(detector.getChangeType(file1)).toBe('none');
      expect(detector.getChangeType(file2)).toBe('remote');
    });
  });

  describe('Smart Sync Functionality', () => {
    let detector: MockChangeDetector;

    beforeEach(() => {
      detector = new MockChangeDetector();
    });

    it('should determine available sync actions correctly', () => {
      const filePath = 'test.md';

      const getAvailableActions = (path: string) => {
        const changeType = detector.getChangeType(path);
        const actions: string[] = [];

        if (changeType === 'local' || changeType === 'both') {
          actions.push('push');
        }
        if (changeType === 'remote' || changeType === 'both') {
          actions.push('pull');
        }
        if (changeType === 'both') {
          actions.push('sync');
        }

        return actions;
      };

      // No changes - no actions available
      expect(getAvailableActions(filePath)).toEqual([]);

      // Local changes - push available
      detector.addLocalChange(filePath);
      expect(getAvailableActions(filePath)).toEqual(['push']);

      // Add remote changes - push, pull, and sync available
      detector.addRemoteChange(filePath);
      expect(getAvailableActions(filePath)).toEqual(['push', 'pull', 'sync']);

      // Only remote changes - pull available
      detector.clearChanges(filePath);
      detector.addRemoteChange(filePath);
      expect(getAvailableActions(filePath)).toEqual(['pull']);
    });

    it('should generate correct ribbon icon classes', () => {
      const filePath = 'test.md';

      const getRibbonIconClass = (path: string) => {
        const changeType = detector.getChangeType(path);
        switch (changeType) {
          case 'local':
            return 'sync-local';
          case 'remote':
            return 'sync-remote';
          case 'both':
            return 'sync-both';
          default:
            return 'sync-none';
        }
      };

      expect(getRibbonIconClass(filePath)).toBe('sync-none');

      detector.addLocalChange(filePath);
      expect(getRibbonIconClass(filePath)).toBe('sync-local');

      detector.addRemoteChange(filePath);
      expect(getRibbonIconClass(filePath)).toBe('sync-both');

      detector.clearChanges(filePath);
      detector.addRemoteChange(filePath);
      expect(getRibbonIconClass(filePath)).toBe('sync-remote');
    });
  });

  describe('Contextual Menu Logic', () => {
    let detector: MockChangeDetector;

    beforeEach(() => {
      detector = new MockChangeDetector();
    });

    it('should show appropriate menu items based on change state', () => {
      const filePath = 'test.md';

      const getContextMenuItems = (path: string) => {
        const changeType = detector.getChangeType(path);
        const items: Array<{ id: string; title: string }> = [];

        if (changeType === 'local') {
          items.push({ id: 'push', title: 'Push to Google Docs ↑' });
        } else if (changeType === 'remote') {
          items.push({ id: 'pull', title: 'Pull from Google Docs ↓' });
        } else if (changeType === 'both') {
          items.push({ id: 'push', title: 'Push to Google Docs ↑' });
          items.push({ id: 'pull', title: 'Pull from Google Docs ↓' });
          items.push({ id: 'sync', title: 'Sync ↕' });
        }

        return items;
      };

      // No changes - no menu items
      expect(getContextMenuItems(filePath)).toEqual([]);

      // Local changes - push option
      detector.addLocalChange(filePath);
      expect(getContextMenuItems(filePath)).toEqual([
        { id: 'push', title: 'Push to Google Docs ↑' },
      ]);

      // Remote changes - pull option
      detector.clearChanges(filePath);
      detector.addRemoteChange(filePath);
      expect(getContextMenuItems(filePath)).toEqual([
        { id: 'pull', title: 'Pull from Google Docs ↓' },
      ]);

      // Both changes - all options
      detector.addLocalChange(filePath);
      expect(getContextMenuItems(filePath)).toEqual([
        { id: 'push', title: 'Push to Google Docs ↑' },
        { id: 'pull', title: 'Pull from Google Docs ↓' },
        { id: 'sync', title: 'Sync ↕' },
      ]);
    });
  });
});
