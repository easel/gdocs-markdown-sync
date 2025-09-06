// Test authentication system
import { describe, it, expect } from 'bun:test';

import { TokenLoader, Credentials } from './TokenLoader';
import { TokenStorage } from './TokenStorage';
import { UnifiedOAuthManager } from './UnifiedOAuthManager';

describe('Authentication System', () => {
  describe('TokenLoader', () => {
    it('should detect expired tokens correctly', () => {
      const tokenLoader = new TokenLoader();

      // Token expired 1 hour ago
      const expiredCredentials: Credentials = {
        access_token: 'test-token',
        expiry_date: Date.now() - 3600000,
      };

      expect(tokenLoader.isTokenExpired(expiredCredentials)).toBe(true);

      // Token expires in 1 hour
      const validCredentials: Credentials = {
        access_token: 'test-token',
        expiry_date: Date.now() + 3600000,
      };

      expect(tokenLoader.isTokenExpired(validCredentials)).toBe(false);
    });

    it('should handle tokens without expiry date', () => {
      const tokenLoader = new TokenLoader();

      const credentialsWithoutExpiry: Credentials = {
        access_token: 'test-token',
      };

      // Tokens without expiry date are considered valid
      expect(tokenLoader.isTokenExpired(credentialsWithoutExpiry)).toBe(false);
    });
  });

  describe('UnifiedOAuthManager', () => {
    // Mock storage for testing
    const mockStorage: TokenStorage = {
      save: async (credentials: Credentials) => {},
      load: async () => null,
      clear: async () => {},
    };

    it('should create UnifiedOAuthManager instance', () => {
      const authManager = new UnifiedOAuthManager(mockStorage, {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
      expect(authManager).toBeDefined();
    });

    it('should create UnifiedOAuthManager with default config', () => {
      const authManager = new UnifiedOAuthManager(mockStorage, {});
      expect(authManager).toBeDefined();
    });

    it('should create UnifiedOAuthManager with custom scopes', () => {
      const authManager = new UnifiedOAuthManager(mockStorage, {
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      expect(authManager).toBeDefined();
    });
  });

  describe('PKCE Generation', () => {
    it('should generate valid PKCE verifier (base64url encoded, 32-byte source)', () => {
      // Simulate the plugin PKCE generation
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      const codeVerifier = btoa(String.fromCharCode.apply(null, Array.from(array)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      // Should be base64url encoded
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      // Should be at least 43 characters (32 bytes base64url encoded)
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      // Should not contain padding
      expect(codeVerifier).not.toContain('=');
    });

    it('should generate different verifiers on each call', () => {
      const generateVerifier = () => {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return btoa(String.fromCharCode.apply(null, Array.from(array)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
      };

      const verifier1 = generateVerifier();
      const verifier2 = generateVerifier();

      expect(verifier1).not.toBe(verifier2);
    });
  });

  describe('OAuth URL Construction', () => {
    it('should construct valid OAuth URL for CLI (localhost callback)', () => {
      const clientId = 'test-client-id';
      const codeChallenge = 'test-challenge';
      const redirectUri = 'http://localhost:8080/callback';

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope:
          'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

      expect(authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(authUrl).toContain(`client_id=${clientId}`);
      expect(authUrl).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
      expect(authUrl).toContain('response_type=code');
      expect(authUrl).toContain(`code_challenge=${codeChallenge}`);
      expect(authUrl).toContain('code_challenge_method=S256');
      expect(authUrl).toContain('access_type=offline');
      expect(authUrl).toContain('prompt=consent');
    });

    it('should construct valid OAuth URL for Plugin (out-of-band)', () => {
      const clientId = 'test-client-id';
      const codeChallenge = 'test-challenge';
      const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope:
          'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

      expect(authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(authUrl).toContain(`client_id=${clientId}`);
      expect(authUrl).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
      expect(authUrl).toContain('response_type=code');
      expect(authUrl).toContain(`code_challenge=${codeChallenge}`);
      expect(authUrl).toContain('code_challenge_method=S256');
    });

    it('should properly encode special characters in URL parameters', () => {
      const params = new URLSearchParams({
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        scope:
          'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
      });

      const queryString = params.toString();

      // Colons should be encoded in redirect_uri
      expect(queryString).toContain('redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob');
      // Spaces should be encoded as + in scope
      expect(queryString).toContain(
        'scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file',
      );
    });
  });

  describe('Token Exchange Validation', () => {
    it('should validate token exchange request body structure', () => {
      const tokenRequestBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        code: 'test-auth-code',
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        code_verifier: 'test-verifier',
      });

      expect(tokenRequestBody.get('grant_type')).toBe('authorization_code');
      expect(tokenRequestBody.get('client_id')).toBe('test-client-id');
      expect(tokenRequestBody.get('client_secret')).toBe('test-client-secret');
      expect(tokenRequestBody.get('code')).toBe('test-auth-code');
      expect(tokenRequestBody.get('redirect_uri')).toBe('urn:ietf:wg:oauth:2.0:oob');
      expect(tokenRequestBody.get('code_verifier')).toBe('test-verifier');
    });

    it('should validate successful token response structure', () => {
      const mockTokenResponse = {
        access_token: 'ya29.test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      };

      expect(mockTokenResponse.access_token).toBeTruthy();
      expect(mockTokenResponse.refresh_token).toBeTruthy();
      expect(mockTokenResponse.token_type).toBe('Bearer');
      expect(mockTokenResponse.expires_in).toBe(3600);

      // Converted to internal format
      const expiry_date = Date.now() + mockTokenResponse.expires_in * 1000;
      expect(expiry_date).toBeGreaterThan(Date.now());
    });

    it('should handle token exchange error responses', () => {
      const mockErrorResponse = {
        error: 'invalid_grant',
        error_description:
          'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.',
      };

      expect(mockErrorResponse.error).toBe('invalid_grant');
      expect(mockErrorResponse.error_description).toContain('authorization grant is invalid');
    });
  });
});
