// Test authentication system
import { describe, it, expect } from 'bun:test';

import { TokenLoader, Credentials } from './TokenLoader';
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
    it('should create UnifiedOAuthManager instance', () => {
      const authManager = new UnifiedOAuthManager({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
      expect(authManager).toBeDefined();
    });

    it('should create UnifiedOAuthManager with default config', () => {
      const authManager = new UnifiedOAuthManager({});
      expect(authManager).toBeDefined();
    });

    it('should create UnifiedOAuthManager with custom scopes', () => {
      const authManager = new UnifiedOAuthManager({
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      expect(authManager).toBeDefined();
    });
  });
});
