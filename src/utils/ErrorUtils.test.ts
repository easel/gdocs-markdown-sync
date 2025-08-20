/**
 * Tests for ErrorUtils, custom error classes, and error aggregation
 */

import { describe, it, expect, beforeEach } from 'bun:test';

import {
  BaseError,
  AuthenticationError,
  DriveAPIError,
  FileOperationError,
  SyncError,
  ConfigurationError,
  ValidationError,
  ErrorAggregator,
  ErrorUtils,
} from './ErrorUtils';

describe('ErrorUtils', () => {
  describe('BaseError', () => {
    it('should create error with context and correlation ID', () => {
      const context = { operation: 'test-op', resourceId: 'test-123' };
      const originalError = new Error('Original error');
      const error = new BaseError('Test error', context, originalError);

      expect(error.message).toBe('Test error');
      expect(error.context).toEqual(expect.objectContaining(context));
      expect(error.correlationId).toBeDefined();
      expect(error.timestamp).toBeInstanceOf(Date);
      expect(error.originalError).toBe(originalError);
      expect(error.name).toBe('BaseError');
    });

    it('should preserve original stack trace', () => {
      const originalError = new Error('Original error');
      const baseError = new BaseError('Wrapper error', {}, originalError);

      expect(baseError.stack).toContain('Caused by:');
      expect(baseError.stack).toContain(originalError.stack);
    });

    it('should serialize to JSON correctly', () => {
      const context = { operation: 'serialize-test', resourceName: 'test.txt' };
      const error = new BaseError('Serialization test', context);
      const json = error.toJSON();

      expect(json.name).toBe('BaseError');
      expect(json.message).toBe('Serialization test');
      expect(json.context).toEqual(expect.objectContaining(context));
      expect(json.correlationId).toBeDefined();
      expect(json.timestamp).toBeDefined();
    });

    it('should create readable string representation', () => {
      const context = {
        operation: 'file-read',
        resourceId: 'doc-123',
        resourceName: 'test.md',
        filePath: '/path/to/test.md',
      };
      const error = new BaseError('File read failed', context);
      const str = error.toString();

      expect(str).toContain('File read failed');
      expect(str).toContain('Operation: file-read');
      expect(str).toContain('Resource ID: doc-123');
      expect(str).toContain('Resource: test.md');
      expect(str).toContain('File: /path/to/test.md');
    });
  });

  describe('Specific Error Types', () => {
    it('should create AuthenticationError with correct operation', () => {
      const error = new AuthenticationError('Auth failed');
      expect(error.name).toBe('AuthenticationError');
      expect(error.context.operation).toBe('authentication');
    });

    it('should create DriveAPIError with status code', () => {
      const error = new DriveAPIError('API failed', 500, { resourceId: 'doc-123' });
      expect(error.name).toBe('DriveAPIError');
      expect(error.statusCode).toBe(500);
      expect(error.context.operation).toBe('drive-api');
      expect(error.context.resourceId).toBe('doc-123');
    });

    it('should create FileOperationError with operation type', () => {
      const error = new FileOperationError('Write failed', 'write', { filePath: '/test.txt' });
      expect(error.name).toBe('FileOperationError');
      expect(error.operation).toBe('write');
      expect(error.context.operation).toBe('file-write');
    });

    it('should create SyncError with direction', () => {
      const error = new SyncError('Sync failed', 'pull');
      expect(error.name).toBe('SyncError');
      expect(error.direction).toBe('pull');
      expect(error.context.operation).toBe('sync-pull');
    });

    it('should create ConfigurationError with config key', () => {
      const error = new ConfigurationError('Invalid config', 'network.timeout');
      expect(error.name).toBe('ConfigurationError');
      expect(error.configKey).toBe('network.timeout');
      expect(error.context.operation).toBe('configuration');
    });

    it('should create ValidationError with field info', () => {
      const error = new ValidationError('Invalid value', 'email', 'not-an-email');
      expect(error.name).toBe('ValidationError');
      expect(error.field).toBe('email');
      expect(error.value).toBe('not-an-email');
      expect(error.context.operation).toBe('validation');
    });
  });

  describe('ErrorAggregator', () => {
    let aggregator: ErrorAggregator;

    beforeEach(() => {
      aggregator = new ErrorAggregator();
    });

    it('should start with no errors', () => {
      expect(aggregator.hasErrors()).toBe(false);
      expect(aggregator.getErrors()).toHaveLength(0);
    });

    it('should add and track various error types', () => {
      aggregator.addAuthError('Auth failed');
      aggregator.addDriveError('Drive failed', 500);
      aggregator.addFileError('File failed', 'read', { filePath: '/test.txt' });
      aggregator.addSyncError('Sync failed', 'push');

      expect(aggregator.hasErrors()).toBe(true);
      expect(aggregator.getErrors()).toHaveLength(4);

      const errors = aggregator.getErrors();
      expect(errors[0]).toBeInstanceOf(AuthenticationError);
      expect(errors[1]).toBeInstanceOf(DriveAPIError);
      expect(errors[2]).toBeInstanceOf(FileOperationError);
      expect(errors[3]).toBeInstanceOf(SyncError);
    });

    it('should categorize critical vs warning errors', () => {
      aggregator.addAuthError('Critical auth error');
      aggregator.addDriveError('Server error', 500);
      aggregator.addDriveError('Client error', 400);
      aggregator.addFileError('File error', 'read');

      const critical = aggregator.getCriticalErrors();
      const warnings = aggregator.getWarningErrors();

      expect(critical).toHaveLength(2); // Auth + 500 error
      expect(warnings).toHaveLength(2); // 400 error + file error

      expect(critical[0]).toBeInstanceOf(AuthenticationError);
      expect(critical[1]).toBeInstanceOf(DriveAPIError);
      expect((critical[1] as DriveAPIError).statusCode).toBe(500);
    });

    it('should generate comprehensive summary', async () => {
      aggregator.addAuthError('Auth error');
      aggregator.addDriveError('Drive error 1', 500);
      aggregator.addDriveError('Drive error 2', 429);
      aggregator.addFileError('File error', 'write');

      // Add small delay to ensure duration > 0
      await new Promise((resolve) => setTimeout(resolve, 1));

      const summary = aggregator.getSummary('test-operation');

      expect(summary.totalErrors).toBe(4);
      expect(summary.errorsByType.AuthenticationError).toBe(1);
      expect(summary.errorsByType.DriveAPIError).toBe(2);
      expect(summary.errorsByType.FileOperationError).toBe(1);
      expect(summary.criticalErrors).toHaveLength(2);
      expect(summary.warningErrors).toHaveLength(2);
      expect(summary.context.operation).toBe('test-operation');
      expect(summary.context.duration).toBeGreaterThanOrEqual(0);
    });

    it('should clear errors and reset state', () => {
      aggregator.addAuthError('Auth error');
      expect(aggregator.hasErrors()).toBe(true);

      aggregator.clear();
      expect(aggregator.hasErrors()).toBe(false);
      expect(aggregator.getErrors()).toHaveLength(0);
    });

    it('should create readable string representation', () => {
      aggregator.addAuthError('Auth failed');
      aggregator.addDriveError('Drive failed', 500);

      const str = aggregator.toString();

      expect(str).toContain('Found 2 error(s)');
      expect(str).toContain('AuthenticationError: 1');
      expect(str).toContain('DriveAPIError: 1');
      expect(str).toContain('Critical errors:');
    });
  });

  describe('ErrorUtils', () => {
    it('should wrap function with error context', async () => {
      const context = { operation: 'test-wrap', resourceId: 'test-123' };
      const throwingFunction = async () => {
        throw new Error('Original error');
      };

      const wrappedFunction = ErrorUtils.withErrorContext(throwingFunction, context);

      await expect(wrappedFunction()).rejects.toThrow(BaseError);

      try {
        await wrappedFunction();
      } catch (error) {
        expect(error).toBeInstanceOf(BaseError);
        expect((error as BaseError).context).toEqual(expect.objectContaining(context));
        expect((error as BaseError).originalError).toBeInstanceOf(Error);
      }
    });

    it('should preserve BaseError instances when wrapping', async () => {
      const originalError = new AuthenticationError('Auth failed');
      const throwingFunction = async () => {
        throw originalError;
      };

      const wrappedFunction = ErrorUtils.withErrorContext(throwingFunction, {});

      await expect(wrappedFunction()).rejects.toBe(originalError);
    });

    it('should implement timeout wrapper', async () => {
      const slowFunction = new Promise((resolve) => setTimeout(() => resolve('success'), 200));

      await expect(
        ErrorUtils.withTimeout(slowFunction, 50, { operation: 'timeout-test' }),
      ).rejects.toThrow(BaseError);
    });

    it('should retry function with exponential backoff', async () => {
      let attempts = 0;
      const flakyFunction = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Attempt ${attempts} failed`);
        }
        return 'success';
      };

      const result = await ErrorUtils.retry(flakyFunction, 3, { operation: 'retry-test' });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should fail after max retry attempts', async () => {
      const alwaysFailingFunction = async () => {
        throw new Error('Always fails');
      };

      await expect(
        ErrorUtils.retry(alwaysFailingFunction, 2, { operation: 'retry-fail-test' }),
      ).rejects.toThrow(BaseError);
    });

    it('should normalize various error types to BaseError', () => {
      const regularError = new Error('Regular error');
      const baseError = new BaseError('Base error');
      const stringError = 'String error';
      const context = { operation: 'normalize-test' };

      expect(ErrorUtils.normalize(regularError, context)).toBeInstanceOf(BaseError);
      expect(ErrorUtils.normalize(baseError, context)).toBe(baseError);
      expect(ErrorUtils.normalize(stringError, context)).toBeInstanceOf(BaseError);
      expect(ErrorUtils.normalize(stringError, context).message).toBe('String error');
    });
  });
});
