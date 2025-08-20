// Test dependencies are properly installed
import { describe, it, expect } from 'bun:test';

describe('Dependencies Test', () => {
  it('should import gray-matter', async () => {
    const matter = await import('gray-matter');
    expect(matter.default).toBeDefined();
    expect(typeof matter.default).toBe('function');
  });

  it('should import js-yaml', async () => {
    const yaml = await import('js-yaml');
    expect(yaml.load).toBeDefined();
    expect(typeof yaml.load).toBe('function');
  });

  it('should import express', async () => {
    const express = await import('express');
    expect(express.default).toBeDefined();
    expect(typeof express.default).toBe('function');
  });

  it('should compute real SHA256', async () => {
    const crypto = await import('crypto');
    const content = 'test content';
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    // Verify it's a 64-character hex string (SHA256)
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe('6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72');
  });
});
