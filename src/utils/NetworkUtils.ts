/**
 * Network utilities with retry logic, timeouts, and error handling
 */

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
  retryableErrors: string[];
}

export interface RequestConfig {
  timeout?: number;
  retryConfig?: Partial<RetryConfig>;
  abortSignal?: AbortSignal;
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryCount?: number,
    public readonly originalError?: Error,
    public readonly duration?: number,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends NetworkError {
  constructor(timeout: number, retryCount = 0) {
    super(`Request timed out after ${timeout}ms`, undefined, retryCount);
    this.name = 'TimeoutError';
  }
}

export class RateLimitError extends NetworkError {
  constructor(
    public readonly retryAfter?: number,
    retryCount = 0,
  ) {
    super(
      `Rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      429,
      retryCount,
    );
    this.name = 'RateLimitError';
  }
}

export class NetworkUtils {
  private static readonly DEFAULT_CONFIG: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
  };

  private static readonly DEFAULT_TIMEOUT = 30000; // 30 seconds

  /**
   * Enhanced fetch with retry logic, timeouts, and proper error handling
   */
  static async fetchWithRetry(
    url: string,
    options: any = {},
    config: RequestConfig = {},
  ): Promise<Response> {
    const retryConfig = { ...this.DEFAULT_CONFIG, ...config.retryConfig };
    const timeout = config.timeout || this.DEFAULT_TIMEOUT;
    const startTime = Date.now();

    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt <= retryConfig.maxRetries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        // Combine external abort signal with timeout
        if (config.abortSignal) {
          config.abortSignal.addEventListener('abort', () => controller.abort());
        }

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle case where fetch returns undefined (shouldn't happen but can in tests)
        if (!response) {
          throw new NetworkError(
            'Fetch returned undefined response',
            undefined,
            attempt,
          );
        }

        // Check if we should retry based on status code
        if (!response.ok && this.shouldRetryStatusCode(response.status, retryConfig)) {
          throw new NetworkError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
            attempt,
          );
        }

        // Handle rate limiting with special retry logic
        if (response.status === 429) {
          const retryAfter = this.parseRetryAfter(response.headers.get('retry-after'));
          throw new RateLimitError(retryAfter, attempt);
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        clearTimeout(timeoutId);

        // Handle AbortError (timeout)
        if (error instanceof Error && error.name === 'AbortError') {
          const timeoutError = new TimeoutError(timeout, attempt);
          if (!this.shouldRetry(timeoutError, attempt, retryConfig)) {
            throw timeoutError;
          }
          lastError = timeoutError;
        }
        // Handle other network errors
        else if (!this.shouldRetry(lastError, attempt, retryConfig)) {
          const duration = Date.now() - startTime;
          throw new NetworkError(
            `Request failed after ${attempt} attempts: ${lastError.message}`,
            undefined,
            attempt,
            lastError,
            duration,
          );
        }

        // Calculate delay for next retry
        if (attempt < retryConfig.maxRetries) {
          const delay = this.calculateDelay(attempt, retryConfig, lastError);
          console.log(
            `Retrying request to ${url} in ${delay}ms (attempt ${attempt + 1}/${retryConfig.maxRetries + 1})`,
          );
          await this.sleep(delay);
        }

        attempt++;
      }
    }

    const duration = Date.now() - startTime;
    throw new NetworkError(
      `Request failed after ${attempt} attempts: ${lastError?.message || 'Unknown error'}`,
      undefined,
      attempt,
      lastError,
      duration,
    );
  }

  /**
   * Wrapper for common JSON API requests
   */
  static async fetchJSON<T = any>(
    url: string,
    options: any = {},
    config: RequestConfig = {},
  ): Promise<T> {
    const response = await this.fetchWithRetry(
      url,
      {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      config,
    );

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error_description) {
          errorMessage += ` - ${errorData.error_description}`;
        } else if (errorData.error) {
          errorMessage += ` - ${errorData.error}`;
        } else if (errorData.message) {
          errorMessage += ` - ${errorData.message}`;
        }
      } catch {
        // Ignore JSON parsing errors for error responses
      }
      throw new NetworkError(errorMessage, response.status);
    }

    return response.json();
  }

  /**
   * Check if we should retry based on the error and attempt count
   */
  private static shouldRetry(error: Error, attempt: number, config: RetryConfig): boolean {
    if (attempt >= config.maxRetries) {
      return false;
    }

    // Always retry rate limit errors (with special handling)
    if (error instanceof RateLimitError) {
      return true;
    }

    // Retry network errors
    if (error instanceof NetworkError && error.statusCode) {
      return this.shouldRetryStatusCode(error.statusCode, config);
    }

    // Retry timeout errors
    if (error instanceof TimeoutError) {
      return true;
    }

    // Check for retryable error codes
    const errorCode = (error as any).code;
    if (errorCode && config.retryableErrors.includes(errorCode)) {
      return true;
    }

    return false;
  }

  /**
   * Check if a status code should be retried
   */
  private static shouldRetryStatusCode(statusCode: number, config: RetryConfig): boolean {
    return config.retryableStatusCodes.includes(statusCode);
  }

  /**
   * Calculate delay for next retry attempt
   */
  private static calculateDelay(attempt: number, config: RetryConfig, error?: Error): number {
    let delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);

    // Special handling for rate limit errors
    if (error instanceof RateLimitError && error.retryAfter) {
      delay = Math.max(delay, error.retryAfter * 1000);
    }

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * delay;
    delay += jitter;

    return Math.min(delay, config.maxDelayMs);
  }

  /**
   * Parse Retry-After header
   */
  private static parseRetryAfter(retryAfter: string | null): number | undefined {
    if (!retryAfter) return undefined;

    // Try parsing as seconds
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds;
    }

    // Try parsing as HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
    }

    return undefined;
  }

  /**
   * Sleep for specified milliseconds
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create abort controller that times out after specified duration
   */
  static createTimeoutController(timeoutMs: number): AbortController {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return controller;
  }

  /**
   * Batch multiple requests with concurrency control
   */
  static async batchRequests<T>(
    requests: Array<() => Promise<T>>,
    concurrency: number = 5,
  ): Promise<Array<T | Error>> {
    const results: Array<T | Error> = [];
    const executing: Promise<void>[] = [];

    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];

      const promise = request()
        .then((result) => {
          results[i] = result;
        })
        .catch((error) => {
          results[i] = error;
        });

      executing.push(promise);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
        executing.splice(
          executing.findIndex((p) => Promise.resolve(p) === p),
          1,
        );
      }
    }

    await Promise.all(executing);
    return results;
  }
}
