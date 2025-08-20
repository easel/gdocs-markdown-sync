export interface Credentials {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

/**
 * Abstract interface for token storage
 * Allows different implementations for CLI (filesystem) and Obsidian (plugin data)
 */
export interface TokenStorage {
  /**
   * Load credentials from storage
   */
  load(): Promise<Credentials | null>;

  /**
   * Save credentials to storage
   */
  save(credentials: Credentials): Promise<void>;

  /**
   * Check if credentials exist in storage
   */
  exists(): Promise<boolean>;

  /**
   * Clear credentials from storage
   */
  clear(): Promise<void>;
}

/**
 * Utility functions for token management
 */
export class TokenUtils {
  /**
   * Checks if tokens are expired
   */
  static isTokenExpired(credentials: Credentials): boolean {
    if (!credentials.expiry_date) {
      return false; // No expiry date means it doesn't expire
    }

    const now = Date.now();
    const expiry =
      typeof credentials.expiry_date === 'number'
        ? credentials.expiry_date
        : new Date(credentials.expiry_date as any).getTime();

    // Add 5-minute buffer to refresh before actual expiry
    const buffer = 5 * 60 * 1000;

    return now >= expiry - buffer;
  }

  /**
   * Validates that credentials have required fields
   */
  static validateCredentials(credentials: Credentials): boolean {
    return !!(credentials.access_token && credentials.refresh_token);
  }
}
