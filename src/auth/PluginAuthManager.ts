import { BrowserTokenLoader, Credentials } from './BrowserTokenLoader';
import { ObsidianTokenStorage } from './ObsidianTokenStorage';

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
    // Try to load credentials if we don't have them
    if (!this.currentCredentials) {
      this.currentCredentials = await this.loadCredentials();
    }

    // If we still don't have credentials, provide detailed guidance
    if (!this.currentCredentials) {
      const status = await this.getAuthStatus();
      throw new Error(
        `Authentication required: ${status.error}\n\nNext steps:\n${status.nextSteps?.map(step => `• ${step}`).join('\n')}`,
      );
    }

    // Check if credentials are expired
    if (this.tokenLoader.isTokenExpired(this.currentCredentials)) {
      throw new Error(
        'Authentication expired. Please re-authenticate using the plugin settings or CLI.'
      );
    }

    return this.currentCredentials;
  }

  /**
   * Loads credentials from multiple sources with priority order
   */
  async loadCredentials(): Promise<Credentials | null> {
    // Priority 1: Try plugin-stored tokens first (most reliable for plugin context)
    if (this.pluginTokenStorage) {
      try {
        const pluginCredentials = await this.pluginTokenStorage.load();
        if (pluginCredentials) {
          console.log('Using plugin-stored credentials');
          return pluginCredentials;
        }
      } catch (error) {
        console.warn('Failed to load plugin credentials:', error);
      }
    }

    // Priority 2: Try CLI tokens as fallback
    try {
      const cliCredentials = await this.tokenLoader.loadFromCLI();
      if (cliCredentials) {
        console.log('Using CLI credentials for plugin');
        return cliCredentials;
      }
    } catch (error) {
      console.warn('Failed to load CLI credentials:', error);
    }

    console.log('No credentials found from any source');
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
            'Use the "Start Auth Flow" button in plugin settings',
            'Or authenticate via CLI: gdocs-markdown-sync auth',
            'Make sure Client ID and Client Secret are configured'
          ],
          nextSteps: [
            'Configure Client ID and Client Secret in plugin settings',
            'Click "Start Auth Flow" to authenticate with Google',
            'Complete the browser authentication process'
          ]
        };
      }

      if (this.tokenLoader.isTokenExpired(credentials)) {
        return {
          isAuthenticated: false,
          error: 'Authentication credentials have expired',
          suggestions: [
            'Re-authenticate using the plugin settings',
            'Or run: gdocs-markdown-sync auth --refresh'
          ],
          nextSteps: [
            'Click "Start Auth Flow" in plugin settings',
            'Or use CLI to refresh tokens automatically'
          ]
        };
      }

      if (!credentials.access_token) {
        return {
          isAuthenticated: false,
          error: 'Invalid credentials: missing access token',
          suggestions: [
            'Clear existing authentication and re-authenticate',
            'Check that OAuth setup is correct'
          ],
          nextSteps: [
            'Click "Clear Authentication" in plugin settings',
            'Then click "Start Auth Flow" to re-authenticate'
          ]
        };
      }

      return {
        isAuthenticated: true
      };

    } catch (error) {
      return {
        isAuthenticated: false,
        error: `Authentication check failed: ${(error as Error).message}`,
        suggestions: [
          'Check plugin settings configuration',
          'Try clearing and re-authenticating'
        ],
        nextSteps: [
          'Review Client ID and Client Secret in settings',
          'Use "Clear Authentication" then "Start Auth Flow"'
        ]
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
   * Enhanced error message for unsupported direct auth flow
   */
  async startAuthFlow(): Promise<never> {
    const status = await this.getAuthStatus();
    const message = [
      'Direct authentication flow not supported in this context.',
      '',
      'Recommended approaches:',
      ...status.nextSteps?.map(step => `• ${step}`) || [],
      '',
      'Alternative: Use CLI authentication:',
      '• Open terminal/command prompt',
      '• Run: gdocs-markdown-sync auth',
      '• Complete browser authentication',
      '• Plugin will automatically use CLI credentials'
    ].join('\n');

    throw new Error(message);
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
    console.log('Credentials stored successfully in plugin');
  }

  /**
   * Clear credentials from all sources
   */
  async clearAllCredentials(): Promise<void> {
    this.currentCredentials = null;
    
    if (this.pluginTokenStorage) {
      try {
        await this.pluginTokenStorage.clear();
        console.log('Plugin credentials cleared');
      } catch (error) {
        console.warn('Failed to clear plugin credentials:', error);
      }
    }
  }
}
