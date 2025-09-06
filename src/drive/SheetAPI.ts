/**
 * Google Sheets API client for spreadsheet operations
 * Handles sheet data, formulas, and metadata with atomic batch updates
 */

import { ErrorContext, ErrorUtils } from '../utils/ErrorUtils.js';
import { NetworkUtils, RequestConfig } from '../utils/NetworkUtils.js';

export interface SheetMetadata {
  spreadsheetId: string;
  title: string;
  sheets: Array<{
    sheetId: number;
    title: string;
    gridProperties: {
      rowCount: number;
      columnCount: number;
    };
  }>;
}

export interface SheetAnalysis {
  dimensions: { rows: number; cols: number };
  hasFormulas: boolean;
  formulaCells: Set<string>; // A1 notation
  dataType: 'numeric' | 'text' | 'mixed';
  complexity: 'simple' | 'medium' | 'complex';
  recommendedFormat: 'markdown' | 'csv' | 'csvy' | 'base';
}

export interface Formula {
  cell: string; // A1 notation
  formula: string;
  effectiveValue: any;
}

export interface SheetData {
  values: any[][];
  formulas: Formula[];
  metadata: SheetMetadata;
}

export interface SheetUpdateBatch {
  spreadsheetId: string;
  sheetId: number;
  updates: Array<{
    range: string; // A1 notation
    values: any[][];
  }>;
  skipCells: Set<string>; // A1 notation of cells to skip (formulas)
}

export class SheetAPI {
  private authHeaders: Record<string, string>;
  private defaultRequestConfig: RequestConfig;

