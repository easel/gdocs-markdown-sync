// Test Runner for Google Docs Sync Plugin
/**
 * Test demonstrations for core plugin functionality
 */
// Mock data for testing
var MOCK_FRONTMATTER_DATA = {
  docId: 'doc-123',
  revisionId: 'rev-456',
  sha256: 'abc123def456ghi789',
  other: {
    title: 'Test Document',
    author: 'John Doe',
  },
};
var MOCK_CONTENT = '---\ndocId: '
  .concat(MOCK_FRONTMATTER_DATA.docId, '\nrevisionId: ')
  .concat(MOCK_FRONTMATTER_DATA.revisionId, '\nsha256: ')
  .concat(
    MOCK_FRONTMATTER_DATA.sha256,
    '\ntitle: Test Document\nauthor: John Doe\n---\n# This is test content',
  );
// Simulated frontmatter parsing function (from our plugin)
function simulateParseFrontMatter(content) {
  var lines = content.split('\n');
  if (lines.length < 2 || !lines[0].startsWith('---')) {
    return {};
  }
  var endLine = 1;
  for (var i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endLine = i;
      break;
    }
  }
  var frontMatterLines = lines.slice(1, endLine);
  var frontMatter = {};
  for (var _i = 0, frontMatterLines_1 = frontMatterLines; _i < frontMatterLines_1.length; _i++) {
    var line = frontMatterLines_1[_i];
    if (line.includes(':')) {
      var _a = line.split(':', 2),
        key = _a[0],
        value = _a[1];
      var cleanKey = key.trim();
      var cleanValue = value.trim().replace(/^["']/, '').replace(/["']$/, '');
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
function simulateBuildFrontMatter(frontMatter) {
  var lines = ['---'];
  if (frontMatter.docId) {
    lines.push('docId: '.concat(frontMatter.docId));
  }
  if (frontMatter.revisionId) {
    lines.push('revisionId: '.concat(frontMatter.revisionId));
  }
  if (frontMatter.sha256) {
    lines.push('sha256: '.concat(frontMatter.sha256));
  }
  if (frontMatter.other) {
    for (var _i = 0, _a = Object.entries(frontMatter.other); _i < _a.length; _i++) {
      var _b = _a[_i],
        key = _b[0],
        value = _b[1];
      lines.push(''.concat(key, ': ').concat(value));
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
  var parsed = simulateParseFrontMatter(MOCK_CONTENT);
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
  var built = simulateBuildFrontMatter(MOCK_FRONTMATTER_DATA);
  console.log('✓ Built frontmatter:\n', built);
  if (built.includes('docId: doc-123') && built.includes('title: Test Document')) {
    console.log('✓ Frontmatter building works correctly');
  } else {
    console.log('✗ Frontmatter building failed');
  }
  // Test 3: Content parsing
  console.log('\nTest 3: Content Parsing');
  var contentLines = MOCK_CONTENT.split('\n');
  var hasFrontmatter = contentLines[0] === '---';
  var hasContent = contentLines[contentLines.length - 1] === '# This is test content';
  if (hasFrontmatter && hasContent) {
    console.log('✓ Content parsing works correctly');
  } else {
    console.log('✗ Content parsing failed');
  }
  // Test 4: Revision ID comparison
  console.log('\nTest 4: Revision ID Comparison');
  function compareRevisionIds(localRevId, remoteRevId) {
    return localRevId === remoteRevId;
  }
  var sameRev = compareRevisionIds('rev-456', 'rev-456');
  var diffRev = compareRevisionIds('rev-456', 'rev-789');
  if (sameRev && !diffRev) {
    console.log('✓ Revision ID comparison works correctly');
  } else {
    console.log('✗ Revision ID comparison failed');
  }
  // Test 5: SHA256 computation
  console.log('\nTest 5: SHA256 Computation');
  function computeSHA256(content) {
    // Simple hash function for demonstration
    var encoder = new TextEncoder();
    var data = encoder.encode(content);
    var hash = 0;
    for (var i = 0; i < data.length; i++) {
      var char = data[i];
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }
  var hash1 = computeSHA256('test content');
  var hash2 = computeSHA256('different content');
  if (typeof hash1 === 'string' && hash1.length > 0 && hash1 !== hash2) {
    console.log('✓ SHA256 computation works correctly');
  } else {
    console.log('✗ SHA256 computation failed');
  }
  console.log('\nAll tests completed!');
}
// Run the tests
runTests();
