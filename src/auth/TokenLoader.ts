import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface Credentials {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

export class TokenLoader {
  private profile: string;

  constructor(profile?: string) {
    this.profile = profile && profile.trim() ? profile.trim() : 'default';
  }

  private getTokenDir(): string {
    return path.join(os.homedir(), '.config', 'google-docs-sync');
  }

  private getTokenPath(): string {
    const file = `tokens-${this.profile}.json`;
    return path.join(this.getTokenDir(), file);
  }

  /**
   * Attempts to load existing tokens from the Go CLI (or previously saved)
   */
  async loadFromCLI(): Promise<Credentials | null> {
    try {
      const tokenPath = this.getTokenPath();
      const data = await fs.readFile(tokenPath, 'utf8');
      const tokens = JSON.parse(data);

      // Validate that we have the minimum required tokens
      if (!tokens.access_token) {
        console.log('CLI tokens found but missing access_token');
        return null;
      }

      console.log('Successfully loaded tokens from CLI:', tokenPath);
      return tokens;
    } catch (error) {
      console.log('No CLI tokens found or could not read them:', (error as Error).message);
      return null; // No CLI tokens found
    }
  }

  /**
   * Persists tokens to the same location as CLI (profile-aware)
   */
  async saveToCLI(credentials: Credentials): Promise<void> {
    const dir = this.getTokenDir();
    const file = this.getTokenPath();
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(credentials, null, 2), 'utf8');
      console.log(`Saved tokens to ${file}`);
    } catch (err) {
      console.error('Failed to save tokens:', (err as Error).message);
    }
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
