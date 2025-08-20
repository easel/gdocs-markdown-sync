import { App, PluginSettingTab, Setting, Notice } from 'obsidian';

import GoogleDocsSyncPlugin from './plugin-main';
import { ConflictResolver } from './sync/ConflictResolver';
import { ErrorUtils } from './utils/ErrorUtils';

export class EnhancedGoogleDocsSyncSettingsTab extends PluginSettingTab {
  plugin: GoogleDocsSyncPlugin;
  private validationErrors: Map<string, string> = new Map();

  constructor(app: App, plugin: GoogleDocsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Google Docs Sync Settings' });

    // Authentication status section
    this.createAuthStatusSection(containerEl);

    // Core sync settings
    containerEl.createEl('h3', { text: 'Sync Configuration' });

    // Drive folder setting with enhanced validation
    new Setting(containerEl)
      .setName('Drive Folder Name or ID')
      .setDesc(
        'Google Drive folder name (e.g., "My Documents") or folder ID. If the folder doesn\'t exist, it will be created.',
      )
      .addText((text) => {
        const textComponent = text
          .setPlaceholder('Enter folder name or ID')
          .setValue(this.plugin.settings.driveFolderId)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (this.validateDriveFolder(trimmed)) {
              this.plugin.settings.driveFolderId = trimmed;
              try {
                await this.plugin.saveSettings();
                this.clearValidationError('driveFolderId');
              } catch (error) {
                this.showValidationError('driveFolderId', 'Failed to save settings');
              }
            } else if (trimmed) {
              this.showValidationError('driveFolderId', 'Invalid folder name or ID format');
            }
          });

        // Add validation styling if there's an error
        if (this.validationErrors.has('driveFolderId')) {
          textComponent.inputEl.style.borderColor = 'var(--text-error)';
        }

        return textComponent;
      });

    // Show validation error if exists
    this.showValidationErrorElement(containerEl, 'driveFolderId');

    new Setting(containerEl)
      .setName('Base Vault Folder')
      .setDesc('Vault subfolder where synced files are stored (empty = entire vault)')
      .addText((text) =>
        text
          .setPlaceholder('Google Docs')
          .setValue(this.plugin.settings.baseVaultFolder || '')
          .onChange(async (value) => {
            this.plugin.settings.baseVaultFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    // Conflict policy with detailed descriptions
    new Setting(containerEl)
      .setName('Conflict Policy')
      .setDesc('How to handle conflicts between local and remote changes')
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            'prefer-doc',
            'Prefer Google Doc - Always use remote version when conflicts occur',
          )
          .addOption('prefer-md', 'Prefer Markdown - Always use local version when conflicts occur')
          .addOption(
            'merge',
            'Attempt Merge - Try intelligent merge, fall back to conflict markers',
          )
          .setValue(this.plugin.settings.conflictPolicy)
          .onChange(async (value) => {
            if (ConflictResolver.isValidPolicy(value as any)) {
              this.plugin.settings.conflictPolicy = value as any;
              try {
                await this.plugin.saveSettings();
                this.clearValidationError('conflictPolicy');
                // Show policy description
                new Notice(
                  `Conflict policy set to: ${ConflictResolver.getPolicyDescription(value as any)}`,
                  5000,
                );
              } catch (error) {
                this.showValidationError('conflictPolicy', 'Failed to save settings');
              }
            } else {
              this.showValidationError('conflictPolicy', 'Invalid conflict policy');
            }
          }),
      );

    this.showValidationErrorElement(containerEl, 'conflictPolicy');

    // Background sync section
    containerEl.createEl('h3', { text: 'Background Sync' });

    // Poll interval with validation
    new Setting(containerEl)
      .setName('Poll Interval')
      .setDesc('How often to check for changes (5-3600 seconds)')
      .addText((text) =>
        text.setValue(this.plugin.settings.pollInterval.toString()).onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 5 && num <= 3600) {
            this.plugin.settings.pollInterval = num;
            try {
              await this.plugin.saveSettings();
              this.clearValidationError('pollInterval');
            } catch (error) {
              this.showValidationError('pollInterval', 'Failed to save settings');
            }
          } else {
            this.showValidationError(
              'pollInterval',
              'Poll interval must be between 5 and 3600 seconds',
            );
          }
        }),
      );

    this.showValidationErrorElement(containerEl, 'pollInterval');

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

    // OAuth configuration section
    containerEl.createEl('h3', { text: 'Google OAuth Configuration' });

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('Google OAuth Client ID (required for authentication)')
      .addText((text) => {
        const textComponent = text
          .setPlaceholder('Enter Client ID')
          .setValue(this.plugin.settings.clientId || '')
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh to update auth button state
          });

        textComponent.inputEl.setAttribute('type', 'password');
        return textComponent;
      });

    new Setting(containerEl)
      .setName('Client Secret')
      .setDesc('Google OAuth Client Secret (required for authentication)')
      .addText((text) => {
        const textComponent = text
          .setPlaceholder('Enter Client Secret')
          .setValue(this.plugin.settings.clientSecret || '')
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh to update auth button state
          });

        textComponent.inputEl.setAttribute('type', 'password');
        return textComponent;
      });

    new Setting(containerEl)
      .setName('Profile')
      .setDesc('Token profile name (use different profiles for multiple Google accounts)')
      .addText((text) =>
        text
          .setPlaceholder('default')
          .setValue(this.plugin.settings.profile || 'default')
          .onChange(async (value) => {
            this.plugin.settings.profile = value || 'default';
            await this.plugin.saveSettings();
          }),
      );

    // Authentication section
    containerEl.createEl('h3', { text: 'Authentication' });

    new Setting(containerEl)
      .setName('Google Drive Authentication')
      .setDesc('Authenticate with Google Drive to enable sync operations')
      .addButton((button) => {
        const isAuthenticated = this.plugin.isAuthenticated();
        button
          .setButtonText(isAuthenticated ? 'Re-authenticate' : 'Start Auth Flow')
          .setCta()
          .onClick(async () => {
            try {
              const notice = new Notice('Starting authentication flow...', 0);
              await this.plugin.startAuthFlow();
              notice.setMessage('✅ Authentication successful!');
              setTimeout(() => {
                notice.hide();
                this.display(); // Refresh settings to show new auth status
              }, 2000);
            } catch (error) {
              const errorMessage = ErrorUtils.normalize(error).message;
              new Notice(`❌ Authentication failed: ${errorMessage}`, 8000);
            }
          });

        // Disable button if missing client credentials
        if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
          button.setDisabled(true);
          button.setTooltip('Please enter Client ID and Client Secret first');
        }

        return button;
      });

    // Configuration status summary
    containerEl.createEl('h3', { text: 'Configuration Status' });

    const configStatus = this.getConfigurationStatus();
    const statusEl = containerEl.createDiv();
    statusEl.innerHTML = configStatus.message;
    statusEl.style.color = configStatus.isValid ? 'var(--text-success)' : 'var(--text-warning)';
    statusEl.style.padding = '10px';
    statusEl.style.border = `1px solid ${configStatus.isValid ? 'var(--text-success)' : 'var(--text-warning)'}`;
    statusEl.style.borderRadius = '4px';
    statusEl.style.marginTop = '10px';

    // Sync operations section (only show if properly configured)
    if (configStatus.isValid) {
      containerEl.createEl('h3', { text: 'Manual Sync Operations' });

      const syncSection = containerEl.createDiv();
      syncSection.style.display = 'flex';
      syncSection.style.gap = '10px';
      syncSection.style.marginBottom = '20px';
      syncSection.style.flexWrap = 'wrap';

      const pullButton = syncSection.createEl('button', {
        text: '📥 Pull from Google Docs',
        cls: 'mod-cta',
      });
      pullButton.onclick = () => this.plugin.pullAllDocs();

      const pushButton = syncSection.createEl('button', {
        text: '📤 Push to Google Docs',
        cls: 'mod-cta',
      });
      pushButton.onclick = () => this.plugin.pushAllDocs();

      const syncButton = syncSection.createEl('button', {
        text: '🔄 Sync Both Directions',
        cls: 'mod-cta',
      });
      syncButton.onclick = () => this.plugin.syncCurrentDoc(); // Assuming this method exists or will be created
    }
  }

  private createAuthStatusSection(containerEl: HTMLElement): void {
    const authSection = containerEl.createDiv();
    authSection.createEl('h3', { text: 'Authentication Status' });

    // Show current auth status
    const authStatusEl = authSection.createEl('p');
    const isAuthenticated = this.plugin.isAuthenticated();
    if (isAuthenticated) {
      authStatusEl.innerHTML = '✅ <strong>Authenticated with Google Drive</strong>';
      authStatusEl.style.color = 'var(--text-success)';
    } else {
      authStatusEl.innerHTML = '❌ <strong>Not authenticated</strong>';
      authStatusEl.style.color = 'var(--text-error)';
    }
  }

  /**
   * Validate Drive folder format
   */
  private validateDriveFolder(value: string): boolean {
    if (!value) return true; // Empty is allowed

    const folderIdPattern = /^[a-zA-Z0-9_-]{25,}$/;
    const isValidId = folderIdPattern.test(value);
    const isValidName = value.length > 0 && !value.includes('/') && !value.includes('\\');

    return isValidId || isValidName;
  }

  /**
   * Show validation error for a field
   */
  private showValidationError(fieldName: string, message: string): void {
    this.validationErrors.set(fieldName, message);
  }

  /**
   * Clear validation error for a field
   */
  private clearValidationError(fieldName: string): void {
    this.validationErrors.delete(fieldName);
  }

  /**
   * Show validation error element if error exists
   */
  private showValidationErrorElement(container: HTMLElement, fieldName: string): void {
    const error = this.validationErrors.get(fieldName);
    if (error) {
      const errorEl = container.createEl('div', {
        text: `⚠️ ${error}`,
        cls: 'setting-item-description',
      });
      errorEl.style.color = 'var(--text-error)';
      errorEl.style.marginTop = '4px';
      errorEl.style.fontWeight = 'bold';
    }
  }

  /**
   * Get overall configuration status
   */
  private getConfigurationStatus(): { isValid: boolean; message: string } {
    const issues = [];

    if (!this.plugin.settings.clientId) {
      issues.push('Missing OAuth Client ID');
    }
    if (!this.plugin.settings.clientSecret) {
      issues.push('Missing OAuth Client Secret');
    }
    if (!this.plugin.settings.driveFolderId) {
      issues.push('Drive folder not configured');
    }
    if (!this.plugin.isAuthenticated()) {
      issues.push('Not authenticated with Google Drive');
    }

    if (issues.length === 0) {
      return {
        isValid: true,
        message:
          '✅ <strong>All settings configured correctly</strong><br/>You can now use sync operations.',
      };
    } else {
      return {
        isValid: false,
        message: `⚠️ <strong>Configuration incomplete:</strong><br/>• ${issues.join('<br/>• ')}<br/><br/>Please complete the configuration before using sync operations.`,
      };
    }
  }
}
