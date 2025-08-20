import { App, PluginSettingTab, Setting } from 'obsidian';

import GoogleDocsSyncPlugin from './plugin-main';

export class GoogleDocsSyncSettingsTab extends PluginSettingTab {
  plugin: GoogleDocsSyncPlugin;
  private authStatusDiv: HTMLElement | null = null;
  private authButton: HTMLElement | null = null;

  constructor(app: App, plugin: GoogleDocsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Google Docs Sync Settings' });

    // Add authentication status section at the top
    await this.displayAuthenticationStatus(containerEl);

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
          .addOption('prefer-doc', 'Prefer Doc (default)')
          .addOption('prefer-md', 'Prefer MD')
          .addOption('merge', 'Merge')
          .setValue(this.plugin.settings.conflictPolicy)
          .onChange(async (value) => {
            this.plugin.settings.conflictPolicy = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Poll Interval')
      .setDesc('How often to check for changes (in seconds)')
      .addText((text) =>
        text.setValue(this.plugin.settings.pollInterval.toString()).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num)) {
            this.plugin.settings.pollInterval = num;
            await this.plugin.saveSettings();
          }
        }),
      );

    containerEl.createEl('h3', { text: 'Background Sync' });

    new Setting(containerEl)
      .setName('Enable Background Sync')
      .setDesc('Automatically sync documents in the background')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.backgroundSyncEnabled !== false)
          .onChange(async (value) => {
            this.plugin.settings.backgroundSyncEnabled = value;
            await this.plugin.saveSettings();
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
          .setTooltip('Force background sync to run immediately')
          .setCta()
          .onClick(async () => {
            await this.plugin.forceBackgroundSync();
            // Update display after a moment
            setTimeout(() => this.updateSyncStatusDisplay(statusEl), 1000);
          }),
      )
      .addButton((button) => {
        const isEnabled = this.plugin.settings.backgroundSyncEnabled !== false;
        return button
          .setButtonText(isEnabled ? 'Disable' : 'Enable')
          .setTooltip(`${isEnabled ? 'Disable' : 'Enable'} background sync`)
          .onClick(async () => {
            await this.plugin.toggleBackgroundSync();
            this.display(); // Refresh the entire settings display
          });
      });

    containerEl.createEl('h3', { text: 'Google OAuth Configuration' });

    const oauthDesc = containerEl.createDiv({ cls: 'oauth-description' });
    oauthDesc.innerHTML = `
      <p>Configure your Google OAuth credentials. You'll need to create a project in the <a href="https://console.cloud.google.com/" target="_blank">Google Cloud Console</a> and set up OAuth2 credentials.</p>
    `;

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('Google OAuth Client ID from Google Cloud Console')
      .addText((text) =>
        text
          .setPlaceholder('Enter Client ID')
          .setValue(this.plugin.settings.clientId || '')
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
            // Update auth status when credentials change
            await this.updateAuthStatus();
          }),
      );

    new Setting(containerEl)
      .setName('Client Secret')
      .setDesc('Google OAuth Client Secret from Google Cloud Console')
      .addText((text) =>
        text
          .setPlaceholder('Enter Client Secret')
          .setValue(this.plugin.settings.clientSecret || '')
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value;
            await this.plugin.saveSettings();
            // Update auth status when credentials change
            await this.updateAuthStatus();
          }),
      );

    new Setting(containerEl)
      .setName('Profile')
      .setDesc('Token profile name for managing multiple accounts (default: default)')
      .addText((text) =>
        text
          .setPlaceholder('default')
          .setValue(this.plugin.settings.profile || 'default')
          .onChange(async (value) => {
            this.plugin.settings.profile = value || 'default';
            await this.plugin.saveSettings();
            // Update auth status when profile changes
            await this.updateAuthStatus();
          }),
      );

    // Authentication actions section
    containerEl.createEl('h3', { text: 'Authentication' });

    const authSetting = new Setting(containerEl)
      .setName('Google Account Access')
      .setDesc('Authenticate with Google to enable document synchronization');

    // Add the auth button that will be dynamically updated
    this.authButton = authSetting.controlEl;
    await this.updateAuthButton();
  }

  /**
   * Display authentication status at the top of settings
   */
  private async displayAuthenticationStatus(containerEl: HTMLElement): Promise<void> {
    const statusSection = containerEl.createDiv({ cls: 'auth-status-section' });
    statusSection.createEl('h3', { text: 'Authentication Status' });

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
            // Update status after a delay to allow auth flow
            setTimeout(() => this.updateAuthStatus(), 1000);
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
            // Update status after a delay to allow auth flow
            setTimeout(() => this.updateAuthStatus(), 1000);
          } catch (error) {
            console.error('Auth flow failed:', error);
            // Update status to show any error messages
            await this.updateAuthStatus();
          }
        };

        // Show CLI alternative
        const cliNote = this.authButton.createDiv({ cls: 'auth-alternative' });
        cliNote.innerHTML = `
          <p>Alternative: Use CLI authentication:</p>
          <code>gdocs-markdown-sync auth</code>
          <p>The plugin will automatically detect CLI credentials.</p>
        `;
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

    // Main status
    const mainStatus = statusContainer.createDiv({ cls: 'sync-status-main' });
    const statusIcon = this.getStatusIcon(currentStatus.state);
    mainStatus.createSpan({
      text: `${statusIcon} ${currentStatus.message}`,
      cls: `sync-status-${currentStatus.state}`,
    });

    // Details
    const details = statusContainer.createDiv({ cls: 'sync-status-details' });
    details.createSpan({ text: currentStatus.details, cls: 'sync-status-detail-text' });

    // Stats
    if (status.queuedCount > 0 || status.failedCount > 0 || status.lastSync) {
      const stats = statusContainer.createDiv({ cls: 'sync-status-stats' });

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
      const errorInfo = statusContainer.createDiv({ cls: 'sync-status-error-info' });
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
