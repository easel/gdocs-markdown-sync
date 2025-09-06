#!/usr/bin/env bun

// Modern CLI using fetch API and shared components
// Commands: auth | pull | push | sync | help

// Note: All filesystem operations now use FilesystemStorage
import path from 'path';

import { AuthManagerFactory } from './auth/AuthManagerFactory.js';
import { parseArgs, getFlag, Dict } from './cli_utils.js';
import { DriveAPI } from './drive/DriveAPI.js';
import { computeSHA256 } from './fs/frontmatter.js';
import { SheetSyncService } from './sheets/SheetSyncService.js';
import { SheetStorageSettings } from './sheets/SheetUtils.js';
import { FilesystemStorage } from './storage/FilesystemStorage.js';
import { ConflictResolver } from './sync/ConflictResolver.js';
import { createSyncService } from './sync/SyncService.js';
import { SyncUtils } from './sync/SyncUtils.js';
import { GoogleDocsSyncSettings } from './types.js';
import { getConfig, getNetworkConfig } from './utils/Config.js';
import { ErrorAggregator, BaseError, ErrorUtils } from './utils/ErrorUtils.js';
import { Logger, LogLevel, createLogger } from './utils/Logger.js';
import { getBuildVersion } from './version.js';

function printHelp(): void {
  console.log(`google-docs-sync ${getBuildVersion()} (Fetch-based CLI)

Usage:
  google-docs-sync auth
  google-docs-sync pull --drive-folder <name|id> --local-dir <path>
  google-docs-sync push --drive-folder <name|id> --local-dir <path>
  google-docs-sync sync --drive-folder <name|id> --local-dir <path>

Flags:
  --drive-folder      Google Drive folder name or ID (env: DRIVE_FOLDER)
  --local-dir         Local directory for Markdown (env: LOCAL_DIR)
  --conflicts         Conflict policy: prefer-doc|prefer-md|merge (env: CONFLICT_POLICY)
  --sync-sheets       Include Google Sheets in sync operations (default: false)
  --dry-run           Preview changes without executing them
  --log-level         Set log level: DEBUG, INFO, WARN, ERROR (env: LOG_LEVEL)

Conflict Resolution:
  prefer-doc         Always use Google Doc version when conflicts occur
  prefer-md          Always use Markdown file version when conflicts occur  
  merge              Attempt intelligent merge, fall back to conflict markers

Notes:
  - 'auth' launches an OAuth flow and saves tokens for reuse.
  - 'pull' exports Google Docs and Sheets in the folder to local files.
  - 'push' uploads/updates local files to Google Docs and Sheets.
  - 'sync' performs intelligent bidirectional sync with conflict resolution.
  - Google Sheets are stored as markdown tables, CSV, or CSVY based on size/complexity.
  - Formulas are preserved on Google Sheets side; only values are synced.
  - If --drive-folder contains a name (not starting with folder ID pattern), 
    the CLI will find or create a folder with that name in your Drive root.
`);
}

// Helper to create FilesystemStorage instance
function createStorage(baseDirectory: string): FilesystemStorage {
  return new FilesystemStorage(baseDirectory);
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

    // Display workspace information
    try {
      const driveAPI = await getDriveAPI();
      const response = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota',
        {
          headers: {
            Authorization: `Bearer ${driveAPI.getAccessToken()}`,
          },
        },
      );

      if (response.ok) {
        const userInfo = await response.json();
        const email = userInfo.user?.emailAddress || 'Unknown email';
        const displayName = userInfo.user?.displayName || 'Unknown';
        const domain = email.includes('@') ? email.split('@')[1] : 'Unknown domain';

        operation.info(`👤 Authenticated as: ${displayName} (${email})`);
        operation.info(`🏢 Workspace Domain: ${domain}`);

        // Display storage quota if available
        if (userInfo.storageQuota) {
          const used = parseInt(userInfo.storageQuota.usage || '0');
          const limit = parseInt(userInfo.storageQuota.limit || '0');
          if (used && limit) {
            const usedGB = (used / (1024 * 1024 * 1024)).toFixed(1);
            const limitGB = (limit / (1024 * 1024 * 1024)).toFixed(1);
            const percentage = ((used / limit) * 100).toFixed(1);
            operation.info(`💾 Storage: ${usedGB}GB / ${limitGB}GB (${percentage}%)`);
          }
        }
      }
    } catch (error) {
      // Don't fail the auth command if workspace info fetch fails
      operation.warn('Could not fetch workspace details, but authentication succeeded');
    }
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

