import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { TokenStorage, Credentials } from './TokenStorage';

/**
 * Filesystem-based token storage for CLI environment
 */
export class FilesystemTokenStorage implements TokenStorage {
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

  async load(): Promise<Credentials | null> {
    try {
      const tokenPath = this.getTokenPath();
      const data = await fs.readFile(tokenPath, 'utf8');
      const tokens = JSON.parse(data);

      // Validate that we have the minimum required tokens
      if (!tokens.access_token) {
        console.log('Tokens found but missing access_token');
        return null;
      }

      console.log('Successfully loaded tokens from:', tokenPath);
      return tokens;
    } catch (error) {
      console.log('No tokens found or could not read them:', (error as Error).message);
      return null;
    }
  }

  async save(credentials: Credentials): Promise<void> {
    const dir = this.getTokenDir();
    const file = this.getTokenPath();
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(credentials, null, 2), 'utf8');
      console.log(`Saved tokens to ${file}`);
    } catch (err) {
      console.error('Failed to save tokens:', (err as Error).message);
      throw err;
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.getTokenPath());
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.getTokenPath());
      console.log('Cleared tokens from filesystem');
    } catch (error) {
      console.log('No tokens to clear or error clearing:', (error as Error).message);
    }
  }
}
