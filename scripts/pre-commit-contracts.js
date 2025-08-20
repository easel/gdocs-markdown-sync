#!/usr/bin/env node
/**
 * Pre-commit hook for API contract validation
 * Runs quick contract checks before allowing commits
 */

import { execSync } from 'child_process';
import fs from 'fs';

const COLORS = {
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m'
};

function log(message, color = COLORS.RESET) {
  console.log(`${color}${message}${COLORS.RESET}`);
}

function runQuickTest(testFile, description) {
  try {
    log(`${COLORS.BLUE}🔍 ${description}...${COLORS.RESET}`);
    
    const output = execSync(`bun test ${testFile} --timeout=10000`, { 
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    // Check for contract violations in output
    if (output.includes('🚨') || output.includes('Missing method') || output.includes('not found')) {
      log(`${COLORS.YELLOW}⚠️  Contract warnings detected:${COLORS.RESET}`);
      
      // Extract and show warning lines
      const lines = output.split('\n');
      lines.forEach(line => {
        if (line.includes('🚨') || line.includes('⚠️') || line.includes('Missing')) {
          log(`   ${line}`);
        }
      });
      
      return { success: true, hasWarnings: true };
    }
    
    log(`${COLORS.GREEN}✅ ${description} passed${COLORS.RESET}`);
    return { success: true, hasWarnings: false };
    
  } catch (error) {
    log(`${COLORS.RED}❌ ${description} failed${COLORS.RESET}`);
    
    // Show error details
    const errorOutput = error.stdout || error.stderr || error.message;
    if (errorOutput.includes('Missing method') || errorOutput.includes('not found')) {
      log(`${COLORS.RED}🚨 API Contract Violation:${COLORS.RESET}`);
      const lines = errorOutput.split('\n');
      lines.forEach(line => {
        if (line.includes('Missing') || line.includes('not found') || line.includes('🚨')) {
          log(`   ${line}`);
        }
      });
    }
    
    return { success: false, hasWarnings: true };
  }
}

function checkModifiedFiles() {
  try {
    // Check for modified API or plugin files
    const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
    const modifiedFiles = stagedFiles.split('\n').filter(file => file.trim());
    
    const apiFiles = modifiedFiles.filter(file => 
      file.includes('DriveAPI') || 
      file.includes('plugin-main') ||
      file.endsWith('.ts') && file.includes('src/')
    );
    
    return apiFiles;
  } catch (error) {
    // Not in a git repo or other issue - skip check
    return [];
  }
}

async function main() {
  log(`${COLORS.BOLD}🔒 Pre-commit API Contract Check${COLORS.RESET}`);
  
  const modifiedFiles = checkModifiedFiles();
  
  if (modifiedFiles.length === 0) {
    log(`${COLORS.GREEN}📝 No API-related files modified - skipping contract check${COLORS.RESET}`);
    return;
  }
  
  log(`${COLORS.BLUE}📁 API-related files modified:${COLORS.RESET}`);
  modifiedFiles.forEach(file => log(`   - ${file}`));
  log('');
  
  // Run fast contract tests
  const tests = [
    {
      file: 'src/tests/api-contract.test.ts',
      description: 'API Contract Validation'
    },
    {
      file: 'src/tests/api-gap-detector.test.ts', 
      description: 'Gap Detection'
    }
  ];
  
  let allPassed = true;
  let hasWarnings = false;
  
  for (const test of tests) {
    const result = runQuickTest(test.file, test.description);
    if (!result.success) {
      allPassed = false;
    }
    if (result.hasWarnings) {
      hasWarnings = true;
    }
  }
  
  log('\n' + '='.repeat(50));
  
  if (!allPassed) {
    log(`${COLORS.RED}❌ Pre-commit check failed!${COLORS.RESET}`);
    log(`${COLORS.RED}🚫 Commit blocked due to API contract violations${COLORS.RESET}`);
    log(`\n${COLORS.YELLOW}💡 Fix suggestions:${COLORS.RESET}`);
    log('   1. Add missing method aliases to DriveAPI');
    log('   2. Update plugin to use correct method names'); 
    log('   3. Run: bun run test:contracts for full details');
    log(`   4. Check: ${COLORS.BLUE}contract-test-results.json${COLORS.RESET} for analysis`);
    process.exit(1);
  }
  
  if (hasWarnings) {
    log(`${COLORS.YELLOW}⚠️  Contract warnings detected but commit allowed${COLORS.RESET}`);
    log(`${COLORS.YELLOW}🔧 Consider running: bun run test:contracts${COLORS.RESET}`);
  } else {
    log(`${COLORS.GREEN}✅ All contract checks passed!${COLORS.RESET}`);
  }
  
  log(`${COLORS.GREEN}🚀 Commit allowed to proceed${COLORS.RESET}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    log(`${COLORS.RED}💥 Pre-commit check failed: ${error.message}${COLORS.RESET}`);
    process.exit(1);
  });
}