  constructor(
    accessToken: string,
    tokenType: string = 'Bearer',
    requestConfig: Partial<RequestConfig> = {},
  ) {
    this.authHeaders = {
      Authorization: `${tokenType} ${accessToken}`,
    };

    this.defaultRequestConfig = {
      timeout: 30000,
      retryConfig: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        retryableStatusCodes: [408, 429, 500, 502, 503, 504],
        retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
      },
      ...requestConfig,
    };
  }

  /**
   * Get spreadsheet metadata including sheet names and dimensions
   */
  async getSpreadsheetMetadata(spreadsheetId: string): Promise<SheetMetadata> {
    const context: ErrorContext = {
      operation: 'get-spreadsheet-metadata',
      resourceId: spreadsheetId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const response = await NetworkUtils.fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title,sheets(properties(sheetId,title,gridProperties))`,
        {
          headers: this.authHeaders,
        },
        this.defaultRequestConfig,
      );

      const data = await response.json();

      return {
        spreadsheetId: data.spreadsheetId,
        title: data.properties.title,
        sheets: data.sheets.map((sheet: any) => ({
          sheetId: sheet.properties.sheetId,
          title: sheet.properties.title,
          gridProperties: {
            rowCount: sheet.properties.gridProperties?.rowCount || 1000,
            columnCount: sheet.properties.gridProperties?.columnCount || 26,
          },
        })),
      };
    }, context)();
  }

  /**
   * Get sheet values and formulas for analysis
   */
  async getSheetData(spreadsheetId: string, sheetName?: string): Promise<SheetData> {
    const context: ErrorContext = {
      operation: 'get-sheet-data',
      resourceId: spreadsheetId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const range = sheetName || 'Sheet1';

      // Get both values and grid data (which includes formulas)
      const [valuesResponse, gridResponse] = await Promise.all([
        NetworkUtils.fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
          { headers: this.authHeaders },
          this.defaultRequestConfig,
        ),
        NetworkUtils.fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?ranges=${range}&includeGridData=true`,
          { headers: this.authHeaders },
          this.defaultRequestConfig,
        ),
      ]);

      const values = await valuesResponse.json();
      const grid = await gridResponse.json();

      // Extract formulas from grid data
      const formulas: Formula[] = [];
      const sheetData = grid.sheets[0]?.data[0];

      if (sheetData?.rowData) {
        sheetData.rowData.forEach((row: any, rowIndex: number) => {
          row.values?.forEach((cell: any, colIndex: number) => {
            if (cell.userEnteredValue?.formulaValue) {
              formulas.push({
                cell: this.coordinatesToA1(rowIndex, colIndex),
                formula: cell.userEnteredValue.formulaValue,
                effectiveValue: cell.effectiveValue,
              });
            }
          });
        });
      }

      // Get metadata
      const metadata = await this.getSpreadsheetMetadata(spreadsheetId);

      return {
        values: values.values || [],
        formulas,
        metadata,
      };
    }, context)();
  }

  /**
   * Analyze sheet characteristics to determine best storage format
   */
  async analyzeSheet(spreadsheetId: string, sheetName?: string): Promise<SheetAnalysis> {
    const context: ErrorContext = {
      operation: 'analyze-sheet',
      resourceId: spreadsheetId,
    };

    return ErrorUtils.withErrorContext(async () => {
      const sheetData = await this.getSheetData(spreadsheetId, sheetName);

      const dimensions = {
        rows: sheetData.values.length,
        cols: Math.max(...sheetData.values.map((row) => row.length)),
      };

      const hasFormulas = sheetData.formulas.length > 0;
      const formulaCells = new Set(sheetData.formulas.map((f) => f.cell));

      // Analyze data types
      let numericCount = 0;
      let textCount = 0;
      let _totalCells = 0;

      for (const row of sheetData.values) {
        for (const cell of row) {
          if (cell !== null && cell !== undefined && cell !== '') {
            _totalCells++;
            if (typeof cell === 'number' || !isNaN(Number(cell))) {
              numericCount++;
            } else {
              textCount++;
            }
          }
        }
      }

      // Determine complexity
      const complexity: 'simple' | 'medium' | 'complex' =
        hasFormulas || dimensions.rows > 500 || dimensions.cols > 20
          ? 'complex'
          : dimensions.rows > 50 || dimensions.cols > 10
            ? 'medium'
            : 'simple';

      // Recommend storage format
      let recommendedFormat: 'markdown' | 'csv' | 'csvy' | 'base';

      if (complexity === 'simple' && !hasFormulas) {
        recommendedFormat = 'markdown';
      } else if (hasFormulas && dimensions.rows < 1000) {
        recommendedFormat = 'base';
      } else if (complexity === 'medium' || hasFormulas) {
        recommendedFormat = 'csvy';
      } else {
        recommendedFormat = 'csv';
      }

      // Determine data type
      const dataType: 'numeric' | 'text' | 'mixed' =
        numericCount > textCount * 2 ? 'numeric' : textCount > numericCount * 2 ? 'text' : 'mixed';

      return {
        dimensions,
        hasFormulas,
        formulaCells,
        dataType,
        complexity,
        recommendedFormat,
      };
    }, context)();
  }

  /**
   * Export sheet as CSV (using Drive API for better compatibility)
   */
  async exportSheetAsCSV(spreadsheetId: string, sheetId?: number): Promise<string> {
    const context: ErrorContext = {
      operation: 'export-sheet-csv',
      resourceId: spreadsheetId,
    };

    return ErrorUtils.withErrorContext(async () => {
      let url = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/export?mimeType=text/csv`;

      // Add sheet ID if specified (exports specific sheet)
      if (sheetId !== undefined) {
        url += `&gid=${sheetId}`;
      }

      const response = await NetworkUtils.fetchWithRetry(
        url,
        { headers: this.authHeaders },
        this.defaultRequestConfig,
      );

      return await response.text();
    }, context)();
  }

  /**
   * Batch update sheet values while preserving formulas
   */
  async batchUpdateSheetValues(update: SheetUpdateBatch): Promise<void> {
    const context: ErrorContext = {
      operation: 'batch-update-sheet-values',
      resourceId: update.spreadsheetId,
    };

    return ErrorUtils.withErrorContext(async () => {
      // Get current sheet state to identify formula cells
      const currentSheet = await NetworkUtils.fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${update.spreadsheetId}?ranges=Sheet1&includeGridData=true`,
        { headers: this.authHeaders },
        this.defaultRequestConfig,
      );

      const currentData = await currentSheet.json();
      const formulaCells = new Set<string>();

      // Build formula map from current sheet
      const sheetData = currentData.sheets[0]?.data[0];
      if (sheetData?.rowData) {
        sheetData.rowData.forEach((row: any, rowIndex: number) => {
          row.values?.forEach((cell: any, colIndex: number) => {
            if (cell.userEnteredValue?.formulaValue) {
              formulaCells.add(this.coordinatesToA1(rowIndex, colIndex));
            }
          });
        });
      }

      // Build batch update request, excluding formula cells
      const requests = [];

      for (const updateRange of update.updates) {
        const rowData = [];
        const rangeInfo = this.parseA1Range(updateRange.range);

        for (let r = 0; r < updateRange.values.length; r++) {
          const rowValues = [];
          for (let c = 0; c < updateRange.values[r].length; c++) {
            const cellA1 = this.coordinatesToA1(rangeInfo.startRow + r, rangeInfo.startCol + c);

            // Skip cells that contain formulas
            if (formulaCells.has(cellA1) || update.skipCells.has(cellA1)) {
              rowValues.push({}); // Empty object preserves existing value
            } else {
              rowValues.push({
                userEnteredValue: {
                  stringValue: String(updateRange.values[r][c] || ''),
                },
              });
            }
          }
          rowData.push({ values: rowValues });
        }

        requests.push({
          updateCells: {
            range: {
              sheetId: update.sheetId,
              startRowIndex: rangeInfo.startRow,
              endRowIndex: rangeInfo.startRow + updateRange.values.length,
              startColumnIndex: rangeInfo.startCol,
              endColumnIndex: rangeInfo.startCol + updateRange.values[0].length,
            },
            rows: rowData,
            fields: 'userEnteredValue',
          },
        });
      }

      // Execute as single atomic batch update
      if (requests.length > 0) {
        await NetworkUtils.fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${update.spreadsheetId}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              ...this.authHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ requests }),
          },
          this.defaultRequestConfig,
        );
      }
    }, context)();
  }

  /**
   * Convert row, column coordinates to A1 notation
   */
  private coordinatesToA1(row: number, col: number): string {
    const columnLetter = this.numberToColumnLetter(col);
    return `${columnLetter}${row + 1}`;
  }

  /**
   * Convert column number to letter (0 -> A, 1 -> B, etc.)
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

  /**
   * Parse A1 range notation into coordinates
   */
  private parseA1Range(range: string): {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } {
    // Simple implementation for ranges like "A1:C10"
    const [start, end] = range.split(':');
    const startCoords = this.a1ToCoordinates(start);
    const endCoords = end ? this.a1ToCoordinates(end) : startCoords;

    return {
      startRow: startCoords.row,
      startCol: startCoords.col,
      endRow: endCoords.row,
      endCol: endCoords.col,
    };
  }

  /**
   * Convert A1 notation to coordinates
   */
  private a1ToCoordinates(a1: string): { row: number; col: number } {
    const match = a1.match(/^([A-Z]+)(\d+)$/);
    if (!match) {
      throw new Error(`Invalid A1 notation: ${a1}`);
    }

    const [, letters, numbers] = match;
    const col = this.columnLetterToNumber(letters);
    const row = parseInt(numbers) - 1;

    return { row, col };
  }

  /**
   * Convert column letter to number (A -> 0, B -> 1, etc.)
   */
  private columnLetterToNumber(letters: string): number {
    let result = 0;
    for (let i = 0; i < letters.length; i++) {
      result = result * 26 + (letters.charCodeAt(i) - 64);
    }
    return result - 1;
  }
}
