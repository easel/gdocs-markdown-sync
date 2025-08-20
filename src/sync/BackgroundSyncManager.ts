/**
 * Background Sync Manager for Obsidian Plugin
 *
 * Provides reliable background synchronization with:
 * - Reentrancy protection to prevent overlapping sync operations
 * - Exponential backoff for Drive API failures
 * - User control via settings toggle
 * - Performance optimization with debouncing and batching
 * - Comprehensive error recovery and user feedback
 */

import { Notice, TFile, App } from 'obsidian';

import { GoogleDocsSyncSettings } from '../types';

import { SyncService } from './SyncService';

export interface BackgroundSyncState {
  isRunning: boolean;
  lastSyncAttempt: number;
  lastSuccessfulSync: number;
  consecutiveFailures: number;
  currentBackoffMs: number;
  queuedFiles: Set<string>;
  failedFiles: Map<string, { error: string; timestamp: number; retryCount: number }>;
}

export interface SyncBatch {
  files: TFile[];
  timestamp: number;
}

export interface BackgroundSyncSettings {
  enabled: boolean;
  pollIntervalMs: number;
  maxBackoffMs: number;
  minBackoffMs: number;
  backoffMultiplier: number;
  maxRetries: number;
  debounceMs: number;
  batchSizeLimit: number;
  silentMode: boolean; // Reduce user notifications for background operations
}

export class BackgroundSyncManager {
  private app: App;
  private backgroundSettings: BackgroundSyncSettings;
  private state: BackgroundSyncState;

  private syncTimer: number | null = null;
  private debounceTimer: number | null = null;
  private isDestroyed = false;

  // File change tracking
  private fileChangeQueue: Map<string, number> = new Map();
  private pendingBatch: TFile[] = [];

  // Plugin integration - set via setPluginIntegration
  private pluginIntegration: {
    performSmartSync: (file: TFile) => Promise<void>;
    hasGoogleDocsMetadata: (file: TFile) => boolean;
  } | null = null;

  constructor(
    app: App,
    _syncService: SyncService,
    settings: GoogleDocsSyncSettings,
    backgroundSettings?: Partial<BackgroundSyncSettings>,
  ) {
    this.app = app;

    // Default background sync settings
    this.backgroundSettings = {
      enabled: true,
      pollIntervalMs: (settings.pollInterval || 60) * 1000,
      maxBackoffMs: 300000, // 5 minutes
      minBackoffMs: 1000, // 1 second
      backoffMultiplier: 2,
      maxRetries: 3,
      debounceMs: 5000, // 5 seconds
      batchSizeLimit: 10,
      silentMode: false,
      ...backgroundSettings,
    };

    this.state = {
      isRunning: false,
      lastSyncAttempt: 0,
      lastSuccessfulSync: 0,
      consecutiveFailures: 0,
      currentBackoffMs: this.backgroundSettings.minBackoffMs,
      queuedFiles: new Set(),
      failedFiles: new Map(),
    };
  }

  /**
   * Set plugin integration methods for actual sync operations
   */
  setPluginIntegration(integration: {
    performSmartSync: (file: TFile) => Promise<void>;
    hasGoogleDocsMetadata: (file: TFile) => boolean;
  }): void {
    this.pluginIntegration = integration;
  }

  /**
   * Start background sync with reentrancy protection
   */
  start(): void {
    if (!this.backgroundSettings.enabled || this.isDestroyed) {
      return;
    }

    this.stop(); // Ensure clean state
    this.scheduleNextSync();

    if (!this.backgroundSettings.silentMode) {
      new Notice('Background sync started', 2000);
    }
  }

  /**
   * Stop background sync and clear all timers
   */
  stop(): void {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.state.isRunning = false;
    this.pendingBatch = [];
    this.fileChangeQueue.clear();

    if (!this.backgroundSettings.silentMode) {
      new Notice('Background sync stopped', 2000);
    }
  }

  /**
   * Destroy the manager and clean up all resources
   */
  destroy(): void {
    this.isDestroyed = true;
    this.stop();
    this.state.queuedFiles.clear();
    this.state.failedFiles.clear();
  }

