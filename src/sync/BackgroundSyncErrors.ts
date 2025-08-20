/**
 * Error classification and handling for background sync operations
 *
 * Provides specialized error handling for Drive API failures with:
 * - Error type classification (temporary vs permanent)
 * - Adaptive backoff strategies based on error type
 * - Rate limit handling and recovery
 * - Auth failure detection and recovery
 */

import { BaseError, ErrorContext } from '../utils/ErrorUtils';

export enum SyncErrorType {
  // Temporary errors - should be retried with backoff
  NETWORK_ERROR = 'network_error',
  RATE_LIMITED = 'rate_limited',
  DRIVE_TIMEOUT = 'drive_timeout',
  DRIVE_UNAVAILABLE = 'drive_unavailable',

  // Permanent errors - should not be retried
  AUTH_EXPIRED = 'auth_expired',
  AUTH_INVALID = 'auth_invalid',
  DOCUMENT_NOT_FOUND = 'document_not_found',
  PERMISSION_DENIED = 'permission_denied',
  INVALID_DOCUMENT = 'invalid_document',

  // Sync-specific errors
  CONFLICT_RESOLUTION_FAILED = 'conflict_resolution_failed',
  CONTENT_TOO_LARGE = 'content_too_large',
  INVALID_MARKDOWN = 'invalid_markdown',

  // System errors
  PLUGIN_DISABLED = 'plugin_disabled',
  OBSIDIAN_UNAVAILABLE = 'obsidian_unavailable',

  // Unknown errors
  UNKNOWN = 'unknown',
}

export interface SyncErrorInfo {
  type: SyncErrorType;
  isTemporary: boolean;
  requiresAuth: boolean;
  backoffMultiplier: number;
  maxRetries: number;
  userFriendlyMessage: string;
}

export class SyncError extends BaseError {
  public readonly errorType: SyncErrorType;
  public readonly errorInfo: SyncErrorInfo;

  constructor(
    message: string,
    errorType: SyncErrorType,
    context: ErrorContext = {},
    originalError?: Error,
  ) {
    super(message, context, originalError);
    this.errorType = errorType;
    this.errorInfo = SyncErrorClassifier.getErrorInfo(errorType);
  }

  /**
   * Check if this error should trigger a user notification in background mode
   */
  shouldNotifyUser(): boolean {
    return (
      !this.errorInfo.isTemporary ||
      this.errorInfo.requiresAuth ||
      this.errorType === SyncErrorType.PERMISSION_DENIED
    );
  }

  /**
   * Get user-friendly message for notifications
   */
  getUserMessage(): string {
    return this.errorInfo.userFriendlyMessage;
  }
}

export class SyncErrorClassifier {
  /**
   * Classify an error and return SyncError
   */
  static classifyError(error: Error, context: ErrorContext = {}): SyncError {
    const errorType = this.detectErrorType(error);

    let message = error.message;
    if (errorType !== SyncErrorType.UNKNOWN) {
      const info = this.getErrorInfo(errorType);
      message = info.userFriendlyMessage;
    }

    return new SyncError(message, errorType, context, error);
  }

  /**
   * Detect error type from error message and properties
   */
  private static detectErrorType(error: Error): SyncErrorType {
    const message = error.message.toLowerCase();
    const name = error.name?.toLowerCase() || '';

    // Network-related errors
    if (
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('timeout') ||
      name.includes('timeout')
    ) {
      if (message.includes('timeout')) {
        return SyncErrorType.DRIVE_TIMEOUT;
      }
      return SyncErrorType.NETWORK_ERROR;
    }

    // Rate limiting
    if (
      message.includes('rate limit') ||
      message.includes('quota') ||
      message.includes('too many requests') ||
      message.includes('429')
    ) {
      return SyncErrorType.RATE_LIMITED;
    }

    // Authentication errors
    if (
      message.includes('unauthorized') ||
      message.includes('401') ||
      message.includes('invalid token') ||
      message.includes('expired token')
    ) {
      return SyncErrorType.AUTH_EXPIRED;
    }

    if (message.includes('invalid credentials') || message.includes('auth')) {
      return SyncErrorType.AUTH_INVALID;
    }

    // Permission errors
    if (
      message.includes('forbidden') ||
      message.includes('403') ||
      message.includes('permission') ||
      message.includes('access denied')
    ) {
      return SyncErrorType.PERMISSION_DENIED;
    }

    // Document-related errors
    if (message.includes('not found') || message.includes('404')) {
      return SyncErrorType.DOCUMENT_NOT_FOUND;
    }

    if (message.includes('invalid document') || message.includes('corrupted')) {
      return SyncErrorType.INVALID_DOCUMENT;
    }

    // Drive service errors
    if (
      message.includes('drive unavailable') ||
      message.includes('service unavailable') ||
      message.includes('502') ||
      message.includes('503')
    ) {
      return SyncErrorType.DRIVE_UNAVAILABLE;
    }

    // Content errors
    if (message.includes('too large') || message.includes('size limit')) {
      return SyncErrorType.CONTENT_TOO_LARGE;
    }

    // Sync-specific errors
    if (message.includes('conflict') && message.includes('resolution')) {
      return SyncErrorType.CONFLICT_RESOLUTION_FAILED;
    }

    if (message.includes('invalid markdown') || message.includes('parsing')) {
      return SyncErrorType.INVALID_MARKDOWN;
    }

    return SyncErrorType.UNKNOWN;
  }

