#!/usr/bin/env node
/**
 * CI/CD Contract Testing Script
 * Runs API contract validation in continuous integration
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const COLORS = {
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
};

function log(message, color = COLORS.RESET) {
  console.log(`${color}${message}${COLORS.RESET}`);
}

function runCommand(command, description) {
  log(`\n${COLORS.BLUE}📋 ${description}${COLORS.RESET}`);
  log(`   Command: ${command}`);

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    log(`${COLORS.GREEN}✅ ${description} passed${COLORS.RESET}`);

    // Log output if it contains warnings or important info
    if (output.includes('⚠️') || output.includes('🚨') || output.includes('💡')) {
      log('\n📊 Important output:');
      console.log(output);
    }

    return { success: true, output };
  } catch (error) {
    log(`${COLORS.RED}❌ ${description} failed${COLORS.RESET}`);
    console.error(error.stdout || error.message);
    return { success: false, error: error.message };
  }
}

async function main() {
  log(`${COLORS.BOLD}🔧 Google Docs Sync - API Contract Testing${COLORS.RESET}`);
  log('This script validates API contracts between plugin and DriveAPI\n');

  const results = [];

  // 1. API Contract Tests
  results.push(
    runCommand('bun test src/tests/api-contract.test.ts --reporter=tap', 'API Contract Validation'),
  );

  // 2. Plugin Workflow Tests
  results.push(
    runCommand(
      'bun test src/tests/plugin-workflows.test.ts --reporter=tap',
      'Plugin Workflow Integration',
    ),
  );

  // 3. API Gap Detection
  results.push(
    runCommand(
      'bun test src/tests/api-gap-detector.test.ts --reporter=tap',
      'Automated Gap Detection',
    ),
  );

  // 4. Mock vs Real API Tests
  results.push(
    runCommand(
      'bun test src/tests/mock-vs-real.test.ts --reporter=tap',
      'Mock vs Real API Consistency',
    ),
  );

  // 5. Type Contract Tests
  results.push(
    runCommand(
      'bun test src/tests/type-contracts.test.ts --reporter=tap',
      'TypeScript Contract Validation',
    ),
  );

  // 6. Build Plugin to Catch Compilation Issues
  results.push(runCommand('bun run build:plugin', 'Plugin Build Verification'));

  // Summary
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  log('\n' + '='.repeat(60));
  log(`${COLORS.BOLD}📊 CONTRACT TESTING SUMMARY${COLORS.RESET}`);
  log('='.repeat(60));

  if (failed === 0) {
    log(`${COLORS.GREEN}✅ All ${passed} contract tests passed!${COLORS.RESET}`);
    log(`${COLORS.GREEN}🎉 API contracts are valid and complete${COLORS.RESET}`);
  } else {
    log(`${COLORS.RED}❌ ${failed} contract test(s) failed, ${passed} passed${COLORS.RESET}`);
    log(`${COLORS.YELLOW}⚠️  API contract violations detected${COLORS.RESET}`);
  }

  // Generate CI output
  const ciOutput = {
    timestamp: new Date().toISOString(),
    passed,
    failed,
    total: results.length,
    results: results.map((r) => ({
      success: r.success,
      error: r.error || null,
    })),
  };

  // Write CI results for other tools
  fs.writeFileSync('contract-test-results.json', JSON.stringify(ciOutput, null, 2));
  log(`\n📁 Results written to: contract-test-results.json`);

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log(`${COLORS.RED}💥 Contract testing failed: ${error.message}${COLORS.RESET}`);
    process.exit(1);
  });
}
