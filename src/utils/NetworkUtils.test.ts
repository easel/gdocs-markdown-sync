/**
 * Tests for NetworkUtils retry logic, timeout handling, and error recovery
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { NetworkUtils, NetworkError, TimeoutError, RateLimitError } from './NetworkUtils';

// Mock fetch for testing
const originalFetch = global.fetch;

describe('NetworkUtils', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('fetchWithRetry', () => {
    it('should succeed on first attempt for successful requests', async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      global.fetch = mock(() => Promise.resolve(mockResponse));

      const response = await NetworkUtils.fetchWithRetry('https://api.example.com/test');

      expect(response.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on 500 server errors', async () => {
      const mockFailure = new Response('Internal Server Error', { status: 500 });
      const mockSuccess = new Response(JSON.stringify({ success: true }), { status: 200 });

      global.fetch = mock()
        .mockResolvedValueOnce(mockFailure)
        .mockResolvedValueOnce(mockFailure)
        .mockResolvedValueOnce(mockSuccess);

      const response = await NetworkUtils.fetchWithRetry(
        'https://api.example.com/test',
        {},
        {
          timeout: 1000,
          retryConfig: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2 },
        },
      );

      expect(response.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should handle rate limiting with retry-after header', async () => {
      const mockRateLimit = new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '0.1' }, // Very short delay for test
      });
      const mockSuccess = new Response(JSON.stringify({ success: true }), { status: 200 });

      global.fetch = mock().mockResolvedValueOnce(mockRateLimit).mockResolvedValueOnce(mockSuccess);

      const response = await NetworkUtils.fetchWithRetry(
        'https://api.example.com/test',
        {},
        {
          timeout: 5000,
          retryConfig: {
            maxRetries: 2,
            initialDelayMs: 10,
            maxDelayMs: 5000,
            backoffMultiplier: 2,
          },
        },
      );

      expect(response.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should throw NetworkError after max retries exceeded', async () => {
      const mockFailure = new Response('Internal Server Error', { status: 500 });

      global.fetch = mock(() => Promise.resolve(mockFailure));

      await expect(
        NetworkUtils.fetchWithRetry(
          'https://api.example.com/test',
          {},
          {
            timeout: 1000,
            retryConfig: {
              maxRetries: 2,
              initialDelayMs: 10,
              maxDelayMs: 100,
              backoffMultiplier: 2,
            },
          },
        ),
      ).rejects.toThrow(NetworkError);

      expect(global.fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should handle AbortError from timeouts', async () => {
      // Mock fetch to throw an AbortError (which happens on timeout)
      global.fetch = mock(() =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
        ),
      );

      await expect(
        NetworkUtils.fetchWithRetry(
          'https://api.example.com/test',
          {},
          {
            timeout: 100,
            retryConfig: {
              maxRetries: 1,
              initialDelayMs: 10,
              maxDelayMs: 100,
              backoffMultiplier: 2,
            },
          },
        ),
      ).rejects.toThrow();

      expect(global.fetch).toHaveBeenCalled();
    });

    it('should not retry on 4xx client errors (except 429)', async () => {
      const mockClientError = new Response('Bad Request', { status: 400 });

      global.fetch = mock(() => Promise.resolve(mockClientError));

      const response = await NetworkUtils.fetchWithRetry(
        'https://api.example.com/test',
        {},
        {
          timeout: 1000,
          retryConfig: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2 },
        },
      );

      expect(response.status).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(1); // No retries for 4xx
    });
  });

  describe('fetchJSON', () => {
    it('should parse JSON response correctly', async () => {
      const mockData = { message: 'Hello, World!', count: 42 };
      const mockResponse = new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      global.fetch = mock(() => Promise.resolve(mockResponse));

      const result = await NetworkUtils.fetchJSON('https://api.example.com/data');

      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
    });

    it('should throw NetworkError for non-200 responses with error details', async () => {
      const errorData = {
        error: 'INVALID_REQUEST',
        error_description: 'The request is missing required parameters',
      };
      const mockResponse = new Response(JSON.stringify(errorData), {
        status: 400,
        statusText: 'Bad Request',
      });

      global.fetch = mock(() => Promise.resolve(mockResponse));

      await expect(NetworkUtils.fetchJSON('https://api.example.com/data')).rejects.toThrow(
        'HTTP 400: Bad Request - The request is missing required parameters',
      );
    });
  });

  describe('batchRequests', () => {
    it('should execute requests with concurrency control', async () => {
      const requests = Array.from(
        { length: 10 },
        (_, i) => () =>
          new Promise((resolve) => setTimeout(() => resolve(`Result ${i}`), Math.random() * 50)),
      );

      const results = await NetworkUtils.batchRequests(requests, 3);

      expect(results).toHaveLength(10);
      results.forEach((result, i) => {
        expect(result).toBe(`Result ${i}`);
      });
    });

    it('should handle mixed success and failure results', async () => {
      const requests = [
        () => Promise.resolve('Success 1'),
        () => Promise.reject(new Error('Failure 1')),
        () => Promise.resolve('Success 2'),
        () => Promise.reject(new Error('Failure 2')),
      ];

      const results = await NetworkUtils.batchRequests(requests, 2);

      expect(results).toHaveLength(4);
      expect(results[0]).toBe('Success 1');
      expect(results[1]).toBeInstanceOf(Error);
      expect(results[2]).toBe('Success 2');
      expect(results[3]).toBeInstanceOf(Error);
    });
  });

  describe('createTimeoutController', () => {
    it('should abort after specified timeout', async () => {
      const controller = NetworkUtils.createTimeoutController(50);

      const startTime = Date.now();
      await new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => {
          const duration = Date.now() - startTime;
          expect(duration).toBeGreaterThanOrEqual(40);
          expect(duration).toBeLessThanOrEqual(100);
          resolve(undefined);
        });
      });
    });
  });

  describe('Error classes', () => {
    it('should create NetworkError with proper context', () => {
      const error = new NetworkError('Request failed', 500, 2, new Error('Original'), 1500);

      expect(error.message).toBe('Request failed');
      expect(error.statusCode).toBe(500);
      expect(error.retryCount).toBe(2);
      expect(error.originalError).toBeInstanceOf(Error);
      expect(error.duration).toBe(1500);
      expect(error.name).toBe('NetworkError');
    });

    it('should create TimeoutError with proper context', () => {
      const error = new TimeoutError(5000, 1);

      expect(error.message).toBe('Request timed out after 5000ms');
      expect(error.statusCode).toBeUndefined();
      expect(error.retryCount).toBe(1);
      expect(error.name).toBe('TimeoutError');
    });

    it('should create RateLimitError with retry-after info', () => {
      const error = new RateLimitError(30, 2);

      expect(error.message).toBe('Rate limit exceeded, retry after 30s');
      expect(error.statusCode).toBe(429);
      expect(error.retryAfter).toBe(30);
      expect(error.retryCount).toBe(2);
      expect(error.name).toBe('RateLimitError');
    });
  });
});
