/**
 * Custom error classes with enhanced context and error handling utilities
 */

export interface ErrorContext {
  operation?: string;
  resourceId?: string;
  resourceName?: string;
  filePath?: string;
  correlationId?: string;
  timestamp?: Date;
  metadata?: Record<string, any>;
}

export class BaseError extends Error {
  public readonly timestamp = new Date();
  public readonly correlationId = this.generateCorrelationId();

  constructor(
    message: string,
    public readonly context: ErrorContext = {},
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;

    // Preserve original stack trace if available
    if (originalError?.stack) {
      this.stack = `${this.stack}\n\nCaused by: ${originalError.stack}`;
    }
  }

  private generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      correlationId: this.correlationId,
      timestamp: this.timestamp.toISOString(),
      originalError: this.originalError?.message,
    };
  }

  toString(): string {
    const parts = [this.message];

    if (this.context.operation) parts.push(`Operation: ${this.context.operation}`);
    if (this.context.resourceId) parts.push(`Resource ID: ${this.context.resourceId}`);
    if (this.context.resourceName) parts.push(`Resource: ${this.context.resourceName}`);
    if (this.context.filePath) parts.push(`File: ${this.context.filePath}`);

    return parts.join(' | ');
  }
}

export class AuthenticationError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, originalError?: Error) {
    super(message, { ...context, operation: context.operation || 'authentication' }, originalError);
  }
}

export class DriveAPIError extends BaseError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(message, { ...context, operation: context.operation || 'drive-api' }, originalError);
  }
}

export class FileOperationError extends BaseError {
  constructor(
    message: string,
    public readonly operation: 'read' | 'write' | 'delete' | 'create',
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(message, { ...context, operation: `file-${operation}` }, originalError);
  }
}

export class SyncError extends BaseError {
  constructor(
    message: string,
    public readonly direction: 'pull' | 'push' | 'bidirectional',
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(message, { ...context, operation: `sync-${direction}` }, originalError);
  }
}

export class ConfigurationError extends BaseError {
  constructor(
    message: string,
    public readonly configKey?: string,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(
      message,
      { ...context, operation: 'configuration', metadata: { configKey } },
      originalError,
    );
  }
}

export class ValidationError extends BaseError {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: any,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(
      message,
      { ...context, operation: 'validation', metadata: { field, value } },
      originalError,
    );
  }
}

export interface ErrorSummary {
  totalErrors: number;
  errorsByType: Record<string, number>;
  criticalErrors: BaseError[];
  warningErrors: BaseError[];
  context: {
    operation?: string;
    startTime: Date;
    endTime: Date;
    duration: number;
  };
}

export class ErrorAggregator {
  private errors: BaseError[] = [];
  private startTime = new Date();

  add(error: BaseError | Error, context?: ErrorContext): void {
    if (error instanceof BaseError) {
      this.errors.push(error);
    } else {
      this.errors.push(new BaseError(error.message, context, error));
    }
  }

  addAuthError(message: string, context?: ErrorContext, originalError?: Error): void {
    this.add(new AuthenticationError(message, context, originalError));
  }

  addDriveError(
    message: string,
    statusCode?: number,
    context?: ErrorContext,
    originalError?: Error,
  ): void {
    this.add(new DriveAPIError(message, statusCode, context, originalError));
  }

  addFileError(
    message: string,
    operation: 'read' | 'write' | 'delete' | 'create',
    context?: ErrorContext,
    originalError?: Error,
  ): void {
    this.add(new FileOperationError(message, operation, context, originalError));
  }

  addSyncError(
    message: string,
    direction: 'pull' | 'push' | 'bidirectional',
    context?: ErrorContext,
    originalError?: Error,
  ): void {
    this.add(new SyncError(message, direction, context, originalError));
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  getErrors(): BaseError[] {
    return [...this.errors];
  }

  getCriticalErrors(): BaseError[] {
    return this.errors.filter(
      (error) =>
        error instanceof AuthenticationError ||
        error instanceof ConfigurationError ||
        (error instanceof DriveAPIError && error.statusCode && error.statusCode >= 500),
    );
  }

  getWarningErrors(): BaseError[] {
    return this.errors.filter((error) => !this.getCriticalErrors().includes(error));
  }

  getSummary(operation?: string): ErrorSummary {
    const endTime = new Date();
    const errorsByType: Record<string, number> = {};

    for (const error of this.errors) {
      const type = error.constructor.name;
      errorsByType[type] = (errorsByType[type] || 0) + 1;
    }

    return {
      totalErrors: this.errors.length,
      errorsByType,
      criticalErrors: this.getCriticalErrors(),
      warningErrors: this.getWarningErrors(),
      context: {
        operation,
        startTime: this.startTime,
        endTime,
        duration: endTime.getTime() - this.startTime.getTime(),
      },
    };
  }

  clear(): void {
    this.errors = [];
    this.startTime = new Date();
  }

  toString(): string {
    if (this.errors.length === 0) {
      return 'No errors';
    }

    const summary = this.getSummary();
    const lines = [
      `Found ${summary.totalErrors} error(s):`,
      ...Object.entries(summary.errorsByType).map(([type, count]) => `  ${type}: ${count}`),
    ];

    if (summary.criticalErrors.length > 0) {
      lines.push('', 'Critical errors:');
      lines.push(...summary.criticalErrors.map((e) => `  - ${e.toString()}`));
    }

    if (summary.warningErrors.length > 0) {
      lines.push('', 'Warning errors:');
      lines.push(...summary.warningErrors.map((e) => `  - ${e.toString()}`));
    }

    return lines.join('\n');
  }
}

export class ErrorUtils {
  /**
   * Wrap an async function with error context
   */
  static withErrorContext<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    context: ErrorContext,
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof BaseError) {
          throw error;
        }
        throw new BaseError(
          error instanceof Error ? error.message : String(error),
          context,
          error instanceof Error ? error : undefined,
        );
      }
    };
  }

  /**
   * Create a delay with error context
   */
  static async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    context: ErrorContext = {},
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new BaseError(`Operation timed out after ${timeoutMs}ms`, {
            ...context,
            operation: context.operation || 'timeout',
          }),
        );
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Retry function with error aggregation
   */
  static async retry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    context: ErrorContext = {},
  ): Promise<T> {
    const aggregator = new ErrorAggregator();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const attemptContext = {
          ...context,
          metadata: { ...context.metadata, attempt, maxAttempts },
        };

        if (error instanceof BaseError) {
          aggregator.add(error);
        } else {
          aggregator.add(
            new BaseError(
              error instanceof Error ? error.message : String(error),
              attemptContext,
              error instanceof Error ? error : undefined,
            ),
          );
        }

        if (attempt === maxAttempts) {
          const lastError = aggregator.getErrors()[aggregator.getErrors().length - 1];
          throw new BaseError(
            `Failed after ${maxAttempts} attempts: ${lastError.message}`,
            { ...context, operation: context.operation || 'retry' },
            lastError,
          );
        }

        // Simple exponential backoff
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
      }
    }

    throw new BaseError('Unexpected end of retry loop', context);
  }

  /**
   * Convert any error to a BaseError with context
   */
  static normalize(error: any, context: ErrorContext = {}): BaseError {
    if (error instanceof BaseError) {
      return error;
    }

    if (error instanceof Error) {
      return new BaseError(error.message, context, error);
    }

    return new BaseError(String(error), context);
  }
}
