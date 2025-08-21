import { getNetworkConfig } from '../utils/Config.js';
import { AuthenticationError, ErrorContext, ErrorUtils } from '../utils/ErrorUtils.js';
import { createLogger } from '../utils/Logger.js';
import { NetworkUtils } from '../utils/NetworkUtils.js';

import { TokenStorage, Credentials, TokenUtils } from './TokenStorage';

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

/**
 * Unified OAuth manager that works in both CLI and Obsidian environments
 * Uses environment detection to choose appropriate auth flow
 */
export class UnifiedOAuthManager {
  private tokenStorage: TokenStorage;
  private config: OAuthConfig;
  private logger = createLogger({ operation: 'oauth-manager' });

  private readonly SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/documents',
  ];

  // Public client ID for desktop apps (safe to expose)
  private readonly PUBLIC_CLIENT_ID =
    process.env.GOOGLE_OAUTH_CLIENT_ID ||
    '181003307316-5devin5s9sh5tmvunurn4jh4m6m8p89v.apps.googleusercontent.com';

  // Client secret (needed for token exchange)
  private readonly CLIENT_SECRET =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || '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';

  constructor(tokenStorage: TokenStorage, config?: OAuthConfig) {
    this.tokenStorage = tokenStorage;
    this.config = config || {};
  }

  /**
   * Gets valid authenticated credentials, refreshing if necessary
   */
  async getValidCredentials(): Promise<Credentials> {
    const operation = this.logger.startOperation('get-valid-credentials');

    return ErrorUtils.withErrorContext(
      async () => {
        let credentials = await this.tokenStorage.load();

        if (!credentials) {
          throw new AuthenticationError('No credentials found. Please authenticate first.');
        }

        // Check if tokens are expired and refresh if needed
        if (TokenUtils.isTokenExpired(credentials)) {
          operation.info('Tokens are expired, attempting to refresh...');
          try {
            credentials = await this.refreshTokens(credentials);
            await this.tokenStorage.save(credentials);
            operation.success('Tokens refreshed successfully');
          } catch (error) {
            operation.failure(
              'Token refresh failed, need to re-authenticate',
              {},
              error instanceof Error ? error : undefined,
            );
            throw new AuthenticationError(
              'Token refresh failed. Please re-authenticate.',
              { operation: 'token-refresh' },
              error instanceof Error ? error : undefined,
            );
          }
        }

        return credentials;
      },
      { operation: 'get-valid-credentials' },
    )();
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
   * Gets valid Google Auth client for use with Google APIs
   */
  async getAuthClient(): Promise<any> {
    const credentials = await this.getValidCredentials();

    // Return a simple auth object that can be used with DriveClient
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
   * Start authentication flow (environment-specific)
   */
  async startAuthFlow(): Promise<Credentials> {
    const credentials = this.isNode()
      ? await this.startNodeAuthFlow()
      : await this.startBrowserAuthFlow();

    // Save credentials after successful authentication
    await this.tokenStorage.save(credentials);
    return credentials;
  }

  /**
   * Node.js environment auth flow (CLI with local server)
   */
  private async startNodeAuthFlow(): Promise<Credentials> {
    // Import express only in Node.js environment
    const express = await import('express');

    const { codeVerifier, codeChallenge } = await this.generatePKCE();

    return new Promise((resolve, reject) => {
      const app = express.default();
      const server = app.listen(0, () => {
        const port = (server.address() as any)?.port;

        if (!port) {
          reject(new Error('Failed to start callback server'));
          return;
        }

        console.log(`OAuth callback server started on port ${port}`);

        const redirectUri = `http://localhost:${port}/callback`;
        const authUrl = this.buildAuthUrl(codeChallenge, redirectUri);

        console.log('Opening browser for OAuth authorization...');
        console.log('If browser does not open automatically, visit:', authUrl);

        app.get('/callback', async (req, res) => {
          const { code, error } = req.query;

          if (error) {
            res.send(`<h1>Authorization Error</h1><p>${error}</p>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code) {
            res.send('<h1>Authorization Error</h1><p>No authorization code received</p>');
            server.close();
            reject(new Error('No authorization code received'));
            return;
          }

          try {
            const credentials = await this.exchangeCodeForTokens(
              code as string,
              codeVerifier,
              redirectUri,
            );

            res.send(`
              <h1>Authorization Successful!</h1>
              <p>OAuth flow completed. You can now close this window.</p>
              <script>setTimeout(() => window.close(), 3000);</script>
            `);

            clearTimeout(timeoutId);
            server.close(() => {
              resolve(credentials);
            });
          } catch (tokenError) {
            res.send(`<h1>Token Exchange Error</h1><p>${tokenError}</p>`);
            clearTimeout(timeoutId);
            server.close();
            reject(tokenError);
          }
        });

        this.openBrowser(authUrl);

        const timeoutId = setTimeout(
          () => {
            server.close();
            reject(new Error('OAuth flow timed out after 5 minutes'));
          },
          5 * 60 * 1000,
        );
      });

      server.on('error', (err) => {
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });
  }

  /**
   * Browser environment auth flow (Obsidian with manual code entry)
   */
  private async startBrowserAuthFlow(): Promise<Credentials> {
    throw new Error(
      'Browser auth flow requires interactive handling. Use getAuthorizationUrl() and exchangeCodeForTokens() instead.'
    );
  }

  /**
   * Get authorization URL for browser-based OAuth flow
   * Returns the URL and code verifier needed for token exchange
   */
  async getAuthorizationUrl(): Promise<{ url: string; codeVerifier: string }> {
    const { codeVerifier, codeChallenge } = await this.generatePKCE();
    const redirectUri = 'urn:ietf:wg:oauth:2.0:oob'; // Out-of-band flow for manual code entry
    const url = this.buildAuthUrl(codeChallenge, redirectUri);
    
    return { url, codeVerifier };
  }

  /**
   * Exchange authorization code for access tokens
   * Uses the code verifier from getAuthorizationUrl()
   */
  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<Credentials> {
    const operation = this.logger.startOperation('exchange-code-for-tokens');

    return ErrorUtils.withErrorContext(
      async () => {
        const tokenResponse = await NetworkUtils.fetchWithRetry(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              client_id: this.config.clientId || this.PUBLIC_CLIENT_ID,
              client_secret: this.config.clientSecret || this.CLIENT_SECRET,
              code,
              code_verifier: codeVerifier,
              grant_type: 'authorization_code',
              redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
            }).toString(),
          },
          getNetworkConfig(),
        );

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          operation.failure('Token exchange failed', { statusCode: tokenResponse.status, errorData });
          throw new AuthenticationError(
            `Token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`,
            { operation: 'token-exchange', statusCode: tokenResponse.status },
          );
        }

        const tokens = await tokenResponse.json();
        operation.success('Tokens exchanged successfully');

        // Convert to our Credentials format
        const credentials: Credentials = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type || 'Bearer',
          scope: this.config.scopes?.join(' ') || this.SCOPES.join(' '),
          expiry_date: tokens.expiry_date || (Date.now() + (tokens.expires_in || 3600) * 1000),
        };

        return credentials;
      },
      { operation: 'exchange-code-for-tokens' },
    )();
  }

  /**
   * Generate PKCE challenge and verifier using Web Crypto API
   * Works in both Bun CLI and Obsidian environments
   */
  private async generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    // Generate cryptographically secure random bytes for code verifier
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    
    // Convert to base64url format (RFC 7636)
    const codeVerifier = btoa(String.fromCharCode.apply(null, Array.from(array)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // Create SHA256 hash of verifier for challenge
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    
    // Convert hash to base64url format
    const codeChallenge = btoa(String.fromCharCode.apply(null, Array.from(hashArray)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return { codeVerifier, codeChallenge };
  }

  /**
   * Build authorization URL
   */
  private buildAuthUrl(codeChallenge: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId || this.PUBLIC_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.config.scopes?.join(' ') || this.SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<Credentials> {
    const tokenRequestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId || this.PUBLIC_CLIENT_ID,
      client_secret: this.config.clientSecret || this.CLIENT_SECRET,
      code: code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const context: ErrorContext = {
      operation: 'exchange-code-for-tokens',
      metadata: { code: code.substring(0, 10) + '...' },
    };

    return ErrorUtils.withErrorContext(async () => {
      try {
        const response = await NetworkUtils.fetchWithRetry(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: tokenRequestBody,
          },
          { timeout: getNetworkConfig().timeout },
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new AuthenticationError(
            `Token exchange failed: ${errorData.error_description || errorData.error}`,
            context,
          );
        }

        const tokens = await response.json();

        return {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type || 'Bearer',
          expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          scope: tokens.scope,
        };
      } catch (error) {
        throw new AuthenticationError(
          `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
          context,
          error instanceof Error ? error : undefined,
        );
      }
    }, context)();
  }

  /**
   * Refresh expired tokens
   */
  async refreshTokens(credentials: Credentials): Promise<Credentials> {
    const context: ErrorContext = {
      operation: 'refresh-tokens',
      metadata: { hasRefreshToken: !!credentials.refresh_token },
    };

    return ErrorUtils.withErrorContext(async () => {
      if (!credentials.refresh_token) {
        throw new AuthenticationError(
          'No refresh token available. Re-authentication required.',
          context,
        );
      }

      const refreshRequestBody = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId || this.PUBLIC_CLIENT_ID,
        client_secret: this.config.clientSecret || this.CLIENT_SECRET,
        refresh_token: credentials.refresh_token,
      });

      try {
        const response = await NetworkUtils.fetchWithRetry(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: refreshRequestBody,
          },
          { timeout: getNetworkConfig().timeout },
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new AuthenticationError(
            `Token refresh failed: ${errorData.error_description || errorData.error}`,
            context,
          );
        }

        const tokens = await response.json();

        return {
          ...credentials,
          access_token: tokens.access_token,
          expiry_date: tokens.expires_in
            ? Date.now() + tokens.expires_in * 1000
            : credentials.expiry_date,
          refresh_token: tokens.refresh_token || credentials.refresh_token, // Keep existing if not provided
        };
      } catch (error) {
        throw new AuthenticationError(
          `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          context,
          error instanceof Error ? error : undefined,
        );
      }
    }, context)();
  }

  /**
   * Create authenticated Google API client
   */
  createAuthenticatedClient(credentials: Credentials): any {
    // Return a simple object that can be used by DriveClient
    return {
      credentials: {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        token_type: credentials.token_type,
        expiry_date: credentials.expiry_date,
      },
      // Add method to get headers for API requests
      getHeaders: () => ({
        Authorization: `${credentials.token_type || 'Bearer'} ${credentials.access_token}`,
        'Content-Type': 'application/json',
      }),
    };
  }

  /**
   * Clear stored credentials
   */
  async clearCredentials(): Promise<void> {
    await this.tokenStorage.clear();
  }

  /**
   * Detect if running in Node.js environment
   */
  private isNode(): boolean {
    return typeof process !== 'undefined' && process.versions && !!process.versions.node;
  }

  /**
   * Open browser (Node.js only)
   */
  private openBrowser(url: string): void {
    if (!this.isNode()) return;

    try {
      const { exec } = require('child_process');
      const start =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';

      exec(`${start} "${url}"`, (error: any) => {
        if (error) {
          console.log('Could not automatically open browser. Please manually visit the URL above.');
        }
      });
    } catch (error) {
      console.log('Could not automatically open browser. Please manually visit the URL above.');
    }
  }
}