  /**
   * Get error information for a specific error type
   */
  static getErrorInfo(errorType: SyncErrorType): SyncErrorInfo {
    switch (errorType) {
      case SyncErrorType.NETWORK_ERROR:
        return {
          type: errorType,
          isTemporary: true,
          requiresAuth: false,
          backoffMultiplier: 2,
          maxRetries: 5,
          userFriendlyMessage: 'Network connection issue. Will retry automatically.',
        };

      case SyncErrorType.RATE_LIMITED:
        return {
          type: errorType,
          isTemporary: true,
          requiresAuth: false,
          backoffMultiplier: 3, // Longer backoff for rate limits
          maxRetries: 3,
          userFriendlyMessage: 'Google Drive rate limit reached. Sync will retry with delay.',
        };

      case SyncErrorType.DRIVE_TIMEOUT:
        return {
          type: errorType,
          isTemporary: true,
          requiresAuth: false,
          backoffMultiplier: 2,
          maxRetries: 3,
          userFriendlyMessage: 'Google Drive response timeout. Retrying...',
        };

      case SyncErrorType.DRIVE_UNAVAILABLE:
        return {
          type: errorType,
          isTemporary: true,
          requiresAuth: false,
          backoffMultiplier: 4, // Long backoff for service issues
          maxRetries: 2,
          userFriendlyMessage: 'Google Drive service temporarily unavailable.',
        };

      case SyncErrorType.AUTH_EXPIRED:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: true,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Authentication expired. Please re-authenticate in plugin settings.',
        };

      case SyncErrorType.AUTH_INVALID:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: true,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Invalid authentication. Please check your credentials.',
        };

      case SyncErrorType.DOCUMENT_NOT_FOUND:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 1, // Try once more in case of temporary issue
          userFriendlyMessage: 'Google Doc not found. Document may have been deleted.',
        };

      case SyncErrorType.PERMISSION_DENIED:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Permission denied. Check your Google Drive access.',
        };

      case SyncErrorType.INVALID_DOCUMENT:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Document format is invalid or corrupted.',
        };

      case SyncErrorType.CONFLICT_RESOLUTION_FAILED:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 1,
          userFriendlyMessage: 'Unable to resolve sync conflict automatically.',
        };

      case SyncErrorType.CONTENT_TOO_LARGE:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Document is too large to sync.',
        };

      case SyncErrorType.INVALID_MARKDOWN:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Markdown formatting is invalid.',
        };

      case SyncErrorType.PLUGIN_DISABLED:
        return {
          type: errorType,
          isTemporary: false,
          requiresAuth: false,
          backoffMultiplier: 1,
          maxRetries: 0,
          userFriendlyMessage: 'Background sync is disabled.',
        };

      case SyncErrorType.OBSIDIAN_UNAVAILABLE:
        return {
          type: errorType,
          isTemporary: true,
          requiresAuth: false,
          backoffMultiplier: 2,
          maxRetries: 2,
          userFriendlyMessage: 'Obsidian is not available for sync operations.',
        };

      default:
        return {
          type: errorType,
          isTemporary: true,
          requiresAuth: false,
          backoffMultiplier: 2,
          maxRetries: 3,
          userFriendlyMessage: 'Sync failed with unknown error. Check console for details.',
        };
    }
  }
}

export class BackoffStrategy {
  private baseDelayMs: number;
  private maxDelayMs: number;
  private jitterFactor: number;

  constructor(baseDelayMs = 1000, maxDelayMs = 300000, jitterFactor = 0.1) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.jitterFactor = jitterFactor;
  }

  /**
   * Calculate backoff delay for a specific error type and attempt
   */
  calculateDelay(errorInfo: SyncErrorInfo, attempt: number): number {
    const multiplier = Math.pow(errorInfo.backoffMultiplier, attempt - 1);
    const delay = Math.min(this.baseDelayMs * multiplier, this.maxDelayMs);

    // Add jitter to avoid thundering herd
    const jitter = delay * this.jitterFactor * (Math.random() - 0.5);
    return Math.max(0, delay + jitter);
  }

  /**
   * Check if error should be retried based on attempt count and error type
   */
  shouldRetry(errorInfo: SyncErrorInfo, attempt: number): boolean {
    return errorInfo.isTemporary && attempt <= errorInfo.maxRetries;
  }

  /**
   * Get a human-readable description of the next retry
   */
  getRetryDescription(errorInfo: SyncErrorInfo, attempt: number): string {
    if (!this.shouldRetry(errorInfo, attempt)) {
      return 'No more retries';
    }

    const delay = this.calculateDelay(errorInfo, attempt);
    const seconds = Math.round(delay / 1000);

    if (seconds < 60) {
      return `Retrying in ${seconds} seconds`;
    } else {
      const minutes = Math.round(seconds / 60);
      return `Retrying in ${minutes} minutes`;
    }
  }
}