// Helper to get markdown files using FilesystemStorage
async function getMarkdownFiles(
  storage: FilesystemStorage,
  directory: string,
): Promise<Array<{ relativePath: string; fullPath: string; name: string }>> {
  const markdownPaths = await storage.walkDirectory(directory, '*.md');

  return markdownPaths.map((fullPath) => {
    const relativePath = path.relative(directory, fullPath);
    const name = storage.getBaseName(fullPath);
    return { relativePath, fullPath, name };
  });
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
    const storage = createStorage(localDir);

    // Resolve folder name or ID to actual folder ID
    const driveFolderId = await driveAPI.resolveFolderId(driveFolder);

    await storage.createDirectory('.');
    operation.info(`Pulling from Drive folder "${driveFolder}" (${driveFolderId}) -> ${localDir}`);

    const docs = await driveAPI.listDocsInFolder(driveFolderId);
    const syncSheets = flags['sync-sheets'] === 'true';

    // Separate documents and sheets
    const documents = docs.filter(
      (doc) => doc.mimeType === 'application/vnd.google-apps.document' || !doc.mimeType,
    );
    const sheets = docs.filter((doc) => doc.mimeType === 'application/vnd.google-apps.spreadsheet');

    operation.info(`Found ${documents.length} document(s) and ${sheets.length} spreadsheet(s)`);

    let successCount = 0;

    // Process documents
    for (const doc of documents) {
      const docLogger = logger.startOperation('pull-document', {
        resourceId: doc.id,
        resourceName: doc.name,
      });

      try {
        const markdown = await driveAPI.exportDocAsMarkdown(doc.id);
        const appProps = await driveAPI.getAppProperties(doc.id);

        // Build frontmatter
        const frontmatter = SyncUtils.buildPullFrontmatter(doc, appProps, markdown);
        frontmatter.sha256 = await computeSHA256(markdown);

        const content = SyncUtils.buildMarkdownWithFrontmatter(frontmatter, markdown);

        // Determine file path with nested structure
        let fileName = SyncUtils.sanitizeFileName(doc.name) + '.md';
        let filePath: string;

        if (doc.relativePath) {
          // Document is in a subfolder
          const nestedPath = doc.relativePath;
          await storage.createDirectory(nestedPath);
          filePath = storage.joinPath(nestedPath, fileName);
        } else {
          // Document is in root folder
          filePath = fileName;
        }

        await storage.writeFile(filePath, content);
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

    // Process sheets if enabled
    if (syncSheets && sheets.length > 0) {
      operation.info(`Processing ${sheets.length} Google Sheets...`);

      const sheetSettings: SheetStorageSettings = {
        maxRowsForMarkdown: 50,
        maxRowsForCSVY: 500,
        preferredFormat: 'auto',
        preserveFormulas: true,
        formulaDisplay: 'value',
      };

      const accessToken = driveAPI.getAccessToken();
      const sheetSyncService = new SheetSyncService(accessToken, sheetSettings);

      try {
        const sheetResult = await sheetSyncService.pullSheets(sheets, localDir);
        operation.info(
          `✓ Processed ${sheetResult.sheetsUpdated} sheets, preserved ${sheetResult.formulasPreserved} formulas`,
        );

        if (sheetResult.errors.length > 0) {
          operation.warn(`⚠ ${sheetResult.errors.length} sheet errors occurred`);
          for (const error of sheetResult.errors) {
            operation.warn(`  • ${error.file}: ${error.error}`);
          }
        }

        successCount += sheetResult.sheetsUpdated;
      } catch (error) {
        operation.warn(
          `Failed to process sheets: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (sheets.length > 0) {
      operation.info(`📊 Found ${sheets.length} sheet(s) - use --sync-sheets to include them`);
    }

    // Summary
    if (errorAggregator.hasErrors()) {
      const summary = errorAggregator.getSummary('pull-documents');
      const totalItems = documents.length + (syncSheets ? sheets.length : 0);
      operation.warn(
        `Pull completed with ${summary.totalErrors} error(s). Successfully pulled ${successCount}/${totalItems} items`,
      );
      logger.warn('Pull errors summary:', {}, new Error(errorAggregator.toString()));
    } else {
      const totalItems = documents.length + (syncSheets ? sheets.length : 0);
      operation.success(`✅ Successfully pulled all ${totalItems} items`);
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
  const storage = createStorage(localDir);

  // Resolve folder name or ID to actual folder ID
  const driveFolderId = await driveAPI.resolveFolderId(driveFolder);

  console.log(`Pushing from ${localDir} -> Drive folder "${driveFolder}" (${driveFolderId})`);

  // Recursively find all markdown files
  const files = await getMarkdownFiles(storage, '.');
  console.log(`Found ${files.length} markdown files (including nested directories)`);

  for (const file of files) {
    try {
      const raw = await storage.readFile(file.fullPath);
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
            updatedFrontmatter.sha256 = await computeSHA256(markdown);

            const updatedContent = SyncUtils.buildMarkdownWithFrontmatter(
              updatedFrontmatter,
              markdown,
            );
            await storage.writeFile(file.fullPath, updatedContent);
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
      updatedFrontmatter.sha256 = await computeSHA256(markdown);

      const updatedContent = SyncUtils.buildMarkdownWithFrontmatter(updatedFrontmatter, markdown);
      await storage.writeFile(file.fullPath, updatedContent);
      console.log(`✓ Created ${file.relativePath} -> ${newDocId}`);
    } catch (err: any) {
      console.error(`✗ Failed to push ${file.relativePath}: ${err?.message ?? err}`);
    }
  }

  // Process sheet files if enabled
  const syncSheets = flags['sync-sheets'] === 'true';
  if (syncSheets) {
    console.log(`Pushing Google Sheets from ${localDir}...`);

    const sheetSettings: SheetStorageSettings = {
      maxRowsForMarkdown: 50,
      maxRowsForCSVY: 500,
      preferredFormat: 'auto',
      preserveFormulas: true,
      formulaDisplay: 'value',
    };

    const accessToken = driveAPI.getAccessToken();
    const sheetSyncService = new SheetSyncService(accessToken, sheetSettings);

    try {
      const sheetResult = await sheetSyncService.pushSheets(localDir, driveFolderId);
      console.log(`✓ Pushed ${sheetResult.sheetsUpdated} sheets to Google Drive`);

      if (sheetResult.errors.length > 0) {
        console.warn(`⚠ ${sheetResult.errors.length} sheet errors occurred`);
        for (const error of sheetResult.errors) {
          console.warn(`  • ${error.file}: ${error.error}`);
        }
      }
    } catch (error) {
      console.error(
        `Failed to push sheets: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const conflictPolicy = getFlag(flags, 'conflicts', 'CONFLICT_POLICY') || 'last-write-wins';
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
    const storage = createStorage(localDir);

    await storage.createDirectory('.');
    operation.info(
      `Intelligent sync: Drive folder "${driveFolder}" (${driveFolderId}) ↔ ${localDir}`,
    );
    operation.info(
      `Conflict policy: ${conflictPolicy} - ${ConflictResolver.getPolicyDescription(conflictPolicy as any)}`,
    );

    if (dryRun) {
      operation.info('🔍 DRY RUN MODE - No changes will be made');
    }

    // Get all documents and sheets from Drive
    const remoteDocs = await driveAPI.listDocsInFolder(driveFolderId);
    const syncSheets = flags['sync-sheets'] === 'true';

    // Separate documents and sheets
    const documents = remoteDocs.filter(
      (doc) => doc.mimeType === 'application/vnd.google-apps.document' || !doc.mimeType,
    );
    const sheets = remoteDocs.filter(
      (doc) => doc.mimeType === 'application/vnd.google-apps.spreadsheet',
    );

    operation.info(
      `Found ${documents.length} remote document(s) and ${sheets.length} spreadsheet(s)`,
    );

    // Get all local markdown files
    const localFiles = await getMarkdownFiles(storage, '.');
    operation.info(`Found ${localFiles.length} local markdown file(s)`);

    let syncCount = 0;
    let conflictCount = 0;
    let skipCount = 0;

    // Process each remote document
    for (const doc of documents) {
      const docLogger = logger.startOperation('sync-document', {
        resourceId: doc.id,
        resourceName: doc.name,
      });

      try {
        // Find corresponding local file
        let localFile: (typeof localFiles)[0] | undefined;
        for (const f of localFiles) {
          try {
            const content = await storage.readFile(f.fullPath);
            const { frontmatter } = SyncUtils.parseFrontMatter(content);
            if (frontmatter.docId === doc.id || frontmatter['google-doc-id'] === doc.id) {
              localFile = f;
              break;
            }
          } catch {
            // Skip files that can't be read
            continue;
          }
        }

        let localContent = '';
        let localFrontmatter = {};

        if (localFile) {
          const raw = await storage.readFile(localFile.fullPath);
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
            filePath = fileName;
          }

          const updatedDocument = SyncUtils.buildMarkdownWithFrontmatter(
            syncResult.updatedFrontmatter,
            syncResult.updatedContent,
          );
          await storage.writeFile(filePath, updatedDocument);
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
        const raw = await storage.readFile(localFile.fullPath);
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

    // Note about sheet sync
    if (sheets.length > 0) {
      if (syncSheets) {
        operation.info(
          `📊 Found ${sheets.length} sheet(s) - bidirectional sheet sync not yet implemented`,
        );
        operation.info(
          `   Use 'pull --sync-sheets' and 'push --sync-sheets' for one-way sheet sync`,
        );
      } else {
        operation.info(
          `📊 Found ${sheets.length} sheet(s) - use --sync-sheets to enable sheet operations`,
        );
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
