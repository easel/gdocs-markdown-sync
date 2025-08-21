import { BrowserTokenLoader, Credentials } from './BrowserTokenLoader';
import { ObsidianTokenStorage } from './ObsidianTokenStorage';
import { UnifiedOAuthManager } from './UnifiedOAuthManager';

export interface AuthStatusResult {
  isAuthenticated: boolean;
  error?: string;
  suggestions?: string[];
  nextSteps?: string[];
}

/**
 * Enhanced auth manager for Obsidian plugin with better UX
 * Supports both CLI token loading and plugin-based authentication
 */
export class PluginAuthManager {
  isAuthenticated(): boolean {
    try {
      // Check if we have stored credentials
      return this.currentCredentials !== null || this.hasStoredTokens();
    } catch {
      return false;
    }
  }

  private hasStoredTokens(): boolean {
    try {
      // Check CLI tokens first
      const cliTokens = this.tokenLoader.getTokens();
      if (cliTokens?.access_token) {
        return true;
      }

      // Check plugin storage tokens
      if (this.pluginTokenStorage) {
        const pluginTokens = this.pluginTokenStorage.getTokens();
        if (pluginTokens?.access_token) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }
  private tokenLoader: BrowserTokenLoader;
  private pluginTokenStorage: ObsidianTokenStorage | null = null;
  private currentCredentials: Credentials | null = null;
  private profile: string;

  constructor(profile?: string, plugin?: any) {
    this.profile = profile || 'default';
    this.tokenLoader = new BrowserTokenLoader(this.profile);

    if (plugin) {
      this.pluginTokenStorage = new ObsidianTokenStorage(plugin, this.profile);
    }
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
   * Gets valid credentials with enhanced error handling
   */
  async getValidCredentials(): Promise<Credentials> {
    // Always try to load credentials fresh from storage to handle plugin updates
    this.currentCredentials = await this.loadCredentials();

    // If we still don't have credentials, provide detailed guidance
    if (!this.currentCredentials) {
      const status = await this.getAuthStatus();
      throw new Error(
        `Authentication required: ${status.error}\n\nNext steps:\n${status.nextSteps?.map((step) => `• ${step}`).join('\n')}`,
      );
    }

    // Check if credentials are expired and attempt refresh
    if (this.tokenLoader.isTokenExpired(this.currentCredentials)) {
      try {
        // Attempt to refresh the token
        this.currentCredentials = await this.refreshExpiredToken(this.currentCredentials);
        console.log('Token refreshed successfully');
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError);
        // Clear invalid credentials and re-throw with user-friendly message
        this.currentCredentials = null;
        throw new Error(
          'Authentication expired and token refresh failed. Please re-authenticate in plugin settings.',
        );
      }
    }

    return this.currentCredentials;
  }

  /**
   * Loads credentials from plugin storage only
   * Note: Plugin cannot access CLI tokens due to filesystem restrictions
   */
  async loadCredentials(): Promise<Credentials | null> {
    // Plugin uses only its own token storage - cannot access CLI filesystem
    if (this.pluginTokenStorage) {
      try {
        const pluginCredentials = await this.pluginTokenStorage.load();
        if (pluginCredentials) {
          return pluginCredentials;
        }
      } catch (error) {
        console.warn('Failed to load plugin credentials:', error);
      }
    }

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
   * Get detailed authentication status with actionable guidance
   */
  async getAuthStatus(): Promise<AuthStatusResult> {
    try {
      const credentials = await this.loadCredentials();

      if (!credentials) {
        return {
          isAuthenticated: false,
          error: 'No authentication credentials found',
          suggestions: [
            'Use the "Start Authentication" button in plugin settings',
          ],
          nextSteps: [
            'Click "Start Authentication" to authenticate with Google',
            'Complete the browser authentication process',
          ],
        };
      }

      if (this.tokenLoader.isTokenExpired(credentials)) {
        return {
          isAuthenticated: false,
          error: 'Authentication credentials have expired',
          suggestions: [
            'Re-authenticate using the plugin settings',
            'Tokens will be automatically refreshed during authentication',
          ],
          nextSteps: [
            'Click "Start Authentication" in plugin settings',
            'Complete the authentication process to get new tokens',
          ],
        };
      }

      if (!credentials.access_token) {
        return {
          isAuthenticated: false,
          error: 'Invalid credentials: missing access token',
          suggestions: [
            'Clear existing authentication and re-authenticate',
            'Check that OAuth setup is correct',
          ],
          nextSteps: [
            'Click "Clear Authentication" in plugin settings',
            'Then click "Start Authentication" to re-authenticate',
          ],
        };
      }

      return {
        isAuthenticated: true,
      };
    } catch (error) {
      return {
        isAuthenticated: false,
        error: `Authentication check failed: ${(error as Error).message}`,
        suggestions: ['Check plugin settings configuration', 'Try clearing and re-authenticating'],
        nextSteps: [
          'Review Client ID and Client Secret in settings',
          'Use "Clear Authentication" then "Start Authentication"',
        ],
      };
    }
  }

  /**
   * Clear current credentials (force re-loading from storage)
   */
  clearCredentials(): void {
    this.currentCredentials = null;
  }

  /**
   * Plugin auth flow is handled by the main plugin class
   * This method shouldn't be called directly
   */
  async startAuthFlow(): Promise<never> {
    throw new Error(
      'Authentication flow should be started via plugin settings UI. ' +
      'Click "Start Authentication" button in the plugin settings panel.',
    );
  }

  /**
   * Store credentials in plugin storage
   */
  async storeCredentials(credentials: Credentials): Promise<void> {
    if (!this.pluginTokenStorage) {
      throw new Error('Plugin token storage not initialized');
    }

    await this.pluginTokenStorage.save(credentials);
    this.currentCredentials = credentials;
  }

  /**
   * Clear credentials from all sources
   */
  async clearAllCredentials(): Promise<void> {
    this.currentCredentials = null;

    if (this.pluginTokenStorage) {
      try {
        await this.pluginTokenStorage.clear();
      } catch (error) {
        console.warn('Failed to clear plugin credentials:', error);
      }
    }
  }

  /**
   * Attempt to refresh expired access token using refresh token
   */
  private async refreshExpiredToken(credentials: Credentials): Promise<Credentials> {
    if (!credentials.refresh_token) {
      throw new Error('No refresh token available for token refresh');
    }

    // We need OAuth client settings for refresh - get them from plugin settings 
    // This is a bit of a hack, but we need to access the plugin's OAuth settings
    const oauthManager = new UnifiedOAuthManager();
    
    try {
      const refreshedCredentials = await oauthManager.refreshTokens(credentials);
      
      // Save the refreshed credentials
      if (this.pluginTokenStorage) {
        await this.pluginTokenStorage.save(refreshedCredentials);
      }
      
      return refreshedCredentials;
    } catch (error) {
      throw new Error(`Token refresh failed: ${(error as Error).message}`);
    }
  }
}
