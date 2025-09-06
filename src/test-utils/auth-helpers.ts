import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { DriveAPI } from '../drive/DriveAPI';

/**
 * Check if CLI authentication tokens are available for integration tests
 */
export function checkAuthenticationAvailable(): boolean {
  // Check for service account (optional for CI)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return true;
  }

  // Check for existing CLI tokens (PKCE-based)
  return checkCLITokenExists();
}

/**
 * Check if CLI tokens exist for a profile
 */
export function checkCLITokenExists(profile: string = 'default'): boolean {
  try {
    const tokenDir = path.join(os.homedir(), '.config', 'google-docs-sync');
    const tokenFile = path.join(tokenDir, `tokens-${profile}.json`);

    // Check if token file exists synchronously for test setup
    const stats = require('fs').statSync(tokenFile);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Load CLI tokens for integration tests
 */
export async function loadCLIToken(profile: string = 'default'): Promise<any> {
  const tokenDir = path.join(os.homedir(), '.config', 'google-docs-sync');
  const tokenFile = path.join(tokenDir, `tokens-${profile}.json`);

  try {
    const tokenData = await fs.readFile(tokenFile, 'utf8');
    const tokens = JSON.parse(tokenData);

    if (!tokens.access_token) {
      throw new Error('CLI tokens found but missing access_token');
    }

    return tokens;
  } catch (error) {
    throw new Error(`Could not load CLI tokens: ${(error as Error).message}`);
  }
}

/**
 * Create authenticated DriveAPI client for integration tests
 */
export async function createLiveDriveClient(): Promise<DriveAPI> {
  const credentials = await loadCLIToken();
  return new DriveAPI(credentials.access_token, credentials.token_type || 'Bearer');
}
