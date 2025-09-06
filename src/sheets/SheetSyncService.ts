/**
 * Service for synchronizing Google Sheets with local storage
 * Supports multiple storage formats and formula preservation
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { DriveDocument } from '../drive/DriveAPI.js';
import { SheetAPI, SheetData, SheetUpdateBatch } from '../drive/SheetAPI.js';
import { ErrorUtils, ErrorContext } from '../utils/ErrorUtils.js';
import { createLogger } from '../utils/Logger.js';

import { SheetStorageEngine, SheetStorageSettings } from './SheetUtils.js';

export interface SheetSyncResult {
  filesProcessed: number;
  sheetsUpdated: number;
  formulasPreserved: number;
  errors: Array<{ file: string; error: string }>;
}

export class SheetSyncService {
  private sheetAPI: SheetAPI;
  private storageEngine: SheetStorageEngine;
  private logger = createLogger({ operation: 'sheet-sync' });

  constructor(accessToken: string, settings: SheetStorageSettings) {
    this.sheetAPI = new SheetAPI(accessToken);
    this.storageEngine = new SheetStorageEngine(settings);
  }

  /**
   * Pull Google Sheets to local storage
   */
  async pullSheets(sheets: DriveDocument[], localDir: string): Promise<SheetSyncResult> {
    const context: ErrorContext = {
      operation: 'pull-sheets',
      resourceId: localDir,
    };

    return ErrorUtils.withErrorContext(async () => {
      const result: SheetSyncResult = {
        filesProcessed: 0,
        sheetsUpdated: 0,
        formulasPreserved: 0,
        errors: [],
      };

      const op = this.logger.startOperation('pull-sheets');
      op.info(`Pulling ${sheets.length} Google Sheets to ${localDir}`);

      for (const sheet of sheets) {
        if (sheet.mimeType !== 'application/vnd.google-apps.spreadsheet') {
          continue; // Skip non-spreadsheet files
        }

        try {
          result.filesProcessed++;

          // Analyze sheet to determine storage format
          const analysis = await this.sheetAPI.analyzeSheet(sheet.id);
          const format = this.storageEngine.determineStorageFormat(analysis);

          op.info(`Processing sheet "${sheet.name}" -> format: ${format}`);

          // Get sheet data
          const sheetData = await this.sheetAPI.getSheetData(sheet.id);
          result.formulasPreserved += sheetData.formulas.length;

          // Store based on format
          await this.storeSheetLocally(sheet, sheetData, format, localDir);
          result.sheetsUpdated++;

          op.info(`Successfully stored "${sheet.name}" as ${format}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push({ file: sheet.name, error: errorMsg });
          op.error(`Failed to process sheet "${sheet.name}": ${errorMsg}`);
        }
      }

      op.success(
        `Pulled ${result.sheetsUpdated} sheets, preserved ${result.formulasPreserved} formulas`,
      );
      return result;
    }, context)();
  }

  /**
   * Push local sheet files to Google Sheets
   */
  async pushSheets(localDir: string, _targetFolderId: string): Promise<SheetSyncResult> {
    const context: ErrorContext = {
      operation: 'push-sheets',
      resourceId: localDir,
    };

    return ErrorUtils.withErrorContext(async () => {
      const result: SheetSyncResult = {
        filesProcessed: 0,
        sheetsUpdated: 0,
        formulasPreserved: 0,
        errors: [],
      };

      const op = this.logger.startOperation('push-sheets');

      // Find all sheet files in local directory
      const sheetFiles = await this.findSheetFiles(localDir);
      op.info(`Found ${sheetFiles.length} sheet files to push`);

      for (const filePath of sheetFiles) {
        try {
          result.filesProcessed++;

          const content = await fs.readFile(filePath, 'utf-8');
          const fileType = this.detectFileType(filePath, content);

          if (fileType === 'csvy') {
            await this.pushCSVYFile(content);
            result.sheetsUpdated++;
          } else if (fileType === 'markdown-table') {
            await this.pushMarkdownTable(content);
            result.sheetsUpdated++;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push({ file: path.basename(filePath), error: errorMsg });
          op.error(`Failed to push file "${filePath}": ${errorMsg}`);
        }
      }

      op.success(`Pushed ${result.sheetsUpdated} sheet files`);
      return result;
    }, context)();
  }

  /**
   * Store sheet data locally in the determined format
   */
  private async storeSheetLocally(
    sheet: DriveDocument,
    sheetData: SheetData,
    format: string,
    localDir: string,
  ): Promise<void> {
    const sanitizedName = this.sanitizeFileName(sheet.name);
    const relativePath = sheet.relativePath || '';
    const fullDir = path.join(localDir, relativePath);

    // Ensure directory exists
    await fs.mkdir(fullDir, { recursive: true });

    switch (format) {
      case 'markdown': {
        const filePath = path.join(fullDir, `${sanitizedName}.md`);
        const markdownTable = this.storageEngine.convertToMarkdownTable(sheetData);
        const frontmatter = this.buildMarkdownFrontmatter(sheet, sheetData);
        const content = `---\n${this.storageEngine.objectToYAML(frontmatter)}---\n\n# ${sheet.name}\n\n${markdownTable}`;
        await fs.writeFile(filePath, content, 'utf-8');
        break;
      }

      case 'csvy': {
        const filePath = path.join(fullDir, `${sanitizedName}.csvy`);
        const csvyData = this.storageEngine.convertToCSVY(sheetData, sheet.id);
        const content = this.storageEngine.generateCSVYContent(csvyData);
        await fs.writeFile(filePath, content, 'utf-8');
        break;
      }

      case 'csv': {
        const csvPath = path.join(fullDir, `${sanitizedName}.csv`);
        const mdPath = path.join(fullDir, `${sanitizedName}.md`);

        // Save CSV data
        const csvContent = this.storageEngine.arrayToCSV(sheetData.values);
        await fs.writeFile(csvPath, csvContent, 'utf-8');

        // Save companion metadata file
        const frontmatter = this.buildMarkdownFrontmatter(sheet, sheetData);
        const mdContent = `---\n${this.storageEngine.objectToYAML(frontmatter)}---\n\n# ${sheet.name}\n\nData stored in: [\`${sanitizedName}.csv\`](./${sanitizedName}.csv)\n\n**Formulas preserved**: ${sheetData.formulas.length}\n**Dimensions**: ${sheetData.values.length} rows × ${Math.max(...sheetData.values.map((r) => r.length))} columns`;
        await fs.writeFile(mdPath, mdContent, 'utf-8');
        break;
      }
    }
  }

  /**
   * Push CSVY file to Google Sheets
   */
  private async pushCSVYFile(content: string): Promise<void> {
    const csvyData = this.storageEngine.parseCSVYContent(content);
    const { frontmatter } = csvyData;

    if (!frontmatter.spreadsheetId) {
      throw new Error('CSVY file missing spreadsheetId in frontmatter');
    }

    // Parse CSV data back to 2D array
    const values = this.parseCSVToArray(csvyData.csvContent);

    // Create update batch
    const updateBatch: SheetUpdateBatch = {
      spreadsheetId: frontmatter.spreadsheetId,
      sheetId: 0, // Default to first sheet
      updates: [
        {
          range: `A1:${this.getA1Range(values)}`,
          values,
        },
      ],
      skipCells: new Set(frontmatter.formulas?.map((f) => f.cell) || []),
    };

    // Execute batch update (single revision)
    await this.sheetAPI.batchUpdateSheetValues(updateBatch);
  }

  /**
   * Push markdown table to Google Sheets
   */
  private async pushMarkdownTable(content: string): Promise<void> {
    // Extract frontmatter and table
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      throw new Error('Markdown file missing frontmatter');
    }

    const frontmatter = this.storageEngine.yamlToObject(frontmatterMatch[1]);
    const bodyContent = frontmatterMatch[2];

    // Parse markdown table
    const values = this.parseMarkdownTable(bodyContent);

    if (!frontmatter.docId) {
      throw new Error('Markdown file missing docId in frontmatter');
    }

    // Create update batch
    const updateBatch: SheetUpdateBatch = {
      spreadsheetId: frontmatter.docId,
      sheetId: 0,
      updates: [
        {
          range: `A1:${this.getA1Range(values)}`,
          values,
        },
      ],
      skipCells: new Set(), // Markdown tables shouldn't have formulas
    };

    await this.sheetAPI.batchUpdateSheetValues(updateBatch);
  }

  /**
   * Find all sheet files in directory
   */
  private async findSheetFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.findSheetFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.csvy' || (ext === '.md' && (await this.isSheetMarkdownFile(fullPath)))) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Directory might not exist
    }

    return files;
  }

  /**
   * Check if a markdown file contains sheet data
   */
  private async isSheetMarkdownFile(filePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

      if (frontmatterMatch) {
        const frontmatter = this.storageEngine.yamlToObject(frontmatterMatch[1]);
        return frontmatter.type === 'google-sheet';
      }
    } catch {
      // File read error
    }

    return false;
  }

  /**
   * Detect file type for processing
   */
  private detectFileType(
    filePath: string,
    content: string,
  ): 'csvy' | 'markdown-table' | 'csv' | 'unknown' {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.csvy') {
      return 'csvy';
    }

    if (ext === '.md') {
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const frontmatter = this.storageEngine.yamlToObject(frontmatterMatch[1]);
        if (frontmatter.type === 'google-sheet') {
          return 'markdown-table';
        }
      }
    }

    if (ext === '.csv') {
      return 'csv';
    }

    return 'unknown';
  }

  /**
   * Build frontmatter for markdown sheet files
   */
  private buildMarkdownFrontmatter(sheet: DriveDocument, sheetData: SheetData): any {
    return {
      docId: sheet.id,
      type: 'google-sheet',
      spreadsheetId: sheet.id,
      sheetName: sheetData.metadata.sheets[0]?.title || 'Sheet1',
      lastSync: new Date().toISOString(),
      dimensions: {
        rows: sheetData.values.length,
        columns: Math.max(...sheetData.values.map((row) => row.length)),
      },
      formulas: sheetData.formulas.length,
      webViewLink: sheet.webViewLink,
    };
  }

  /**
   * Sanitize filename for filesystem
   */
  private sanitizeFileName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  /**
   * Parse CSV content to 2D array
   */
  private parseCSVToArray(csv: string): any[][] {
    const lines = csv.split('\n');
    const result: any[][] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      // Simple CSV parsing (would use proper library in production)
      const row = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          row.push(current);
          current = '';
        } else {
          current += char;
        }
      }

      row.push(current); // Add final cell
      result.push(row);
    }

    return result;
  }

  /**
   * Parse markdown table to 2D array
   */
  private parseMarkdownTable(content: string): any[][] {
    const lines = content.split('\n');
    const result: any[][] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and separator lines
      if (!trimmed || trimmed.match(/^\|[\s\-:]+\|$/)) {
        continue;
      }

      // Parse table row
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed
          .slice(1, -1) // Remove outer pipes
          .split('|')
          .map((cell) => cell.trim());
        result.push(cells);
      }
    }

    return result;
  }

  /**
   * Get A1 range notation for data array
   */
  private getA1Range(values: any[][]): string {
    if (values.length === 0) return 'A1';

    const maxCols = Math.max(...values.map((row) => row.length));
    const endCol = this.numberToColumnLetter(maxCols - 1);
    const endRow = values.length;

    return `${endCol}${endRow}`;
  }

  /**
   * Convert column number to letter
   */
  private numberToColumnLetter(num: number): string {
    let result = '';
    while (num >= 0) {
      result = String.fromCharCode(65 + (num % 26)) + result;
      num = Math.floor(num / 26) - 1;
      if (num < 0) break;
    }
    return result;
  }
}
