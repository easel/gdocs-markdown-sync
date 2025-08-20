#!/usr/bin/env bun

// Modern CLI using fetch API and shared components
// Commands: auth | pull | push | sync | help

import { promises as fs, readFileSync } from 'fs';
import path from 'path';

import { AuthManagerFactory } from './auth/AuthManagerFactory.js';
import { parseArgs, getFlag, Dict } from './cli_utils.js';
import { DriveAPI } from './drive/DriveAPI.js';
import { ConflictResolver } from './sync/ConflictResolver.js';
import { createSyncService } from './sync/SyncService.js';
import { SyncUtils } from './sync/SyncUtils.js';
import { GoogleDocsSyncSettings } from './types.js';
import { getConfig, getNetworkConfig } from './utils/Config.js';
import { ErrorAggregator, BaseError, ErrorUtils } from './utils/ErrorUtils.js';
import { Logger, LogLevel, createLogger } from './utils/Logger.js';
import { getBuildVersion } from './version.js';

function printHelp(): void {
  console.log(`gdocs-markdown-sync ${getBuildVersion()} (Fetch-based CLI)

Usage:
  gdocs-markdown-sync auth
  gdocs-markdown-sync pull --drive-folder <name|id> --local-dir <path>
  gdocs-markdown-sync push --drive-folder <name|id> --local-dir <path>
  gdocs-markdown-sync sync --drive-folder <name|id> --local-dir <path>

Flags:
  --drive-folder      Google Drive folder name or ID (env: DRIVE_FOLDER)
  --local-dir         Local directory for Markdown (env: LOCAL_DIR)
  --conflicts         Conflict policy: prefer-doc|prefer-md|merge (env: CONFLICT_POLICY)
  --dry-run           Preview changes without executing them
  --log-level         Set log level: DEBUG, INFO, WARN, ERROR (env: LOG_LEVEL)

Conflict Resolution:
  prefer-doc         Always use Google Doc version when conflicts occur
  prefer-md          Always use Markdown file version when conflicts occur  
  merge              Attempt intelligent merge, fall back to conflict markers

Notes:
  - 'auth' launches an OAuth flow and saves tokens for reuse.
  - 'pull' exports Google Docs in the folder to Markdown into local-dir.
  - 'push' uploads/updates Markdown files from local-dir to Google Docs.
  - 'sync' performs intelligent bidirectional sync with conflict resolution.
  - If --drive-folder contains a name (not starting with folder ID pattern), 
    the CLI will find or create a folder with that name in your Drive root.
`);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function cmdAuth() {
  const logger = createLogger({ operation: 'auth-command' });
  const operation = logger.startOperation('oauth-authentication');

  try {
    operation.info('Starting OAuth authentication...');
    operation.info('✅ Using secure PKCE flow - no client secrets required!');

    const authManager = AuthManagerFactory.createForCLI();
    await authManager.startAuthFlow();

    operation.success('✅ OAuth authentication complete.');
  } catch (error) {
    operation.failure(
      '❌ OAuth authentication failed',
      {},
      error instanceof Error ? error : undefined,
    );
    throw error;
  }
}

async function getDriveAPI() {
  return ErrorUtils.withErrorContext(
    async () => {
      const authManager = AuthManagerFactory.createForCLI();

      // Get valid credentials (handles loading and refresh automatically)
      const credentials = await authManager.getValidCredentials();

      // Create DriveAPI with network configuration
      const networkConfig = getNetworkConfig();
      return new DriveAPI(credentials.access_token!, credentials.token_type, {
        timeout: networkConfig.timeout,
        retryConfig: networkConfig.retryConfig,
      });
    },
    { operation: 'get-drive-api' },
  )();
}

// Recursively walk directory tree and find all markdown files
async function walkMarkdownFiles(
  dir: string,
  baseDir: string = dir,
): Promise<Array<{ relativePath: string; fullPath: string; name: string }>> {
  const results: Array<{ relativePath: string; fullPath: string; name: string }> = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      // Skip hidden directories and common ignore patterns
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }

      if (entry.isDirectory()) {
        // Recursively walk subdirectories
        const subResults = await walkMarkdownFiles(fullPath, baseDir);
        results.push(...subResults);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push({
          relativePath,
          fullPath,
          name: entry.name,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to read directory ${dir}:`, error);
  }

  return results;
}

async function cmdPull(flags: Dict) {
  const logger = createLogger({ operation: 'pull-command' });
  const operation = logger.startOperation('pull-documents');
  const errorAggregator = new ErrorAggregator();

  try {
    const driveFolder = getFlag(flags, 'drive-folder', 'DRIVE_FOLDER');
    const localDir = getFlag(flags, 'local-dir', 'LOCAL_DIR');

    if (!driveFolder || !localDir) {
      operation.failure('Missing required configuration', {
        metadata: { driveFolder: !!driveFolder, localDir: !!localDir },
      });
      process.exit(2);
    }

    const driveAPI = await getDriveAPI();

    // Resolve folder name or ID to actual folder ID
    const driveFolderId = await driveAPI.resolveFolderId(driveFolder);

    await ensureDir(localDir);
    operation.info(`Pulling from Drive folder "${driveFolder}" (${driveFolderId}) -> ${localDir}`);

    const docs = await driveAPI.listDocsInFolder(driveFolderId);
    operation.info(`Found ${docs.length} document(s)`);

    let successCount = 0;

    for (const doc of docs) {
      const docLogger = logger.startOperation('pull-document', {
        resourceId: doc.id,
        resourceName: doc.name,
      });

      try {
        const markdown = await driveAPI.exportDocAsMarkdown(doc.id);
        const appProps = await driveAPI.getAppProperties(doc.id);

        // Build frontmatter
        const frontmatter = SyncUtils.buildPullFrontmatter(doc, appProps, markdown);
        frontmatter.sha256 = await SyncUtils.computeSHA256(markdown);

        const content = SyncUtils.buildMarkdownWithFrontmatter(frontmatter, markdown);

        // Determine file path with nested structure
        let fileName = SyncUtils.sanitizeFileName(doc.name) + '.md';
        let filePath: string;

        if (doc.relativePath) {
          // Document is in a subfolder
          const nestedPath = path.join(localDir, doc.relativePath);
          await ensureDir(nestedPath);
          filePath = path.join(nestedPath, fileName);
        } else {
          // Document is in root folder
          filePath = path.join(localDir, fileName);
        }

        await fs.writeFile(filePath, content, 'utf8');
        docLogger.success(
          `✓ Pulled ${doc.name}${doc.relativePath ? ` (${doc.relativePath})` : ''}`,
        );
        successCount++;
      } catch (err: any) {
        const errorContext = {
          resourceId: doc.id,
          resourceName: doc.name,
          filePath: doc.relativePath,
        };
        errorAggregator.add(ErrorUtils.normalize(err, errorContext));
        docLogger.failure(
          `✗ Failed to pull ${doc?.name ?? 'unknown'}`,
          errorContext,
          err instanceof Error ? err : undefined,
        );
      }
    }

    // Summary
    if (errorAggregator.hasErrors()) {
      const summary = errorAggregator.getSummary('pull-documents');
      operation.warn(
        `Pull completed with ${summary.totalErrors} error(s). Successfully pulled ${successCount}/${docs.length} documents`,
      );
      logger.warn('Pull errors summary:', {}, new Error(errorAggregator.toString()));
    } else {
      operation.success(`✅ Successfully pulled all ${docs.length} documents`);
    }
  } catch (error) {
    operation.failure('Pull operation failed', {}, error instanceof Error ? error : undefined);
    throw error;
  }
}

async function cmdPush(flags: Dict) {
  const driveFolder = getFlag(flags, 'drive-folder', 'DRIVE_FOLDER');
  const localDir = getFlag(flags, 'local-dir', 'LOCAL_DIR');

  if (!driveFolder || !localDir) {
    console.error('Missing required flags: --drive-folder and --local-dir');
    process.exit(2);
  }

  const driveAPI = await getDriveAPI();

  // Resolve folder name or ID to actual folder ID
  const driveFolderId = await driveAPI.resolveFolderId(driveFolder);

  console.log(`Pushing from ${localDir} -> Drive folder "${driveFolder}" (${driveFolderId})`);

  // Recursively find all markdown files
  const files = await walkMarkdownFiles(localDir);
  console.log(`Found ${files.length} markdown files (including nested directories)`);

  for (const file of files) {
    try {
      const raw = await fs.readFile(file.fullPath, 'utf8');
      const { frontmatter, markdown } = SyncUtils.parseFrontMatter(raw);

      // Sanitize markdown content for Google Drive compatibility
      const sanitizedMarkdown = SyncUtils.sanitizeMarkdownForGoogleDrive(markdown);

      const docId = frontmatter.docId || frontmatter['google-doc-id'];

      if (docId) {
        try {
          // Check if the document still exists before trying to update
          const exists = await driveAPI.documentExists(docId);
          if (!exists) {
            console.warn(
              `⚠ Document ${docId} no longer exists, creating new document for ${file.relativePath}`,
            );
            // Fall through to create new document logic below
          } else {
            await driveAPI.updateGoogleDoc(docId, sanitizedMarkdown);
            const info = await driveAPI.getFile(docId);

            const updatedFrontmatter = SyncUtils.buildPushFrontmatter(
              frontmatter,
              docId,
              path.parse(file.name).name,
              info.headRevisionId,
            );
            updatedFrontmatter.sha256 = await SyncUtils.computeSHA256(markdown);

            const updatedContent = SyncUtils.buildMarkdownWithFrontmatter(
              updatedFrontmatter,
              markdown,
            );
            await fs.writeFile(file.fullPath, updatedContent, 'utf8');
            console.log(`✓ Updated ${file.relativePath}`);
            continue; // Skip to next file
          }
        } catch (err: any) {
          if (
            err.message?.includes('File not found') ||
            err.message?.includes('Document not found')
          ) {
            console.warn(
              `⚠ Document ${docId} not accessible, creating new document for ${file.relativePath}`,
            );
            // Fall through to create new document logic below
          } else {
            // Re-throw other errors (network, permissions, etc.)
            throw err;
          }
        }
      }

      // Ensure nested folder structure exists in Google Drive
      const relativePath = SyncUtils.extractRelativePath(file.relativePath);
      const targetFolderId = await driveAPI.ensureNestedFolders(relativePath, driveFolderId);

      // Create new document (either no docId or stale docId)
      const newDocId = await driveAPI.createGoogleDoc(
        path.parse(file.name).name,
        sanitizedMarkdown,
        targetFolderId,
      );

      const updatedFrontmatter = SyncUtils.buildPushFrontmatter(
        frontmatter,
        newDocId,
        path.parse(file.name).name,
      );
      updatedFrontmatter.sha256 = await SyncUtils.computeSHA256(markdown);

      const updatedContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
      await fs.writeFile(file.fullPath, updatedContent, 'utf8');
      console.log(`✓ Created ${file.relativePath} -> ${newDocId}`);
    } catch (err: any) {
      console.error(`✗ Failed to push ${file.relativePath}: ${err?.message ?? err}`);
    }
  }
}

async function cmdSync(flags: Dict) {
  const logger = createLogger({ operation: 'sync-command' });
  const operation = logger.startOperation('intelligent-sync');
  const errorAggregator = new ErrorAggregator();

  try {
    const driveFolder = getFlag(flags, 'drive-folder', 'DRIVE_FOLDER');
    const localDir = getFlag(flags, 'local-dir', 'LOCAL_DIR');
    const conflictPolicy = getFlag(flags, 'conflicts', 'CONFLICT_POLICY') || 'prefer-doc';
    const dryRun = flags['dry-run'] === 'true';

    if (!driveFolder || !localDir) {
      operation.failure('Missing required configuration', {
        metadata: { driveFolder: !!driveFolder, localDir: !!localDir },
      });
      process.exit(2);
    }

    // Validate conflict policy
    if (!ConflictResolver.isValidPolicy(conflictPolicy as any)) {
      operation.failure(
        `Invalid conflict policy: ${conflictPolicy}. Must be one of: prefer-doc, prefer-md, merge`,
      );
      process.exit(2);
    }

    const driveAPI = await getDriveAPI();
    const driveFolderId = await driveAPI.resolveFolderId(driveFolder);

    // Create sync service with settings
    const settings: GoogleDocsSyncSettings = {
      driveFolderId,
      conflictPolicy: conflictPolicy as any,
      pollInterval: 60, // Not used in CLI
    };

    const syncService = createSyncService(settings);

    await ensureDir(localDir);
    operation.info(
      `Intelligent sync: Drive folder "${driveFolder}" (${driveFolderId}) ↔ ${localDir}`,
    );
    operation.info(
      `Conflict policy: ${conflictPolicy} - ${ConflictResolver.getPolicyDescription(conflictPolicy as any)}`,
    );

    if (dryRun) {
      operation.info('🔍 DRY RUN MODE - No changes will be made');
    }

    // Get all documents from Drive
    const remoteDocs = await driveAPI.listDocsInFolder(driveFolderId);
    operation.info(`Found ${remoteDocs.length} remote document(s)`);

    // Get all local markdown files
    const localFiles = await walkMarkdownFiles(localDir);
    operation.info(`Found ${localFiles.length} local markdown file(s)`);

    let syncCount = 0;
    let conflictCount = 0;
    let skipCount = 0;

    // Process each remote document
    for (const doc of remoteDocs) {
      const docLogger = logger.startOperation('sync-document', {
        resourceId: doc.id,
        resourceName: doc.name,
      });

      try {
        // Find corresponding local file
        const localFile = localFiles.find((f) => {
          const content = readFileSync(f.fullPath, 'utf8');
          const { frontmatter } = SyncUtils.parseFrontMatter(content);
          return frontmatter.docId === doc.id || frontmatter['google-doc-id'] === doc.id;
        });

        let localContent = '';
        let localFrontmatter = {};

        if (localFile) {
          const raw = await fs.readFile(localFile.fullPath, 'utf8');
          const parsed = SyncUtils.parseFrontMatter(raw);
          localContent = parsed.markdown;
          localFrontmatter = parsed.frontmatter;
        } else {
          // New document from remote - create local file
          localContent = '';
          localFrontmatter = {
            'google-doc-id': doc.id,
            'google-doc-url': `https://docs.google.com/document/d/${doc.id}/edit`,
            'google-doc-title': doc.name,
          };
        }

        // Get remote content
        const remoteContent = await driveAPI.exportDocAsMarkdown(doc.id);

        // Perform intelligent sync
        const syncResult = await syncService.syncDocument(
          localContent,
          localFrontmatter,
          remoteContent,
          doc.modifiedTime || '',
          doc.modifiedTime || '',
          { dryRun },
        );

        if (!syncResult.result.success) {
          throw new Error(syncResult.result.error || 'Sync failed');
        }

        // Generate summary
        const summary = syncService.generateSyncSummary(syncResult.result);
        docLogger.info(summary);

        if (syncResult.result.action === 'conflict_manual') {
          conflictCount++;
        } else if (syncResult.result.action === 'no_change') {
          skipCount++;
        } else {
          syncCount++;
        }

        // Update local file if not dry run
        if (!dryRun && syncResult.updatedContent && syncResult.updatedFrontmatter) {
          let filePath: string;

          if (localFile) {
            filePath = localFile.fullPath;
          } else {
            // Create new file
            const fileName = SyncUtils.sanitizeFileName(doc.name) + '.md';
            filePath = path.join(localDir, fileName);
          }

          const updatedDocument = SyncUtils.buildMarkdownWithFrontmatter(
            syncResult.updatedFrontmatter,
            syncResult.updatedContent,
          );
          await fs.writeFile(filePath, updatedDocument, 'utf8');
        }

        // Show conflict details if needed
        if (syncResult.result.conflictMarkers && syncResult.result.conflictMarkers.length > 0) {
          docLogger.warn('Conflict details:');
          for (const marker of syncResult.result.conflictMarkers) {
            docLogger.warn(`  • ${marker}`);
          }
        }

        docLogger.success(`✓ Synced ${doc.name}`);
      } catch (err: any) {
        const errorContext = {
          resourceId: doc.id,
          resourceName: doc.name,
          operation: 'sync-document',
        };
        errorAggregator.add(ErrorUtils.normalize(err, errorContext));
        docLogger.failure(
          `✗ Failed to sync ${doc?.name ?? 'unknown'}`,
          errorContext,
          err instanceof Error ? err : undefined,
        );
      }
    }

    // Process orphaned local files (files with docId but no matching remote doc)
    for (const localFile of localFiles) {
      try {
        const raw = await fs.readFile(localFile.fullPath, 'utf8');
        const { frontmatter } = SyncUtils.parseFrontMatter(raw);
        const docId = frontmatter.docId || frontmatter['google-doc-id'];

        if (docId && !remoteDocs.find((doc) => doc.id === docId)) {
          operation.warn(
            `⚠ Local file ${localFile.relativePath} references non-existent document ${docId}`,
          );
          // Could implement cleanup or re-push logic here
        }
      } catch (err) {
        operation.warn(`Failed to check local file ${localFile.relativePath}: ${err}`);
      }
    }

    // Summary
    if (errorAggregator.hasErrors()) {
      const summary = errorAggregator.getSummary('sync-documents');
      operation.warn(
        `Sync completed with ${summary.totalErrors} error(s). ` +
          `Synced: ${syncCount}, Conflicts: ${conflictCount}, Skipped: ${skipCount}`,
      );
      logger.warn('Sync errors summary:', {}, new Error(errorAggregator.toString()));
    } else {
      operation.success(
        `✅ Sync completed successfully. ` +
          `Synced: ${syncCount}, Conflicts: ${conflictCount}, Skipped: ${skipCount}`,
      );
    }

    if (dryRun) {
      operation.info('🔍 DRY RUN complete - no files were modified');
    }
  } catch (error) {
    operation.failure('Sync operation failed', {}, error instanceof Error ? error : undefined);
    throw error;
  }
}

