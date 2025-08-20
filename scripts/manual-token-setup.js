#!/usr/bin/env bun

// Manual token setup script for testing when OAuth flow has issues
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function manualTokenSetup() {
  console.log('🔧 Manual Token Setup for Testing');
  console.log('');
  console.log('Since the OAuth flow is having issues, you can manually set up credentials:');
  console.log('');
  console.log('1. Go to https://developers.google.com/oauthplayground');
  console.log('2. In Step 1, select "Drive API v3" and "Docs API v1" scopes');
  console.log('3. Click "Authorize APIs" and complete the OAuth flow');
  console.log('4. In Step 2, click "Exchange authorization code for tokens"');
  console.log('5. Copy the access_token and refresh_token from the response');
  console.log('');
  console.log('Then create a file at ~/.config/gdocs-markdown-sync/tokens-default.json with:');
  console.log('');
  console.log(
    JSON.stringify(
      {
        access_token: 'YOUR_ACCESS_TOKEN_HERE',
        refresh_token: 'YOUR_REFRESH_TOKEN_HERE',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000, // 1 hour from now
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents',
      },
      null,
      2,
    ),
  );
  console.log('');

  const dir = path.join(os.homedir(), '.config', 'gdocs-markdown-sync');
  await ensureDir(dir);
  const tokenPath = path.join(dir, 'tokens-default.json');

  console.log(`Save this to: ${tokenPath}`);
  console.log('');
  console.log('After setting up the tokens manually, you can run integration tests with:');
  console.log('bun run test:integration');
}

manualTokenSetup().catch(console.error);
