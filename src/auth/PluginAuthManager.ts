import { BrowserTokenLoader, Credentials } from './BrowserTokenLoader';

/**
 * Simplified auth manager for Obsidian plugin
 * Only loads existing CLI tokens, doesn't perform OAuth in plugin
 */
export class PluginAuthManager {
  private tokenLoader: BrowserTokenLoader;
  private currentCredentials: Credentials | null = null;

  constructor(profile?: string) {
    this.tokenLoader = new BrowserTokenLoader(profile);
  }

  /**
   * Gets valid Google Auth client using existing CLI tokens
   */
  async getAuthClient(): Promise<any> {
    const credentials = await this.getValidCredentials();

    // For plugin, we'll create a simple auth object that can be used with DriveClient
    // The actual googleapis OAuth2 client setup will be handled in DriveClient
    return {
      credentials: {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        token_type: credentials.token_type,
        expiry_date: credentials.expiry_date,
      },
    };
  }

  /**
   * Gets valid credentials from CLI tokens only
   */
  async getValidCredentials(): Promise<Credentials> {
    // Try to load credentials if we don't have them
    if (!this.currentCredentials) {
      this.currentCredentials = await this.loadCredentials();
    }

    // If we still don't have credentials, throw error
    if (!this.currentCredentials) {
      throw new Error(
        'No valid credentials available. Please run "gdocs-markdown-sync auth" in the CLI first.',
      );
    }

    return this.currentCredentials;
  }

  /**
   * Loads credentials from CLI tokens only
   */
  async loadCredentials(): Promise<Credentials | null> {
    try {
      // Try CLI tokens
      const cliCredentials = await this.tokenLoader.loadFromCLI();
      if (cliCredentials) {
        console.log('Using CLI credentials for plugin');
        return cliCredentials;
      }
    } catch (error) {
      console.warn('Failed to load CLI credentials:', error);
    }

    console.log('No CLI credentials found');
    return null;
  }

  /**
   * Check if we have valid credentials
   */
  async hasValidCredentials(): Promise<boolean> {
    try {
      await this.getValidCredentials();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear current credentials (force re-authentication via CLI)
   */
  clearCredentials(): void {
    this.currentCredentials = null;
  }

  /**
   * Plugin can't start auth flow - redirect to CLI
   */
  async startAuthFlow(): Promise<never> {
    throw new Error(
      'Authentication must be done via CLI. Please run "gdocs-markdown-sync auth" in your terminal.',
    );
  }
}
