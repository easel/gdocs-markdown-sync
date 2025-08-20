// YAML frontmatter parsing edge cases and fixes
import { describe, it, expect } from 'bun:test';

import { parseFrontMatter, buildFrontMatter } from './fs/frontmatter';

describe('YAML Frontmatter Parsing Edge Cases', () => {
  describe('Problematic YAML that should fail gracefully', () => {
    it('should handle frontmatter with unescaped XML/HTML tags', () => {
      const problematicContent = `---
name: test-agent
description: Use this agent when needed. Examples:

<example>
Context: The user has just written code
user: "I've implemented something"
assistant: "I'll review this"
</example>

<example>
Context: Another scenario
</example>
model: opus
---

# Test Document

Content here.`;

      // This should now parse gracefully with our recovery mechanism
      const result = parseFrontMatter(problematicContent);
      expect(result.data.name).toBe('test-agent');
      expect(result.data.description).toContain('Examples:');
      expect(result.content.trim()).toBe('# Test Document\n\nContent here.');
    });

    it('should handle frontmatter with unescaped special characters', () => {
      const problematicContent = `---
name: test
description: This has "quotes" and: colons and [brackets] and other stuff
field: value with: embedded colons
---

# Content`;

      // This might cause issues depending on the content
      const result = parseFrontMatter(problematicContent);
      expect(result.data.name).toBe('test');
    });

    it('should handle frontmatter with multiline strings without proper escaping', () => {
      const problematicContent = `---
name: test
description: This is a very long description that spans multiple lines
  and contains various special characters like colons: semicolons;
  and other punctuation that might confuse YAML parsers.
  
  It also has nested content like <tags> and other markup.
model: opus
---

# Content`;

      // This should either work or be fixable
      expect(() => {
        parseFrontMatter(problematicContent);
      }).not.toThrow();
    });
  });

  describe('YAML Sanitization', () => {
    it('should sanitize frontmatter with XML/HTML-like content', () => {
      const unsafeYaml = {
        name: 'test-agent',
        description: `Use this agent when needed. Examples:

<example>
Context: The user has code
user: "I've implemented something"
assistant: "I'll review this"
</example>

More content here.`,
        model: 'opus',
      };

      // Should be able to build this without errors
      const content = 'Test content';
      expect(() => {
        buildFrontMatter(unsafeYaml, content);
      }).not.toThrow();
    });

    it('should handle edge cases in field values', () => {
      const edgeCaseData = {
        name: 'test',
        description: 'Has "quotes" and: colons and [brackets]',
        complexField: 'Line 1\nLine 2\nLine 3',
        specialChars: '!@#$%^&*()_+-={}[]|\\:";\'<>?,./',
        emptyField: '',
        nullField: null,
        undefinedField: undefined,
      };

      const content = 'Test content';
      expect(() => {
        buildFrontMatter(edgeCaseData, content);
      }).not.toThrow();
    });
  });

  describe('Real-world problematic files', () => {
    it('should handle the healthcare-compliance-auditor.md pattern', () => {
      // Reproduce the exact pattern that failed
      const problematicYaml = {
        name: 'healthcare-compliance-auditor',
        description: `Use this agent when you need to review healthcare-related code. Examples:\n\n<example>\nContext: The user has just written code\nuser: "I've implemented a function"\nassistant: "I see you've implemented something"\n</example>\n\n<example>\nContext: Another scenario\n</example>`,
        model: 'opus',
        color: 'red',
      };

      const content = 'Agent documentation content';

      // Should be able to build this
      const result = buildFrontMatter(problematicYaml, content);
      expect(result).toContain('---');
      expect(result).toContain('healthcare-compliance-auditor');

      // Should be able to parse it back
      const parsed = parseFrontMatter(result);
      expect(parsed.data.name).toBe('healthcare-compliance-auditor');
    });

    it('should handle the enterprise-architect-reviewer.md pattern', () => {
      const problematicYaml = {
        name: 'enterprise-architect-reviewer',
        description: `Use this agent when you need expert review. <example>Context: User wants review user: "I've updated architecture" assistant: "I'll review it" <commentary>Use the agent</commentary></example>`,
        model: 'opus',
        color: 'blue',
      };

      const content = 'Enterprise architect content';

      // Should be able to build this
      const result = buildFrontMatter(problematicYaml, content);
      expect(result).toContain('---');

      // Should be able to parse it back
      const parsed = parseFrontMatter(result);
      expect(parsed.data.name).toBe('enterprise-architect-reviewer');
    });
  });

  describe('Roundtrip integrity with complex content', () => {
    it('should maintain roundtrip integrity with complex YAML', () => {
      const complexData = {
        name: 'complex-test',
        description: 'Multi-line\nwith special chars: <>&"\'',
        array: ['item1', 'item2', 'item3'],
        nested: {
          subfield: 'value',
          number: 42,
        },
        multilineString: `Line 1
Line 2
Line 3 with special: chars`,
      };

      const originalContent = 'Original markdown content';

      // Build frontmatter
      const built = buildFrontMatter(complexData, originalContent);

      // Parse it back
      const parsed = parseFrontMatter(built);

      // Should preserve the original content
      expect(parsed.content.trim()).toBe(originalContent);
      expect(parsed.data.name).toBe(complexData.name);
      expect(parsed.data.nested.subfield).toBe(complexData.nested.subfield);
    });
  });
});
