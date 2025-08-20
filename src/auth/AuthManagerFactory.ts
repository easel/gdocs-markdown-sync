import { FilesystemTokenStorage } from './FilesystemTokenStorage';
import { ObsidianTokenStorage } from './ObsidianTokenStorage';
import { TokenStorage } from './TokenStorage';
import { UnifiedOAuthManager, OAuthConfig } from './UnifiedOAuthManager';

/**
 * Factory for creating appropriate auth managers based on environment
 */
export class AuthManagerFactory {
  /**
   * Create auth manager for CLI environment
   */
  static createForCLI(profile?: string, config?: OAuthConfig): UnifiedOAuthManager {
    const tokenStorage = new FilesystemTokenStorage(profile);
    return new UnifiedOAuthManager(tokenStorage, config);
  }

  /**
   * Create auth manager for Obsidian plugin environment
   */
  static createForObsidian(
    plugin: any,
    profile?: string,
    config?: OAuthConfig,
  ): UnifiedOAuthManager {
    const tokenStorage = new ObsidianTokenStorage(plugin, profile);
    return new UnifiedOAuthManager(tokenStorage, config);
  }

  /**
   * Create auth manager with custom token storage
   */
  static createWithStorage(tokenStorage: TokenStorage, config?: OAuthConfig): UnifiedOAuthManager {
    return new UnifiedOAuthManager(tokenStorage, config);
  }
}
