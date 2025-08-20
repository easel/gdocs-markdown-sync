import { describe, it, expect, beforeEach } from 'bun:test';

import { parseArgs, getFlag } from './cli_utils';

describe('cli_utils', () => {
  describe('parseArgs', () => {
    it('parses command and long flags with equals', () => {
      const { cmd, flags } = parseArgs([
        'node',
        'cli',
        'pull',
        '--drive-folder-id=abc',
        '--local-dir=./docs',
      ]);
      expect(cmd).toBe('pull');
      expect(flags['drive-folder-id']).toBe('abc');
      expect(flags['local-dir']).toBe('./docs');
    });

    it('parses flags with space-separated values', () => {
      const { cmd, flags } = parseArgs([
        'node',
        'cli',
        'push',
        '--drive-folder-id',
        'xyz',
        '--local-dir',
        'docs',
      ]);
      expect(cmd).toBe('push');
      expect(flags['drive-folder-id']).toBe('xyz');
      expect(flags['local-dir']).toBe('docs');
    });

    it('sets boolean flags to true when no value', () => {
      const { cmd, flags } = parseArgs(['node', 'cli', 'sync', '--watch']);
      expect(cmd).toBe('sync');
      expect(flags['watch']).toBe('true');
    });
  });

  describe('getFlag', () => {
    const OLD_ENV = process.env;
    beforeEach(() => {
      process.env = { ...OLD_ENV };
    });
    it('returns flag value when present', () => {
      const val = getFlag({ a: 'x' }, 'a', 'ENV_A');
      expect(val).toBe('x');
    });
    it('falls back to env when not present', () => {
      process.env['ENV_B'] = 'y';
      const val = getFlag({}, 'b', 'ENV_B');
      expect(val).toBe('y');
    });
    it('returns undefined when not found', () => {
      const val = getFlag({}, 'c');
      expect(val).toBeUndefined();
    });
  });
});
