/**
 * Structured logging system with levels, context, and correlation IDs
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogContext {
  operation?: string;
  resourceId?: string;
  resourceName?: string;
  filePath?: string;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context: LogContext;
  error?: Error;
}

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  enableMetrics: boolean;
  formatJson: boolean;
  filePath?: string;
}

export class Logger {
  private static instance: Logger;
  private config: LoggerConfig;
  private metrics = new Map<string, { count: number; totalDuration: number; errors: number }>();

  private constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: LogLevel.INFO,
      enableConsole: true,
      enableFile: false,
      enableMetrics: true,
      formatJson: false,
      ...config,
    };
  }

  static getInstance(config?: Partial<LoggerConfig>): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(config);
    } else if (config) {
      // Update config if provided
      Logger.instance.config = { ...Logger.instance.config, ...config };
    }
    return Logger.instance;
  }

  static createContextLogger(baseContext: LogContext): ContextLogger {
    return new ContextLogger(Logger.getInstance(), baseContext);
  }

  debug(message: string, context: LogContext = {}): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context: LogContext = {}, error?: Error): void {
    this.log(LogLevel.WARN, message, context, error);
  }

  error(message: string, context: LogContext = {}, error?: Error): void {
    this.log(LogLevel.ERROR, message, context, error);
  }

  // Performance logging methods
  startOperation(operation: string, context: LogContext = {}): OperationLogger {
    return new OperationLogger(this, operation, context);
  }

  // Metrics methods
  incrementCounter(metric: string, tags: Record<string, string> = {}): void {
    if (!this.config.enableMetrics) return;

    const key = `${metric}:${JSON.stringify(tags)}`;
    const current = this.metrics.get(key) || { count: 0, totalDuration: 0, errors: 0 };
    current.count++;
    this.metrics.set(key, current);
  }

  recordDuration(metric: string, duration: number, tags: Record<string, string> = {}): void {
    if (!this.config.enableMetrics) return;

    const key = `${metric}:${JSON.stringify(tags)}`;
    const current = this.metrics.get(key) || { count: 0, totalDuration: 0, errors: 0 };
    current.totalDuration += duration;
    current.count++;
    this.metrics.set(key, current);
  }

  recordError(metric: string, tags: Record<string, string> = {}): void {
    if (!this.config.enableMetrics) return;

    const key = `${metric}:${JSON.stringify(tags)}`;
    const current = this.metrics.get(key) || { count: 0, totalDuration: 0, errors: 0 };
    current.errors++;
    this.metrics.set(key, current);
  }

  getMetrics(): Record<string, { count: number; avgDuration?: number; errorRate?: number }> {
    const result: Record<string, { count: number; avgDuration?: number; errorRate?: number }> = {};

    for (const [key, value] of this.metrics.entries()) {
      result[key] = {
        count: value.count,
        ...(value.totalDuration > 0 && { avgDuration: value.totalDuration / value.count }),
        ...(value.errors > 0 && { errorRate: value.errors / value.count }),
      };
    }

    return result;
  }

  clearMetrics(): void {
    this.metrics.clear();
  }

  private log(level: LogLevel, message: string, context: LogContext, error?: Error): void {
    if (level < this.config.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context: {
        correlationId: context.correlationId || this.generateCorrelationId(),
        ...context,
      },
      error,
    };

    if (this.config.enableConsole) {
      this.logToConsole(entry);
    }

    if (this.config.enableFile && this.config.filePath) {
      this.logToFile(entry);
    }

    // Update metrics
    if (this.config.enableMetrics && context.operation) {
      if (level === LogLevel.ERROR) {
        this.recordError(context.operation);
      }
      if (context.duration) {
        this.recordDuration(context.operation, context.duration);
      }
    }
  }

  private logToConsole(entry: LogEntry): void {
    const timestamp = entry.timestamp.toISOString();
    const levelStr = LogLevel[entry.level].padEnd(5);
    const correlationId = entry.context.correlationId || 'unknown';

    if (this.config.formatJson) {
      console.log(
        JSON.stringify({
          timestamp,
          level: levelStr.trim(),
          message: entry.message,
          context: entry.context,
          ...(entry.error && { error: { message: entry.error.message, stack: entry.error.stack } }),
        }),
      );
    } else {
      const contextParts = [];
      if (entry.context.operation) contextParts.push(`op=${entry.context.operation}`);
      if (entry.context.resourceId) contextParts.push(`id=${entry.context.resourceId}`);
      if (entry.context.resourceName) contextParts.push(`name=${entry.context.resourceName}`);
      if (entry.context.duration) contextParts.push(`duration=${entry.context.duration}ms`);

      const contextStr = contextParts.length > 0 ? ` [${contextParts.join(', ')}]` : '';
      const errorStr = entry.error ? ` Error: ${entry.error.message}` : '';

      const logFn = this.getConsoleFn(entry.level);
      logFn(
        `${timestamp} [${levelStr}] [${correlationId}] ${entry.message}${contextStr}${errorStr}`,
      );

      if (entry.error && entry.error.stack && entry.level === LogLevel.ERROR) {
        console.error(entry.error.stack);
      }
    }
  }

  private async logToFile(entry: LogEntry): Promise<void> {
    if (!this.config.filePath) return;

    try {
      const fs = await import('fs/promises');
      const logLine =
        JSON.stringify({
          timestamp: entry.timestamp.toISOString(),
          level: LogLevel[entry.level],
          message: entry.message,
          context: entry.context,
          ...(entry.error && { error: { message: entry.error.message, stack: entry.error.stack } }),
        }) + '\n';

      await fs.appendFile(this.config.filePath, logLine);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  private getConsoleFn(level: LogLevel): (...args: any[]) => void {
    switch (level) {
      case LogLevel.DEBUG:
        return console.debug;
      case LogLevel.INFO:
        return console.info;
      case LogLevel.WARN:
        return console.warn;
      case LogLevel.ERROR:
        return console.error;
      default:
        return console.log;
    }
  }

  private generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

export class ContextLogger {
  constructor(
    private logger: Logger,
    private baseContext: LogContext,
  ) {}

  debug(message: string, additionalContext: LogContext = {}): void {
    this.logger.debug(message, { ...this.baseContext, ...additionalContext });
  }

  info(message: string, additionalContext: LogContext = {}): void {
    this.logger.info(message, { ...this.baseContext, ...additionalContext });
  }

  warn(message: string, additionalContext: LogContext = {}, error?: Error): void {
    this.logger.warn(message, { ...this.baseContext, ...additionalContext }, error);
  }

  error(message: string, additionalContext: LogContext = {}, error?: Error): void {
    this.logger.error(message, { ...this.baseContext, ...additionalContext }, error);
  }

  startOperation(operation: string, additionalContext: LogContext = {}): OperationLogger {
    return new OperationLogger(this.logger, operation, {
      ...this.baseContext,
      ...additionalContext,
    });
  }
}

export class OperationLogger {
  private startTime = Date.now();

  constructor(
    private logger: Logger,
    private operation: string,
    private context: LogContext,
  ) {
    this.logger.debug(`Starting operation: ${operation}`, {
      ...context,
      operation,
    });
  }

  debug(message: string, additionalContext: LogContext = {}): void {
    this.logger.debug(message, {
      ...this.context,
      operation: this.operation,
      ...additionalContext,
    });
  }

  info(message: string, additionalContext: LogContext = {}): void {
    this.logger.info(message, { ...this.context, operation: this.operation, ...additionalContext });
  }

  warn(message: string, additionalContext: LogContext = {}, error?: Error): void {
    this.logger.warn(
      message,
      { ...this.context, operation: this.operation, ...additionalContext },
      error,
    );
  }

  error(message: string, additionalContext: LogContext = {}, error?: Error): void {
    this.logger.error(
      message,
      { ...this.context, operation: this.operation, ...additionalContext },
      error,
    );
    this.logger.recordError(this.operation);
  }

  success(message?: string, additionalContext: LogContext = {}): void {
    const duration = Date.now() - this.startTime;
    this.logger.info(message || `Operation completed: ${this.operation}`, {
      ...this.context,
      operation: this.operation,
      duration,
      ...additionalContext,
    });
    this.logger.recordDuration(this.operation, duration);
  }

  failure(message?: string, additionalContext: LogContext = {}, error?: Error): void {
    const duration = Date.now() - this.startTime;
    this.logger.error(
      message || `Operation failed: ${this.operation}`,
      {
        ...this.context,
        operation: this.operation,
        duration,
        ...additionalContext,
      },
      error,
    );
    this.logger.recordError(this.operation);
    this.logger.recordDuration(this.operation, duration);
  }

  addContext(additionalContext: LogContext): void {
    this.context = { ...this.context, ...additionalContext };
  }
}

// Convenience function to get the default logger
export function getLogger(): Logger {
  return Logger.getInstance();
}

// Convenience function to create a context logger
export function createLogger(context: LogContext): ContextLogger {
  return Logger.createContextLogger(context);
}
