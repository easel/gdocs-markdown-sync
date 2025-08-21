import { App, PluginSettingTab, Setting } from 'obsidian';

import type GoogleDocsSyncPlugin from './plugin-main';
import { getBuildVersion } from './version';

export class GoogleDocsSyncSettingsTab extends PluginSettingTab {
  plugin: GoogleDocsSyncPlugin;
  private authStatusDiv: HTMLElement | null = null;
  private authButton: HTMLElement | null = null;

  constructor(app: App, plugin: GoogleDocsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Register this settings tab with the plugin for auth callbacks
    (plugin as any).settingsTab = this;
  }

  async display(): Promise<void> {
    const { containerEl } = this;

    containerEl.empty();

    // Plugin header with version
    const headerEl = containerEl.createEl('div', { cls: 'google-docs-sync-header' });
    const titleContainer = headerEl.createEl('div', { cls: 'google-docs-sync-title-container' });
    titleContainer.createEl('h2', { text: 'Google Docs Sync Settings' });
    const versionEl = titleContainer.createEl('span', { 
      cls: 'google-docs-sync-version',
      text: `v${getBuildVersion()}`
    });

    // Authentication Status & Controls (consolidated at top)
    await this.displayAuthenticationStatus(containerEl);

    containerEl.createEl('h3', { text: 'Google Drive Configuration' });

    new Setting(containerEl)
      .setName('Drive Folder ID')
      .setDesc('The Google Drive folder ID to sync with')
      .addText((text) =>
        text
          .setPlaceholder('Enter your Google Drive folder ID')
          .setValue(this.plugin.settings.driveFolderId)
          .onChange(async (value) => {
            this.plugin.settings.driveFolderId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Base Vault Folder')
      .setDesc('Vault subfolder where synced files are stored (e.g., Google Docs)')
      .addText((text) =>
        text
          .setPlaceholder('Google Docs')
          .setValue(this.plugin.settings.baseVaultFolder || '')
          .onChange(async (value) => {
            this.plugin.settings.baseVaultFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Conflict Policy')
      .setDesc('How to handle conflicts between local and remote changes')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('last-write-wins', 'Last Write Wins (default)')
          .addOption('prefer-doc', 'Prefer Google Doc')
          .addOption('prefer-md', 'Prefer Markdown')
          .addOption('merge', 'Intelligent Merge')
          .setValue(this.plugin.settings.conflictPolicy)
          .onChange(async (value) => {
            this.plugin.settings.conflictPolicy = value as any;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Background Sync' });

    new Setting(containerEl)
      .setName('Enable Background Sync')
      .setDesc('Automatically sync documents in the background')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.backgroundSyncEnabled === true)
          .onChange(async (value) => {
            this.plugin.settings.backgroundSyncEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Poll Interval')
      .setDesc('How often to check for changes in the background (in seconds)')
      .addText((text) =>
        text.setValue(this.plugin.settings.pollInterval.toString()).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num)) {
            this.plugin.settings.pollInterval = num;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Silent Background Mode')
      .setDesc('Reduce notifications for background sync operations')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.backgroundSyncSilentMode === true)
          .onChange(async (value) => {
            this.plugin.settings.backgroundSyncSilentMode = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Move and Delete Handling' });

    new Setting(containerEl)
      .setName('Sync Moves')
      .setDesc('Automatically sync file moves between vault and Google Drive')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncMoves === true)
          .onChange(async (value) => {
            this.plugin.settings.syncMoves = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Delete Handling')
      .setDesc('How to handle when files are deleted on either side')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('archive', 'Archive (Safe - move to trash folders)')
          .addOption('ignore', 'Ignore (Do nothing)')
          .addOption('sync', 'Sync (Dangerous - delete on both sides)')
          .setValue(this.plugin.settings.deleteHandling || 'archive')
          .onChange(async (value: 'archive' | 'ignore' | 'sync') => {
            this.plugin.settings.deleteHandling = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Archive Retention')
      .setDesc('Days to keep archived files before permanent deletion (0 = keep forever)')
      .addText((text) =>
        text
          .setPlaceholder('30')
          .setValue((this.plugin.settings.archiveRetentionDays || 30).toString())
          .onChange(async (value) => {
            const days = parseInt(value, 10);
            if (!isNaN(days) && days >= 0) {
              this.plugin.settings.archiveRetentionDays = days;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName('Show Deletion Warnings')
      .setDesc('Show confirmation dialogs for deletion operations')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDeletionWarnings === true)
          .onChange(async (value) => {
            this.plugin.settings.showDeletionWarnings = value;
            await this.plugin.saveSettings();
          }),
      );

    // Background sync status and controls
    const statusSetting = new Setting(containerEl)
      .setName('Background Sync Status')
      .setDesc('View current sync status and manage background operations');

    // Add status display
    const statusEl = statusSetting.descEl.createDiv({ cls: 'sync-status-display' });
    this.updateSyncStatusDisplay(statusEl);

    // Add control buttons
    statusSetting
      .addButton((button) =>
        button
          .setButtonText('View Status')
          .setTooltip('Show detailed background sync status')
          .onClick(() => {
            this.plugin.showSyncStatus();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Sync Now')
          .setTooltip('Sync all documents (bidirectional)')
          .setCta()
          .onClick(async () => {
            await this.plugin.syncAllDocuments();
            // Update display after a moment
            setTimeout(() => this.updateSyncStatusDisplay(statusEl), 1000);
          }),
      )
      .addButton((button) => {
        const isEnabled = this.plugin.settings.backgroundSyncEnabled === true;
        return button
          .setButtonText(isEnabled ? 'Disable' : 'Enable')
          .setTooltip(`${isEnabled ? 'Disable' : 'Enable'} background sync`)
          .onClick(async () => {
            await this.plugin.toggleBackgroundSync();
            this.display(); // Refresh the entire settings display
          });
      });


    // Advanced OAuth Configuration Section (at bottom, collapsed by default)
    const advancedHeader = containerEl.createEl('h3', { text: '▶ Advanced OAuth Configuration' });
    advancedHeader.style.cursor = 'pointer';
    advancedHeader.style.userSelect = 'none';
    
    const advancedContent = containerEl.createDiv();
    advancedContent.style.display = 'none';
    
    const oauthDescription = advancedContent.createDiv({ cls: 'oauth-description' });
    oauthDescription.createEl('p', { 
      text: 'Default OAuth credentials are provided. Only modify these if you want to use your own Google Cloud OAuth client.'
    });

    new Setting(advancedContent)
      .setName('OAuth Client ID')
      .setDesc('Google OAuth Client ID for authentication')
      .addText((text) =>
        text
          .setPlaceholder('Google OAuth Client ID')
          .setValue(this.plugin.settings.clientId || '')
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim() || undefined;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedContent)
      .setName('OAuth Client Secret')
      .setDesc('Google OAuth Client Secret for authentication')
      .addText((text) =>
        text
          .setPlaceholder('Google OAuth Client Secret')
          .setValue(this.plugin.settings.clientSecret || '')
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim() || undefined;
            await this.plugin.saveSettings();
          }),
      );

    // Add toggle functionality
    advancedHeader.addEventListener('click', () => {
      const isHidden = advancedContent.style.display === 'none';
      advancedContent.style.display = isHidden ? 'block' : 'none';
      advancedHeader.textContent = isHidden ? '▼ Advanced OAuth Configuration' : '▶ Advanced OAuth Configuration';
    });
  }

  /**
   * Display authentication status at the top of settings
   */
  private async displayAuthenticationStatus(containerEl: HTMLElement): Promise<void> {
    const statusSection = containerEl.createDiv({ cls: 'auth-status-section' });
    statusSection.createEl('h3', { text: 'Authentication' });

    this.authStatusDiv = statusSection.createDiv({ cls: 'auth-status-display' });
    await this.updateAuthStatus();
  }

  /**
   * Update authentication status display
   */
  private async updateAuthStatus(): Promise<void> {
    if (!this.authStatusDiv) return;

    this.authStatusDiv.empty();

    try {
      const status = await this.plugin.getAuthStatus();

      if (status.isAuthenticated) {
        this.authStatusDiv.className = 'auth-status-display authenticated';
        this.authStatusDiv.createEl('div', {
          text: '✓ Authenticated',
          cls: 'status-indicator success',
        });
        this.authStatusDiv.createEl('p', {
          text: 'Successfully connected to Google Docs API.',
          cls: 'status-message',
        });

        // Add authentication management buttons
        const buttonContainer = this.authStatusDiv.createDiv({ cls: 'auth-button-container modal-button-container' });
        
        const clearButton = buttonContainer.createEl('button', {
          text: 'Clear Authentication',
          cls: 'auth-button clear',
        });
        clearButton.onclick = async () => {
          try {
            await this.plugin.clearAuthentication();
            await this.updateAuthStatus();
          } catch (error) {
            console.error('Failed to clear authentication:', error);
          }
        };

        const reAuthButton = buttonContainer.createEl('button', {
          text: 'Re-authenticate',
          cls: 'auth-button reauth',
        });
        reAuthButton.onclick = async () => {
          try {
            await this.plugin.clearAuthentication();
            await this.plugin.startAuthFlow();
            await this.updateAuthStatus();
          } catch (error) {
            console.error('Failed to re-authenticate:', error);
          }
        };
      } else {
        this.authStatusDiv.className = 'auth-status-display not-authenticated';
        this.authStatusDiv.createEl('div', {
          text: '⚠ Not Authenticated',
          cls: 'status-indicator warning',
        });

        if (status.error) {
          this.authStatusDiv.createEl('p', {
            text: status.error,
            cls: 'status-message error',
          });
        }

        if (status.nextSteps && status.nextSteps.length > 0) {
          const stepsDiv = this.authStatusDiv.createDiv({ cls: 'next-steps' });
          stepsDiv.createEl('p', { text: 'Next steps:', cls: 'steps-title' });
          const stepsList = stepsDiv.createEl('ul');

          for (const step of status.nextSteps) {
            stepsList.createEl('li', { text: step });
          }
        }

        // Add start authentication button
        const buttonContainer = this.authStatusDiv.createDiv({ cls: 'auth-button-container modal-button-container' });
        const authButton = buttonContainer.createEl('button', {
          text: 'Start Authentication',
          cls: 'auth-button start mod-cta',
        });
        authButton.onclick = async () => {
          try {
            await this.plugin.startAuthFlow();
            await this.updateAuthStatus();
          } catch (error) {
            console.error('Auth flow failed:', error);
            await this.updateAuthStatus();
          }
        };
      }
    } catch (error) {
      this.authStatusDiv.className = 'auth-status-display error';
      this.authStatusDiv.createEl('div', {
        text: '⚠ Status Check Failed',
        cls: 'status-indicator error',
      });
      this.authStatusDiv.createEl('p', {
        text: `Failed to check authentication: ${(error as Error).message}`,
        cls: 'status-message error',
      });
    }

    // Update auth button after status update
    await this.updateAuthButton();
  }

  /**
   * Update authentication button based on current status
   */
  private async updateAuthButton(): Promise<void> {
    if (!this.authButton) return;

    this.authButton.empty();

    try {
      const status = await this.plugin.getAuthStatus();
      const hasCredentials = this.plugin.settings.clientId && this.plugin.settings.clientSecret;

      if (!hasCredentials) {
        // Show setup guidance when credentials are missing
        this.authButton.createEl('div', {
          text: 'Configure Client ID and Client Secret above to enable authentication',
          cls: 'auth-guidance disabled',
        });

        const disabledButton = this.authButton.createEl('button', {
          text: 'Authentication Disabled',
          cls: 'auth-button disabled',
        });
        disabledButton.disabled = true;
      } else if (status.isAuthenticated) {
        // Show clear auth button when authenticated
        const clearButton = this.authButton.createEl('button', {
          text: 'Clear Authentication',
          cls: 'auth-button clear mod-warning',
        });
        clearButton.onclick = async () => {
          try {
            await this.plugin.clearAuthentication();
            await this.updateAuthStatus();
          } catch (error) {
            console.error('Failed to clear authentication:', error);
          }
        };

        // Add re-authenticate option
        const reAuthButton = this.authButton.createEl('button', {
          text: 'Re-authenticate',
          cls: 'auth-button reauth',
        });
        reAuthButton.onclick = async () => {
          try {
            await this.plugin.clearAuthentication();
            await this.plugin.startAuthFlow();
            // The status will be updated via the callback in handleAuthCallback
            await this.updateAuthStatus();
          } catch (error) {
            console.error('Failed to re-authenticate:', error);
          }
        };
      } else {
        // Show start auth button when not authenticated but credentials available
        const authButton = this.authButton.createEl('button', {
          text: 'Start Authentication',
          cls: 'auth-button start mod-cta',
        });
        authButton.onclick = async () => {
          try {
            await this.plugin.startAuthFlow();
            // The status will be updated via the callback in handleAuthCallback
            // But also update now in case of immediate errors
            await this.updateAuthStatus();
          } catch (error) {
            console.error('Auth flow failed:', error);
            // Update status to show any error messages
            await this.updateAuthStatus();
          }
        };

      }
    } catch (error) {
      this.authButton.createEl('div', {
        text: `Error updating auth controls: ${(error as Error).message}`,
        cls: 'auth-error',
      });
    }
  }

  /**
   * Update the sync status display in settings
   */
  private updateSyncStatusDisplay(statusEl: HTMLElement): void {
    statusEl.empty();

    if (!this.plugin.backgroundSyncManager || !this.plugin.syncStatusManager) {
      statusEl.createSpan({ text: 'Background sync not initialized', cls: 'sync-status-error' });
      return;
    }

    const status = this.plugin.backgroundSyncManager.getSyncStatus();
    const currentStatus = this.plugin.syncStatusManager.getCurrentStatus();

    const statusContainer = statusEl.createDiv({ cls: 'sync-status-container' });

    // Background Sync Section
    const backgroundSection = statusContainer.createDiv({ cls: 'sync-section' });
    backgroundSection.createEl('h4', { text: 'Background Sync', cls: 'sync-section-title' });

    // Main status
    const mainStatus = backgroundSection.createDiv({ cls: 'sync-status-main' });
    const statusIcon = this.getStatusIcon(currentStatus.state);
    mainStatus.createSpan({
      text: `${statusIcon} ${currentStatus.message}`,
      cls: `sync-status-${currentStatus.state}`,
    });

    // Details
    const details = backgroundSection.createDiv({ cls: 'sync-status-details' });
    details.createSpan({ text: currentStatus.details, cls: 'sync-status-detail-text' });

    // Stats
    if (status.queuedCount > 0 || status.failedCount > 0 || status.lastSync) {
      const stats = backgroundSection.createDiv({ cls: 'sync-status-stats' });

      if (status.queuedCount > 0) {
        stats.createSpan({ text: `${status.queuedCount} queued`, cls: 'sync-stat-queued' });
      }

      if (status.failedCount > 0) {
        stats.createSpan({ text: `${status.failedCount} failed`, cls: 'sync-stat-failed' });
      }

      if (status.lastSync) {
        const lastSyncText = this.formatLastSync(status.lastSync);
        stats.createSpan({ text: `Last: ${lastSyncText}`, cls: 'sync-stat-last' });
      }
    }

    // Error info
    if (currentStatus.errorInfo) {
      const errorInfo = backgroundSection.createDiv({ cls: 'sync-status-error-info' });
      errorInfo.createSpan({
        text: `⚠️ ${currentStatus.errorInfo.message}`,
        cls: 'sync-error-message',
      });

      if (currentStatus.errorInfo.userAction) {
        errorInfo.createDiv({
          text: `Action needed: ${currentStatus.errorInfo.userAction}`,
          cls: 'sync-error-action',
        });
      }
    }

    // Manual Sync Section
    const manualSection = statusContainer.createDiv({ cls: 'sync-section' });
    manualSection.createEl('h4', { text: 'Manual Sync', cls: 'sync-section-title' });

    const manualStatus = manualSection.createDiv({ cls: 'sync-status-main' });
    
    // Access manual sync status from plugin
    const plugin = this.plugin as any;
    if (plugin.syncInProgress && plugin.currentSyncStatus) {
      const syncStatus = plugin.currentSyncStatus;
      const progress = syncStatus.progress;
      const percentComplete = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
      
      manualStatus.createSpan({
        text: `🔄 ${syncStatus.operation}`,
        cls: 'sync-status-syncing',
      });

      const progressDetails = manualSection.createDiv({ cls: 'sync-status-details' });
      progressDetails.createSpan({ 
        text: `Progress: ${progress.current}/${progress.total} files (${percentComplete}%)`,
        cls: 'sync-status-detail-text' 
      });

      if (syncStatus.startTime > 0) {
        const elapsed = Math.round((Date.now() - syncStatus.startTime) / 1000);
        const elapsedDetails = manualSection.createDiv({ cls: 'sync-status-details' });
        elapsedDetails.createSpan({ 
          text: `Running for ${elapsed}s`,
          cls: 'sync-status-detail-text' 
        });
      }

      // Add cancel button for manual sync
      const cancelButton = manualSection.createEl('button', {
        text: 'Cancel Sync',
        cls: 'sync-cancel-button mod-warning',
      });
      cancelButton.onclick = () => {
        plugin.cancelSync();
        // Update display after a moment
        setTimeout(() => this.updateSyncStatusDisplay(statusEl), 500);
      };
    } else {
      manualStatus.createSpan({
        text: '⏸️ No manual sync running',
        cls: 'sync-status-idle',
      });

      const idleDetails = manualSection.createDiv({ cls: 'sync-status-details' });
      idleDetails.createSpan({ 
        text: 'Click "Sync Now" to start a manual sync operation',
        cls: 'sync-status-detail-text' 
      });
    }
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
        return '✅';
    }
  }

  private formatLastSync(timestamp: Date): string {
    const now = Date.now();
    const diffMs = now - timestamp.getTime();

    if (diffMs < 60000) {
      return 'Just now';
    } else if (diffMs < 3600000) {
      return `${Math.round(diffMs / 60000)}m ago`;
    } else if (diffMs < 86400000) {
      return `${Math.round(diffMs / 3600000)}h ago`;
    } else {
      return timestamp.toLocaleDateString();
    }
  }
}
