/**
 * Sync Status Manager for Background Sync Operations
 *
 * Provides visual indicators and user feedback for background sync status:
 * - Status bar integration with sync state
 * - Error recovery mechanisms and user guidance
 * - Progress indicators for batch operations
 * - Clear communication of sync issues and resolutions
 */

import { Notice } from 'obsidian';

import { SyncError, SyncErrorType } from './BackgroundSyncErrors';
import { BackgroundSyncState } from './BackgroundSyncManager';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'disabled';
  message: string;
  details: string;
  timestamp: Date;
  errorInfo?: {
    type: SyncErrorType;
    message: string;
    canRecover: boolean;
    userAction?: string;
  };
}

export interface SyncProgress {
  current: number;
  total: number;
  currentFile?: string;
  operation: 'pull' | 'push' | 'sync';
}

export class SyncStatusManager {
  private statusBarElement: HTMLElement | null = null;
  private currentStatus: SyncStatus;
  private progressNotice: Notice | null = null;
  private lastErrorNotification: number = 0;
  private readonly ERROR_NOTIFICATION_COOLDOWN = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.currentStatus = {
      state: 'idle',
      message: 'Background sync ready',
      details: 'Waiting for changes to sync',
      timestamp: new Date(),
    };
  }

  /**
   * Set the status bar element to update
   */
  setStatusBarElement(element: HTMLElement): void {
    this.statusBarElement = element;
    this.updateStatusBarDisplay();
  }

  /**
   * Update status based on background sync state
   */
  updateFromBackgroundState(syncState: BackgroundSyncState, enabled: boolean): void {
    if (!enabled) {
      this.setStatus({
        state: 'disabled',
        message: 'Background sync disabled',
        details: 'Enable in settings to start background sync',
        timestamp: new Date(),
      });
      return;
    }

    if (syncState.isRunning) {
      this.setStatus({
        state: 'syncing',
        message: 'Syncing in background',
        details: this.getSyncingDetails(syncState),
        timestamp: new Date(),
      });
    } else if (syncState.consecutiveFailures > 0) {
      const nextSyncIn = this.getNextSyncTime(syncState);
      this.setStatus({
        state: 'error',
        message: 'Background sync issues',
        details: `${syncState.consecutiveFailures} consecutive failures. Next attempt: ${nextSyncIn}`,
        timestamp: new Date(),
      });
    } else {
      const lastSyncText =
        syncState.lastSuccessfulSync > 0
          ? this.formatLastSync(syncState.lastSuccessfulSync)
          : 'Never';

      this.setStatus({
        state: 'idle',
        message: 'Background sync active',
        details: `Last sync: ${lastSyncText}. ${syncState.queuedFiles.size} files queued`,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Set sync progress for batch operations
   */
  setProgress(progress: SyncProgress | null): void {
    if (progress) {
      const percent = Math.round((progress.current / progress.total) * 100);
      const statusText = `${progress.operation}: ${progress.current}/${progress.total} (${percent}%)`;

      // Update or create progress notice
      if (this.progressNotice) {
        this.progressNotice.setMessage(statusText);
      } else {
        this.progressNotice = new Notice(statusText, 0);
      }

      // Update status bar
      if (this.statusBarElement) {
        this.statusBarElement.setText(statusText);
      }
    } else {
      // Clear progress
      if (this.progressNotice) {
        this.progressNotice.hide();
        this.progressNotice = null;
      }
      this.updateStatusBarDisplay();
    }
  }

  /**
   * Handle sync error and provide user feedback
   */
  handleSyncError(error: SyncError, fileName?: string): void {
    console.error('Background sync error:', error);

    // Update status with error information
    this.setStatus({
      state: 'error',
      message: 'Sync error occurred',
      details: fileName
        ? `Error in ${fileName}: ${error.getUserMessage()}`
        : error.getUserMessage(),
      timestamp: new Date(),
      errorInfo: {
        type: error.errorType,
        message: error.getUserMessage(),
        canRecover: error.errorInfo.isTemporary,
        userAction: this.getUserActionForError(error),
      },
    });

    // Show user notification if appropriate
    this.maybeShowErrorNotification(error, fileName);
  }

  /**
   * Handle auth errors with specific recovery guidance
   */
  handleAuthError(error: SyncError): void {
    this.setStatus({
      state: 'error',
      message: 'Authentication required',
      details: error.getUserMessage(),
      timestamp: new Date(),
      errorInfo: {
        type: error.errorType,
        message: error.getUserMessage(),
        canRecover: false,
        userAction: 'Go to plugin settings and re-authenticate',
      },
    });

    // Always notify for auth errors
    new Notice(`🔐 ${error.getUserMessage()}\n\nGo to plugin settings to re-authenticate.`, 10000);
  }

  /**
   * Show success notification for completed sync operations
   */
  showSyncSuccess(fileCount: number, operation: 'pull' | 'push' | 'sync' = 'sync'): void {
    if (fileCount > 0) {
      const message = `Background ${operation}: ${fileCount} files updated`;
      new Notice(`✅ ${message}`, 3000);

      this.setStatus({
        state: 'idle',
        message: 'Sync completed',
        details: message,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Get current sync status
   */
  getCurrentStatus(): SyncStatus {
    return { ...this.currentStatus };
  }

  /**
   * Reset status to idle state
   */
  reset(): void {
    this.setStatus({
      state: 'idle',
      message: 'Background sync ready',
      details: 'Waiting for changes to sync',
      timestamp: new Date(),
    });
  }

  private setStatus(status: SyncStatus): void {
    this.currentStatus = status;
    this.updateStatusBarDisplay();
  }

  private updateStatusBarDisplay(): void {
    if (!this.statusBarElement) return;

    const { state, message } = this.currentStatus;

    // Clear existing classes
    this.statusBarElement.classList.remove(
      'sync-idle',
      'sync-syncing',
      'sync-error',
      'sync-disabled',
    );

    // Add status-specific class
    this.statusBarElement.classList.add(`sync-${state}`);

    // Set text with appropriate icon
    const icon = this.getStatusIcon(state);
    this.statusBarElement.setText(`${icon} ${message}`);

    // Update title with details
    this.statusBarElement.setAttribute('title', this.currentStatus.details);
  }

  private getStatusIcon(state: string): string {
    switch (state) {
      case 'syncing':
        return '🔄';
      case 'error':
        return '⚠️';
      case 'disabled':
        return '⏸️';
      default:
        return '📄';
    }
  }

  private getSyncingDetails(syncState: BackgroundSyncState): string {
    const queuedCount = syncState.queuedFiles.size;
    const failedCount = syncState.failedFiles.size;

    let details = 'Processing files';
    if (queuedCount > 0) {
      details += `, ${queuedCount} queued`;
    }
    if (failedCount > 0) {
      details += `, ${failedCount} failed`;
    }

    return details;
  }

  private getNextSyncTime(syncState: BackgroundSyncState): string {
    const now = Date.now();
    const nextAttempt = syncState.lastSyncAttempt + syncState.currentBackoffMs;
    const msUntilNext = Math.max(0, nextAttempt - now);

    if (msUntilNext < 60000) {
      return `${Math.round(msUntilNext / 1000)}s`;
    } else {
      return `${Math.round(msUntilNext / 60000)}m`;
    }
  }

  private formatLastSync(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;

    if (diffMs < 60000) {
      return 'Just now';
    } else if (diffMs < 3600000) {
      return `${Math.round(diffMs / 60000)}m ago`;
    } else if (diffMs < 86400000) {
      return `${Math.round(diffMs / 3600000)}h ago`;
    } else {
      return new Date(timestamp).toLocaleDateString();
    }
  }

  private getUserActionForError(error: SyncError): string | undefined {
    switch (error.errorType) {
      case SyncErrorType.AUTH_EXPIRED:
      case SyncErrorType.AUTH_INVALID:
        return 'Go to plugin settings and re-authenticate';
      case SyncErrorType.PERMISSION_DENIED:
        return 'Check your Google Drive permissions';
      case SyncErrorType.DOCUMENT_NOT_FOUND:
        return 'Check if the document still exists in Google Drive';
      case SyncErrorType.CONTENT_TOO_LARGE:
        return 'Reduce document size or split into smaller files';
      case SyncErrorType.RATE_LIMITED:
        return 'Wait for rate limit to reset (sync will retry automatically)';
      default:
        return undefined;
    }
  }

  private maybeShowErrorNotification(error: SyncError, fileName?: string): void {
    const now = Date.now();

    // Don't spam notifications - use cooldown period
    if (now - this.lastErrorNotification < this.ERROR_NOTIFICATION_COOLDOWN) {
      return;
    }

    // Only show notifications for errors that require user attention
    if (!error.shouldNotifyUser()) {
      return;
    }

    this.lastErrorNotification = now;

    const message = fileName
      ? `Sync error in ${fileName}: ${error.getUserMessage()}`
      : `Background sync error: ${error.getUserMessage()}`;

    const userAction = this.getUserActionForError(error);
    const fullMessage = userAction ? `${message}\n\n${userAction}` : message;

    new Notice(fullMessage, 8000);
  }
}
