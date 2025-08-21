/**
 * Configuration management for network settings, logging, and other options
 */

import { LogLevel, LoggerConfig } from './Logger.js';
import { RetryConfig } from './NetworkUtils.js';

export interface NetworkConfig {
  timeout: number;
  retryConfig: RetryConfig;
  concurrency: number;
  maxFileSize: number; // bytes
}

export interface SyncConfig {
  batchSize: number;
  conflictResolution: 'prefer-doc' | 'prefer-md' | 'merge' | 'prompt';
  autoSync: boolean;
  syncInterval: number; // seconds
  preserveMetadata: boolean;
}

export interface AppConfig {
  network: NetworkConfig;
  logging: LoggerConfig;
  sync: SyncConfig;
  environment: 'development' | 'production' | 'testing';
}

export class Config {
  private static instance: Config;
  private config: AppConfig;

  private constructor() {
    this.config = this.loadDefaultConfig();
    this.loadEnvironmentOverrides();
  }

  static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  get network(): NetworkConfig {
    return this.config.network;
  }

  get logging(): LoggerConfig {
    return this.config.logging;
  }

  get sync(): SyncConfig {
    return this.config.sync;
  }

  get environment(): string {
    return this.config.environment;
  }

  get isDevelopment(): boolean {
    return this.config.environment === 'development';
  }

  get isProduction(): boolean {
    return this.config.environment === 'production';
  }

  get isTesting(): boolean {
    return this.config.environment === 'testing';
  }

  // Update specific configuration sections
  updateNetwork(updates: Partial<NetworkConfig>): void {
    this.config.network = { ...this.config.network, ...updates };
  }

  updateLogging(updates: Partial<LoggerConfig>): void {
    this.config.logging = { ...this.config.logging, ...updates };
  }

  updateSync(updates: Partial<SyncConfig>): void {
    this.config.sync = { ...this.config.sync, ...updates };
  }

  // Get the full configuration
  getConfig(): AppConfig {
    return { ...this.config };
  }

  // Load configuration from file (for plugin usage)
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const fileConfig = JSON.parse(content);
      this.mergeConfig(fileConfig);
    } catch (error) {
      console.warn(`Failed to load config from ${filePath}:`, error);
    }
  }

  // Save configuration to file
  async saveToFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      const content = JSON.stringify(this.config, null, 2);
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (error) {
      console.error(`Failed to save config to ${filePath}:`, error);
      throw error;
    }
  }

  private loadDefaultConfig(): AppConfig {
    return {
      network: {
        timeout: 30000, // 30 seconds
        retryConfig: {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 30000,
          backoffMultiplier: 2,
          retryableStatusCodes: [408, 429, 500, 502, 503, 504],
          retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
        },
        concurrency: 5,
        maxFileSize: 10 * 1024 * 1024, // 10MB
      },
      logging: {
        level: LogLevel.INFO,
        enableConsole: true,
        enableFile: false,
        enableMetrics: true,
        formatJson: false,
      },
      sync: {
        batchSize: 50,
        conflictResolution: 'prefer-doc',
        autoSync: false,
        syncInterval: 300, // 5 minutes
        preserveMetadata: true,
      },
      environment: (process.env.NODE_ENV as any) || 'development',
    };
  }

  private loadEnvironmentOverrides(): void {
    // Network configuration from environment
    if (process.env.NETWORK_TIMEOUT) {
      this.config.network.timeout = parseInt(process.env.NETWORK_TIMEOUT, 10);
    }

    if (process.env.NETWORK_MAX_RETRIES) {
      this.config.network.retryConfig.maxRetries = parseInt(process.env.NETWORK_MAX_RETRIES, 10);
    }

    if (process.env.NETWORK_CONCURRENCY) {
      this.config.network.concurrency = parseInt(process.env.NETWORK_CONCURRENCY, 10);
    }

    // Logging configuration from environment
    if (process.env.LOG_LEVEL) {
      const level = process.env.LOG_LEVEL.toUpperCase();
      if (level in LogLevel) {
        this.config.logging.level = LogLevel[level as keyof typeof LogLevel];
      }
    }

    if (process.env.LOG_FILE) {
      this.config.logging.enableFile = true;
      this.config.logging.filePath = process.env.LOG_FILE;
    }

    if (process.env.LOG_JSON === 'true') {
      this.config.logging.formatJson = true;
    }

    // Sync configuration from environment
    if (process.env.SYNC_BATCH_SIZE) {
      this.config.sync.batchSize = parseInt(process.env.SYNC_BATCH_SIZE, 10);
    }

    if (process.env.SYNC_CONFLICT_RESOLUTION) {
      const resolution = process.env.SYNC_CONFLICT_RESOLUTION as any;
      if (['prefer-doc', 'prefer-md', 'merge', 'prompt'].includes(resolution)) {
        this.config.sync.conflictResolution = resolution;
      }
    }

    // Environment-specific overrides
    if (this.config.environment === 'development') {
      this.config.logging.level = LogLevel.DEBUG;
      this.config.logging.enableConsole = true;
    } else if (this.config.environment === 'production') {
      this.config.logging.level = LogLevel.INFO;
      this.config.logging.enableFile = true;
      this.config.logging.formatJson = true;
    } else if (this.config.environment === 'testing') {
      this.config.logging.level = LogLevel.WARN;
      this.config.logging.enableConsole = false;
      this.config.network.timeout = 5000; // Shorter timeout for tests
    }
  }

  private mergeConfig(updates: Partial<AppConfig>): void {
    if (updates.network) {
      this.config.network = { ...this.config.network, ...updates.network };
    }

    if (updates.logging) {
      this.config.logging = { ...this.config.logging, ...updates.logging };
    }

    if (updates.sync) {
      this.config.sync = { ...this.config.sync, ...updates.sync };
    }

    if (updates.environment) {
      this.config.environment = updates.environment;
    }
  }
}

// Convenience functions
export function getConfig(): Config {
  return Config.getInstance();
}

export function getNetworkConfig(): NetworkConfig {
  return Config.getInstance().network;
}

export function getLoggingConfig(): LoggerConfig {
  return Config.getInstance().logging;
}

export function getSyncConfig(): SyncConfig {
  return Config.getInstance().sync;
}

// Configuration validation
export class ConfigValidator {
  static validate(config: AppConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate network config
    if (config.network.timeout <= 0) {
      errors.push('Network timeout must be positive');
    }

    if (config.network.retryConfig.maxRetries < 0) {
      errors.push('Max retries must be non-negative');
    }

    if (config.network.concurrency <= 0) {
      errors.push('Concurrency must be positive');
    }

    // Validate sync config
    if (config.sync.batchSize <= 0) {
      errors.push('Batch size must be positive');
    }

    if (config.sync.syncInterval <= 0) {
      errors.push('Sync interval must be positive');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Default config paths for different environments
export const CONFIG_PATHS = {
  cli: '~/.config/google-docs-sync/config.json',
  plugin: '.obsidian/plugins/google-docs-sync/config.json',
} as const;
