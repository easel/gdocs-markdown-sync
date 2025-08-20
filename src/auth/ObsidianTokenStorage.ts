import { TokenStorage, Credentials } from './TokenStorage';

/**
 * Obsidian plugin data-based token storage
 * Uses Obsidian's plugin data API to store tokens securely
 */
export class ObsidianTokenStorage implements TokenStorage {
  private plugin: any; // Obsidian Plugin instance
  private profile: string;

  constructor(plugin: any, profile?: string) {
    this.plugin = plugin;
    this.profile = profile && profile.trim() ? profile.trim() : 'default';
  }

  private getTokenKey(): string {
    return `auth_tokens_${this.profile}`;
  }

  async load(): Promise<Credentials | null> {
    try {
      const data = await this.plugin.loadData();
      const tokenKey = this.getTokenKey();

      if (!data || !data[tokenKey]) {
        console.log('No tokens found in plugin data');
        return null;
      }

      const credentials = data[tokenKey];

      // Validate that we have the minimum required tokens
      if (!credentials.access_token || !credentials.refresh_token) {
        console.log('Plugin tokens found but missing required fields (access_token or refresh_token)');
        return null;
      }

      console.log('Successfully loaded tokens from plugin data');
      return credentials;
    } catch (error) {
      console.log('Error loading tokens from plugin data:', (error as Error).message);
      return null;
    }
  }

  async save(credentials: Credentials): Promise<void> {
    try {
      // Validate credentials before saving
      if (!credentials.access_token || !credentials.refresh_token) {
        throw new Error('Cannot save invalid credentials: missing access_token or refresh_token');
      }

      let data = (await this.plugin.loadData()) || {};
      const tokenKey = this.getTokenKey();

      // Ensure we're storing a clean credentials object
      data[tokenKey] = {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        token_type: credentials.token_type || 'Bearer',
        scope: credentials.scope,
        expiry_date: credentials.expiry_date,
      };

      await this.plugin.saveData(data);
      console.log('Saved tokens to plugin data');
    } catch (error) {
      console.error('Failed to save tokens to plugin data:', (error as Error).message);
      throw error;
    }
  }

  async exists(): Promise<boolean> {
    try {
      const data = await this.plugin.loadData();
      const tokenKey = this.getTokenKey();
      return data && data[tokenKey] && data[tokenKey].access_token;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      let data = (await this.plugin.loadData()) || {};
      const tokenKey = this.getTokenKey();

      delete data[tokenKey];

      await this.plugin.saveData(data);
      console.log('Cleared tokens from plugin data');
    } catch (error) {
      console.log('Error clearing tokens from plugin data:', (error as Error).message);
    }
  }
}
