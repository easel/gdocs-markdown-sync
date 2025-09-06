export interface Credentials {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

/**
 * Browser-compatible token loader for Obsidian plugin
 * Cannot access filesystem, only provides error messages
 */
export class BrowserTokenLoader {
  private _profile: string;

  constructor(_profile?: string) {
    this._profile = _profile && _profile.trim() ? _profile.trim() : 'default';
  }

  /**
   * Plugin cannot load tokens from filesystem - redirect to CLI
   */
  async loadFromCLI(): Promise<Credentials | null> {
    console.warn(
      `Plugin cannot access CLI tokens directly for profile '${this._profile}'. Please ensure you have authenticated via CLI first.`,
    );
    return null;
  }

  /**
   * Plugin cannot save tokens to filesystem - redirect to CLI
   */
  async saveToCLI(_credentials: Credentials): Promise<void> {
    throw new Error('Plugin cannot save tokens. Please use CLI for authentication.');
  }

  /**
   * Get tokens (plugin cannot access CLI tokens)
   */
  getTokens(): Credentials | null {
    // Browser/plugin context cannot access filesystem tokens
    return null;
  }

  /**
   * Checks if tokens are expired
   */
  isTokenExpired(credentials: Credentials): boolean {
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
}
