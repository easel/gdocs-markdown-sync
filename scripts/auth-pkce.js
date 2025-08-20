#!/usr/bin/env node

// PKCE OAuth authentication script for integration tests
// This script uses the same PKCE flow that the Obsidian plugin will use in production

const { PKCEOAuthManager } = require('../src/auth/PKCEOAuthManager');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function runPKCEAuth() {
  console.log('🔐 Starting PKCE OAuth authentication for integration tests...');
  console.log('✅ No client secrets required - this is the secure desktop app approach!');

  try {
    const pkceManager = new PKCEOAuthManager();
    console.log('\n📖 Starting PKCE OAuth flow...');

    const credentials = await pkceManager.startAuthFlow();

    // Save tokens to plugin directory
    const pluginConfigDir = path.join(os.homedir(), '.obsidian', 'plugins', 'gdocs-sync');

    // Create directory if it doesn't exist
    try {
      fs.mkdirSync(pluginConfigDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }

    const tokenPath = path.join(pluginConfigDir, 'pkce-tokens.json');
    fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2));

    console.log('\n✅ PKCE authentication successful!');
    console.log(`📁 Tokens saved to: ${tokenPath}`);
    console.log('\n🧪 You can now run integration tests:');
    console.log('   npm run test:integration');
  } catch (error) {
    console.error('\n❌ PKCE authentication failed:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('  - Make sure you have a public OAuth client ID configured');
    console.log('  - Check that Google Drive API is enabled in your project');
    console.log('  - Verify the redirect URI is http://localhost in your OAuth client settings');
    process.exit(1);
  }
}

if (require.main === module) {
  runPKCEAuth();
}

module.exports = { runPKCEAuth };
