import { App, PluginSettingTab, Setting } from 'obsidian';

import GoogleDocsSyncPlugin from './plugin-main';

export class GoogleDocsSyncSettingsTab extends PluginSettingTab {
  plugin: GoogleDocsSyncPlugin;

  constructor(app: App, plugin: GoogleDocsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Google Docs Sync Settings' });

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

    containerEl.createEl('h3', { text: 'Google OAuth' });

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('Google OAuth Client ID')
      .addText((text) =>
        text
          .setPlaceholder('Enter Client ID')
          .setValue(this.plugin.settings.clientId || '')
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Client Secret')
      .setDesc('Google OAuth Client Secret')
      .addText((text) =>
        text
          .setPlaceholder('Enter Client Secret')
          .setValue(this.plugin.settings.clientSecret || '')
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Profile')
      .setDesc('Token profile name (default: default)')
      .addText((text) =>
        text
          .setPlaceholder('default')
          .setValue(this.plugin.settings.profile || 'default')
          .onChange(async (value) => {
            this.plugin.settings.profile = value || 'default';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Authentication')
      .setDesc('Configure Google Docs authentication')
      .addButton((button) =>
        button
          .setButtonText('Start Auth Flow')
          .setCta()
          .onClick(async () => {
            await this.plugin.startAuthFlow();
          }),
      );
  }
}
