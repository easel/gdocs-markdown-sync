import { Notice } from 'obsidian';

import { GoogleDocsSyncSettings as ImportedSettings } from '../types';

export interface GoogleDocsSyncSettings extends ImportedSettings {
  // Plugin-specific extensions can be added here
}

export interface SyncState {
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
  hasLocalMove: boolean;
  hasRemoteMove: boolean;
  hasLocalDelete: boolean;
  hasRemoteDelete: boolean;
  localMoveFrom?: string;
  remoteMoveFrom?: string;
  deleteReason?: 'local-deleted' | 'remote-deleted' | 'remote-trashed';
  remoteDeletedAt?: Date;
}

export interface OperationSummary {
  created: number;
  updated: number;
  skipped: number;
  conflicted: number;
  errors: number;
  total: number;
}

export interface EnhancedNotice {
  notice: Notice;
  update: (message: string) => void;
  hide: () => void;
}
