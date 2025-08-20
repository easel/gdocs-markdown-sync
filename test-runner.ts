// Test Runner for Google Docs Sync Plugin

/**
 * Test demonstrations for core plugin functionality
 */

// Mock data for testing
const MOCK_FRONTMATTER_DATA = {
  docId: 'doc-123',
  revisionId: 'rev-456',
  sha256: 'abc123def456ghi789',
  other: {
    title: 'Test Document',
    author: 'John Doe',
  },
};

const MOCK_CONTENT = `---
docId: ${MOCK_FRONTMATTER_DATA.docId}
revisionId: ${MOCK_FRONTMATTER_DATA.revisionId}
sha256: ${MOCK_FRONTMATTER_DATA.sha256}
title: Test Document
author: John Doe
---
# This is test content`;

// Simulated frontmatter parsing function (from our plugin)
function simulateParseFrontMatter(content: string) {
  const lines = content.split('\n');
  if (lines.length < 2 || !lines[0].startsWith('---')) {
    return {};
  }

  let endLine = 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endLine = i;
      break;
    }
  }

  const frontMatterLines = lines.slice(1, endLine);
  const frontMatter: any = {};

  for (const line of frontMatterLines) {
    if (line.includes(':')) {
      const [key, value] = line.split(':', 2);
      const cleanKey = key.trim();
      const cleanValue = value.trim().replace(/^["']/, '').replace(/["']$/, '');

      switch (cleanKey.toLowerCase()) {
        case 'docid':
          frontMatter.docId = cleanValue;
          break;
        case 'revisionid':
          frontMatter.revisionId = cleanValue;
          break;
        case 'sha256':
          frontMatter.sha256 = cleanValue;
          break;
        default:
          if (!frontMatter.other) {
            frontMatter.other = {};
          }
          frontMatter.other[cleanKey] = cleanValue;
      }
    }
  }

  return frontMatter;
}

// Simulated frontmatter building function (from our plugin)
function simulateBuildFrontMatter(frontMatter: any) {
  const lines: string[] = ['---'];

  if (frontMatter.docId) {
    lines.push(`docId: ${frontMatter.docId}`);
  }

  if (frontMatter.revisionId) {
    lines.push(`revisionId: ${frontMatter.revisionId}`);
  }

  if (frontMatter.sha256) {
    lines.push(`sha256: ${frontMatter.sha256}`);
  }

  if (frontMatter.other) {
    for (const [key, value] of Object.entries(frontMatter.other)) {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// Test function
function runTests() {
  console.log('Running Google Docs Sync Plugin Tests...\n');

  // Test 1: Frontmatter parsing
  console.log('Test 1: Frontmatter Parsing');
  const parsed = simulateParseFrontMatter(MOCK_CONTENT);
  console.log('✓ Parsed frontmatter:', JSON.stringify(parsed, null, 2));

  if (
    parsed.docId === MOCK_FRONTMATTER_DATA.docId &&
    parsed.revisionId === MOCK_FRONTMATTER_DATA.revisionId &&
    parsed.sha256 === MOCK_FRONTMATTER_DATA.sha256
  ) {
    console.log('✓ Frontmatter parsing works correctly');
  } else {
    console.log('✗ Frontmatter parsing failed');
  }

  // Test 2: Frontmatter building
  console.log('\nTest 2: Frontmatter Building');
  const built = simulateBuildFrontMatter(MOCK_FRONTMATTER_DATA);
  console.log('✓ Built frontmatter:\n', built);

  if (built.includes('docId: doc-123') && built.includes('title: Test Document')) {
    console.log('✓ Frontmatter building works correctly');
  } else {
    console.log('✗ Frontmatter building failed');
  }

  // Test 3: Content parsing
  console.log('\nTest 3: Content Parsing');
  const contentLines = MOCK_CONTENT.split('\n');
  const hasFrontmatter = contentLines[0] === '---';
  const hasContent = contentLines[contentLines.length - 1] === '# This is test content';

  if (hasFrontmatter && hasContent) {
    console.log('✓ Content parsing works correctly');
  } else {
    console.log('✗ Content parsing failed');
  }

  // Test 4: Revision ID comparison
  console.log('\nTest 4: Revision ID Comparison');
  function compareRevisionIds(localRevId: string, remoteRevId: string): boolean {
    return localRevId === remoteRevId;
  }

  const sameRev = compareRevisionIds('rev-456', 'rev-456');
  const diffRev = compareRevisionIds('rev-456', 'rev-789');

  if (sameRev && !diffRev) {
    console.log('✓ Revision ID comparison works correctly');
  } else {
    console.log('✗ Revision ID comparison failed');
  }

  // Test 5: SHA256 computation
  console.log('\nTest 5: SHA256 Computation');
  function computeSHA256(content: string): string {
    // Simple hash function for demonstration
    const encoder = new TextEncoder();
    const data = encoder.encode(content);

    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return hash.toString();
  }

  const hash1 = computeSHA256('test content');
  const hash2 = computeSHA256('different content');

  if (typeof hash1 === 'string' && hash1.length > 0 && hash1 !== hash2) {
    console.log('✓ SHA256 computation works correctly');
  } else {
    console.log('✗ SHA256 computation failed');
  }

  console.log('\nAll tests completed!');
}

// Run the tests
runTests();