async function main() {
  // Initialize configuration and logging
  const config = getConfig();
  const logger = Logger.getInstance(config.logging);
  const mainLogger = createLogger({ operation: 'cli-main' });

  const { cmd, flags } = parseArgs(process.argv);
  const operation = mainLogger.startOperation(`cli-${cmd}`, {
    metadata: {
      command: cmd,
      flags: Object.keys(flags),
    },
  });

  try {
    // Set log level from flags if provided
    if (flags['log-level']) {
      const level = flags['log-level'].toUpperCase();
      if (level in LogLevel) {
        config.updateLogging({ level: LogLevel[level as keyof typeof LogLevel] });
        logger.info(`Log level set to ${level}`);
      }
    }

    switch (cmd) {
      case 'auth':
        await cmdAuth();
        break;
      case 'pull':
        await cmdPull(flags);
        break;
      case 'push':
        await cmdPush(flags);
        break;
      case 'sync':
        await cmdSync(flags);
        break;
      case 'help':
      default:
        printHelp();
        break;
    }

    operation.success(`Command '${cmd}' completed successfully`);

    // Show metrics if debug logging is enabled
    if (config.logging.level <= LogLevel.DEBUG) {
      const metrics = logger.getMetrics();
      if (Object.keys(metrics).length > 0) {
        mainLogger.debug('Performance metrics:', { metadata: metrics });
      }
    }
  } catch (err: any) {
    const error = ErrorUtils.normalize(err, { operation: `cli-${cmd}` });
    operation.failure(`Command '${cmd}' failed`, {}, error);

    // Enhanced error reporting
    if (error instanceof BaseError) {
      console.error(`\n❌ Error: ${error.message}`);
      if (error.context.operation) {
        console.error(`   Operation: ${error.context.operation}`);
      }
      if (error.context.resourceId) {
        console.error(`   Resource ID: ${error.context.resourceId}`);
      }
      if (error.context.correlationId) {
        console.error(`   Correlation ID: ${error.context.correlationId}`);
      }

      // Show stack trace in debug mode
      if (config.logging.level <= LogLevel.DEBUG && error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    } else {
      console.error(`\n❌ Error: ${err?.message || String(err)}`);
      if (config.logging.level <= LogLevel.DEBUG && err?.stack) {
        console.error('\nStack trace:');
        console.error(err.stack);
      }
    }

    process.exit(1);
  }
}

main();