  /**
   * Update settings and restart if needed
   */
  updateSettings(
    settings: GoogleDocsSyncSettings,
    backgroundSettings?: Partial<BackgroundSyncSettings>,
  ): void {
    if (backgroundSettings) {
      this.backgroundSettings = {
        ...this.backgroundSettings,
        ...backgroundSettings,
        pollIntervalMs: (settings.pollInterval || 60) * 1000,
      };
    } else {
      this.backgroundSettings.pollIntervalMs = (settings.pollInterval || 60) * 1000;
    }

    // Restart if enabled and was running
    if (this.backgroundSettings.enabled && this.syncTimer) {
      this.start();
    } else if (!this.backgroundSettings.enabled) {
      this.stop();
    }
  }

  /**
   * Queue a file for background sync with debouncing
   */
  queueFile(file: TFile): void {
    if (!this.backgroundSettings.enabled || this.isDestroyed) {
      return;
    }

    // Add to change queue with timestamp
    this.fileChangeQueue.set(file.path, Date.now());
    this.state.queuedFiles.add(file.path);

    // Debounce rapid changes
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.processBatchQueue();
    }, this.backgroundSettings.debounceMs);
  }

  /**
   * Force sync now (bypass debouncing and backoff)
   */
  async forceSyncNow(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    this.resetBackoff();
    await this.performSync(true);
  }

  /**
   * Get current sync status
   */
  getSyncStatus(): {
    isRunning: boolean;
    enabled: boolean;
    lastSync: Date | null;
    queuedCount: number;
    failedCount: number;
    nextSyncIn: number | null;
  } {
    let nextSyncIn: number | null = null;

    if (this.syncTimer && this.backgroundSettings.enabled) {
      const now = Date.now();
      const nextSync = this.state.lastSyncAttempt + this.getCurrentSyncInterval();
      nextSyncIn = Math.max(0, nextSync - now);
    }

    return {
      isRunning: this.state.isRunning,
      enabled: this.backgroundSettings.enabled,
      lastSync: this.state.lastSuccessfulSync > 0 ? new Date(this.state.lastSuccessfulSync) : null,
      queuedCount: this.state.queuedFiles.size,
      failedCount: this.state.failedFiles.size,
      nextSyncIn,
    };
  }

  private scheduleNextSync(): void {
    if (!this.backgroundSettings.enabled || this.isDestroyed) {
      return;
    }

    const interval = this.getCurrentSyncInterval();

    this.syncTimer = window.setTimeout(async () => {
      if (!this.isDestroyed) {
        await this.performSync();
        if (!this.isDestroyed && this.backgroundSettings.enabled) {
          this.scheduleNextSync();
        }
      }
    }, interval);
  }

  private getCurrentSyncInterval(): number {
    // Use backoff interval if we have failures, otherwise use normal poll interval
    return this.state.consecutiveFailures > 0
      ? Math.min(this.state.currentBackoffMs, this.backgroundSettings.maxBackoffMs)
      : this.backgroundSettings.pollIntervalMs;
  }

  private async performSync(force = false): Promise<void> {
    // Reentrancy protection
    if (this.state.isRunning && !force) {
      console.log('BackgroundSyncManager: Sync already running, skipping');
      return;
    }

    this.state.isRunning = true;
    this.state.lastSyncAttempt = Date.now();

    try {
      const filesToSync = await this.getFilesToSync();

      if (filesToSync.length === 0) {
        this.state.isRunning = false;
        return;
      }

      console.log(`BackgroundSyncManager: Syncing ${filesToSync.length} files`);

      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      // Process files in batches
      const batches = this.createBatches(filesToSync);

      for (const batch of batches) {
        if (this.isDestroyed) break;

        const results = await Promise.allSettled(
          batch.files.map((file) => this.syncSingleFile(file)),
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const file = batch.files[i];

          if (result.status === 'fulfilled' && result.value.success) {
            successCount++;
            this.state.queuedFiles.delete(file.path);
            this.state.failedFiles.delete(file.path);
          } else {
            errorCount++;
            const error =
              result.status === 'rejected'
                ? result.reason?.message || 'Unknown error'
                : result.value.error || 'Sync failed';

            this.handleFileError(file, error);
            errors.push(`${file.name}: ${error}`);
          }
        }
      }

      // Update state based on results
      if (errorCount === 0) {
        this.onSyncSuccess(successCount);
      } else {
        this.onSyncFailure(errorCount, errors);
      }
    } catch (error) {
      console.error('BackgroundSyncManager: Sync failed:', error);
      this.onSyncFailure(1, [(error as Error).message]);
    } finally {
      this.state.isRunning = false;
    }
  }

  private async getFilesToSync(): Promise<TFile[]> {
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const filesToCheck: TFile[] = [];

    // Include queued files and files that need periodic sync
    for (const file of allMarkdownFiles) {
      if (this.state.queuedFiles.has(file.path) || this.shouldCheckFile(file)) {
        filesToCheck.push(file);
      }
    }

    return filesToCheck;
  }

  private shouldCheckFile(file: TFile): boolean {
    // Only check files with Google Docs metadata during background sync
    if (this.pluginIntegration) {
      return this.pluginIntegration.hasGoogleDocsMetadata(file);
    }

    // Fallback to metadata cache check
    const cache = this.app.metadataCache.getFileCache(file);
    return !!(cache?.frontmatter && cache.frontmatter['google-doc-id']);
  }

  private createBatches(files: TFile[]): SyncBatch[] {
    const batches: SyncBatch[] = [];

    for (let i = 0; i < files.length; i += this.backgroundSettings.batchSizeLimit) {
      const batch = files.slice(i, i + this.backgroundSettings.batchSizeLimit);
      batches.push({
        files: batch,
        timestamp: Date.now(),
      });
    }

    return batches;
  }

  private async syncSingleFile(file: TFile): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.pluginIntegration) {
        console.warn(`BackgroundSyncManager: No plugin integration set, skipping ${file.path}`);
        return { success: false, error: 'Plugin integration not available' };
      }

      console.log(`BackgroundSyncManager: Syncing file ${file.path}`);

      // Use the plugin's performSmartSync method for actual sync operation
      await this.pluginIntegration.performSmartSync(file);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private handleFileError(file: TFile, error: string): void {
    const existing = this.state.failedFiles.get(file.path);
    const retryCount = existing ? existing.retryCount + 1 : 1;

    this.state.failedFiles.set(file.path, {
      error,
      timestamp: Date.now(),
      retryCount,
    });

    // Remove from failed files if max retries exceeded
    if (retryCount >= this.backgroundSettings.maxRetries) {
      console.warn(`BackgroundSyncManager: Max retries exceeded for ${file.path}: ${error}`);
      this.state.failedFiles.delete(file.path);
      this.state.queuedFiles.delete(file.path);
    }
  }

  private processBatchQueue(): void {
    const now = Date.now();
    const filesToAdd: TFile[] = [];

    // Process queued file changes
    for (const [filePath, changeTime] of this.fileChangeQueue.entries()) {
      if (now - changeTime >= this.backgroundSettings.debounceMs) {
        const file = this.app.vault.getFileByPath(filePath);
        if (file instanceof TFile && file.extension === 'md') {
          filesToAdd.push(file);
        }
        this.fileChangeQueue.delete(filePath);
      }
    }

    if (filesToAdd.length > 0) {
      this.pendingBatch.push(...filesToAdd);
      // Limit batch size
      if (this.pendingBatch.length > this.backgroundSettings.batchSizeLimit) {
        this.pendingBatch = this.pendingBatch.slice(0, this.backgroundSettings.batchSizeLimit);
      }
    }
  }

  private onSyncSuccess(successCount: number): void {
    this.state.consecutiveFailures = 0;
    this.state.currentBackoffMs = this.backgroundSettings.minBackoffMs;
    this.state.lastSuccessfulSync = Date.now();

    if (successCount > 0 && !this.backgroundSettings.silentMode) {
      new Notice(`Background sync: ${successCount} files updated`, 2000);
    }

    console.log(`BackgroundSyncManager: Sync successful, ${successCount} files processed`);
  }

  private onSyncFailure(errorCount: number, errors: string[]): void {
    this.state.consecutiveFailures++;
    this.state.currentBackoffMs = Math.min(
      this.state.currentBackoffMs * this.backgroundSettings.backoffMultiplier,
      this.backgroundSettings.maxBackoffMs,
    );

    console.error(`BackgroundSyncManager: Sync failed for ${errorCount} files:`, errors);

    // Only show error notice if not in silent mode and this isn't just a temporary failure
    if (!this.backgroundSettings.silentMode && this.state.consecutiveFailures >= 3) {
      new Notice(`Background sync issues detected. Check console for details.`, 5000);
    }
  }

  private resetBackoff(): void {
    this.state.consecutiveFailures = 0;
    this.state.currentBackoffMs = this.backgroundSettings.minBackoffMs;
  }
}
