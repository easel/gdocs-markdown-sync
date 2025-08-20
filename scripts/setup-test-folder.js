#!/usr/bin/env bun

// Script to create a test folder for integration tests using modern DriveAPI
import { DriveAPI } from '../src/drive/DriveAPI.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Load CLI PKCE tokens
async function loadCLIToken(profile = 'default') {
  const configDir = path.join(os.homedir(), '.config', 'gdocs-markdown-sync');
  const tokenPath = path.join(configDir, `tokens-${profile}.json`);

  try {
    const data = await fs.readFile(tokenPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`No CLI tokens found or could not read them: ${error.message}`);
  }
}

async function setupTestFolder() {
  try {
    console.log('🔧 Setting up test folder for integration tests...');

    // Load credentials
    const credentials = await loadCLIToken('default');
    console.log('✅ Loaded credentials');

    // Create DriveAPI instance
    const driveAPI = new DriveAPI(credentials.access_token);

    // Create a test folder
    const folderName = `gdocs-markdown-sync-tests-${Date.now()}`;
    console.log(`📁 Creating test folder: ${folderName}`);

    const folder = await driveAPI.createFolder(folderName);
    console.log(`✅ Created test folder with ID: ${folder.id}`);

    // Create a test document in the folder
    const docContent = `# Test Document

This is a test document for integration testing.

## Features
- **Bold text**
- *Italic text* 
- Regular text

Created: ${new Date().toISOString()}`;

    console.log('📄 Creating test document...');
    const doc = await driveAPI.uploadMarkdownAsDoc('Test Document', docContent, folder.id);
    console.log(`✅ Created test document with ID: ${doc.id}`);

    console.log('\n🎯 Integration Test Configuration:');
    console.log('');
    console.log('Update your integration tests to use:');
    console.log(`TEST_FOLDER_ID=${folder.id}`);
    console.log(`TEST_DOC_ID=${doc.id}`);
    console.log('');
    console.log(
      'You can also set these as environment variables or update the test files directly.',
    );
  } catch (error) {
    console.error('❌ Failed to setup test folder:', error);
    process.exit(1);
  }
}

setupTestFolder();
