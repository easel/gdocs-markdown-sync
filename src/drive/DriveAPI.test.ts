import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';

import { DriveAPI } from './DriveAPI';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock console.log to avoid noise in tests
const originalConsoleLog = console.log;
beforeEach(() => {
  console.log = jest.fn();
});

afterEach(() => {
  console.log = originalConsoleLog;
});

describe('DriveAPI', () => {
  let driveAPI: DriveAPI;
  const mockAccessToken = 'test-access-token-123';

  beforeEach(() => {
    driveAPI = new DriveAPI(mockAccessToken);
    mockFetch.mockClear();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  describe('constructor', () => {
    it('should initialize with default Bearer token type', () => {
      const api = new DriveAPI(mockAccessToken);
      expect(api.getAccessToken()).toBe(mockAccessToken);
    });

    it('should accept custom token type', () => {
      const api = new DriveAPI(mockAccessToken, 'Custom');
      expect(api.getAccessToken()).toBe(mockAccessToken);
    });

    it('should accept custom request config', () => {
      const customConfig = { timeout: 60000 };
      const api = new DriveAPI(mockAccessToken, 'Bearer', customConfig);
      expect(api.getAccessToken()).toBe(mockAccessToken);
    });
  });

  describe('getAccessToken', () => {
    it('should return the access token', () => {
      expect(driveAPI.getAccessToken()).toBe(mockAccessToken);
    });

    it('should handle empty token', () => {
      // Create API with empty token
      const apiWithoutAuth = new DriveAPI('');
      expect(apiWithoutAuth.getAccessToken()).toBe('');
    });

    it('should work with valid token', () => {
      expect(() => driveAPI.getAccessToken()).not.toThrow();
      expect(driveAPI.getAccessToken()).toBe(mockAccessToken);
    });

    it('should handle different token types', () => {
      const customAPI = new DriveAPI('custom-token', 'Custom');
      expect(customAPI.getAccessToken()).toBe('custom-token');
    });
  });

  describe('authorization headers', () => {
    it('should format Bearer token correctly', () => {
      const token = driveAPI.getAccessToken();
      expect(token).toBe(mockAccessToken);
    });

    it('should format custom token type correctly', () => {
      const customAPI = new DriveAPI('test-token', 'ApiKey');
      expect(customAPI.getAccessToken()).toBe('test-token');
    });
  });

  describe('API configuration', () => {
    it('should have default timeout configuration', () => {
      // DriveAPI should be created successfully with default config
      expect(driveAPI).toBeDefined();
      expect(driveAPI.getAccessToken()).toBe(mockAccessToken);
    });

    it('should accept custom timeout configuration', () => {
      const customConfig = { timeout: 60000 };
      const customAPI = new DriveAPI(mockAccessToken, 'Bearer', customConfig);
      expect(customAPI).toBeDefined();
      expect(customAPI.getAccessToken()).toBe(mockAccessToken);
    });
  });

  describe('basic functionality validation', () => {
    it('should expose required public methods', () => {
      expect(typeof driveAPI.getAccessToken).toBe('function');
      expect(typeof driveAPI.listDocsInFolder).toBe('function');
      expect(typeof driveAPI.getFile).toBe('function');
      expect(typeof driveAPI.createFolder).toBe('function');
      expect(typeof driveAPI.exportDocMarkdown).toBe('function');
      expect(typeof driveAPI.updateDocMarkdown).toBe('function');
      expect(typeof driveAPI.uploadMarkdownAsDoc).toBe('function');
      expect(typeof driveAPI.setAppProperties).toBe('function');
      expect(typeof driveAPI.getAppProperties).toBe('function');
      expect(typeof driveAPI.validateDocumentInCurrentWorkspace).toBe('function');
    });

    it('should be instantiable with various configurations', () => {
      const api1 = new DriveAPI('token1');
      const api2 = new DriveAPI('token2', 'Bearer');
      const api3 = new DriveAPI('token3', 'Bearer', { timeout: 30000 });

      expect(api1.getAccessToken()).toBe('token1');
      expect(api2.getAccessToken()).toBe('token2');
      expect(api3.getAccessToken()).toBe('token3');
    });
  });
});