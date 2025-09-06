/**
 * Utility functions for Google Sheets sync and storage format decisions
 */

import { SheetAnalysis, SheetData } from '../drive/SheetAPI.js';

export interface SheetStorageSettings {
  maxRowsForMarkdown: number;
  maxRowsForCSVY: number;
  preferredFormat: 'auto' | 'markdown' | 'csv' | 'csvy' | 'base';
  preserveFormulas: boolean;
  formulaDisplay: 'value' | 'formula' | 'both';
}

export interface CSVYData {
  frontmatter: CSVYFrontmatter;
  csvContent: string;
}

export interface CSVYFrontmatter {
  docId: string;
  type: 'google-sheet';
  spreadsheetId: string;
  sheetName: string;
  lastSync: string;
  dimensions: {
    rows: number;
    columns: number;
  };
  formulas?: Array<{
    cell: string;
    formula: string;
    preserveOnly: boolean;
  }>;
  skipColumns?: string[];
  warnings?: string[];
}

export class SheetStorageEngine {
  private settings: SheetStorageSettings;

  constructor(settings: SheetStorageSettings) {
    this.settings = settings;
  }

  /**
   * Determine the best storage format for a sheet
   */
  determineStorageFormat(analysis: SheetAnalysis): 'markdown' | 'csv' | 'csvy' | 'base' {
    // User preference override
    if (this.settings.preferredFormat !== 'auto') {
      return this.settings.preferredFormat;
    }

    const { dimensions, hasFormulas, complexity } = analysis;

    // Small simple tables without formulas -> Markdown table
    if (
      dimensions.rows <= this.settings.maxRowsForMarkdown &&
      dimensions.cols <= 10 &&
      !hasFormulas &&
      complexity === 'simple'
    ) {
      return 'markdown';
    }

    // Medium tables or those with formulas -> CSVY
    if (
      dimensions.rows <= this.settings.maxRowsForCSVY &&
      (hasFormulas || complexity === 'medium')
    ) {
      return 'csvy';
    }

    // Large complex sheets with formulas that might benefit from Obsidian Bases
    if (hasFormulas && dimensions.rows < 1000 && complexity === 'complex') {
      return 'base';
    }

    // Default to CSV for large datasets
    return 'csv';
  }

  /**
   * Convert sheet data to CSVY format
   */
  convertToCSVY(
    sheetData: SheetData,
    spreadsheetId: string,
    sheetName: string = 'Sheet1',
  ): CSVYData {
    const formulas = sheetData.formulas.map((f) => ({
      cell: f.cell,
      formula: f.formula,
      preserveOnly: true,
    }));

    const skipColumns = this.extractFormulaColumns(sheetData.formulas);

    const warnings = [];
    if (formulas.length > 0) {
      warnings.push(
        `${formulas.length} formulas detected - values shown, formulas preserved on Google Sheets`,
      );
    }
    if (skipColumns.length > 0) {
      warnings.push(`Columns ${skipColumns.join(', ')} contain formulas and are not synced`);
    }

    const frontmatter: CSVYFrontmatter = {
      docId: spreadsheetId,
      type: 'google-sheet',
      spreadsheetId,
      sheetName,
      lastSync: new Date().toISOString(),
      dimensions: {
        rows: sheetData.values.length,
        columns: Math.max(...sheetData.values.map((row) => row.length)),
      },
      formulas: formulas.length > 0 ? formulas : undefined,
      skipColumns: skipColumns.length > 0 ? skipColumns : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    const csvContent = this.arrayToCSV(sheetData.values);

    return {
      frontmatter,
      csvContent,
    };
  }

  /**
   * Convert sheet data to markdown table
   */
  convertToMarkdownTable(sheetData: SheetData): string {
    if (sheetData.values.length === 0) {
      return '';
    }

    const headers = sheetData.values[0] || [];
    const rows = sheetData.values.slice(1);

    // Build markdown table
    let markdown = '| ' + headers.map((h) => String(h || '')).join(' | ') + ' |\n';
    markdown += '|' + headers.map(() => '---').join('|') + '|\n';

    for (const row of rows) {
      const paddedRow = [];
      for (let i = 0; i < headers.length; i++) {
        paddedRow.push(String(row[i] || ''));
      }
      markdown += '| ' + paddedRow.join(' | ') + ' |\n';
    }

    return markdown;
  }

  /**
   * Generate CSVY content with YAML frontmatter
   */
  generateCSVYContent(data: CSVYData): string {
    const yamlFrontmatter = this.objectToYAML(data.frontmatter);

    return `---\n${yamlFrontmatter}---\n${data.csvContent}`;
  }

  /**
   * Parse CSVY content back into components
   */
  parseCSVYContent(content: string): CSVYData {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!frontmatterMatch) {
      throw new Error('Invalid CSVY format: missing YAML frontmatter');
    }

    const [, yamlContent, csvContent] = frontmatterMatch;
    const frontmatter = this.yamlToObject(yamlContent) as CSVYFrontmatter;

    return {
      frontmatter,
      csvContent: csvContent.trim(),
    };
  }

  /**
   * Extract columns that contain formulas
   */
  private extractFormulaColumns(formulas: Array<{ cell: string }>): string[] {
    const formulaColumns = new Set<string>();

    for (const formula of formulas) {
      const match = formula.cell.match(/^([A-Z]+)\d+$/);
      if (match) {
        formulaColumns.add(match[1]);
      }
    }

    return Array.from(formulaColumns).sort();
  }

  /**
   * Convert 2D array to CSV string
   */
  arrayToCSV(data: any[][]): string {
    return data
      .map((row) =>
        row
          .map((cell) => {
            const value = String(cell || '');
            // Escape CSV values containing commas, quotes, or newlines
            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
              return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          })
          .join(','),
      )
      .join('\n');
  }

  /**
   * Simple YAML serialization for frontmatter
   */
  objectToYAML(obj: any): string {
    const lines = [];

    for (const [key, value] of Object.entries(obj || {})) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        lines.push(`${key}:`);
        for (const item of value) {
          if (typeof item === 'object') {
            lines.push(`  - ${this.objectToYAMLInline(item)}`);
          } else {
            lines.push(`  - ${this.escapeYAMLValue(item)}`);
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${key}:`);
        for (const [subKey, subValue] of Object.entries(value)) {
          lines.push(`  ${subKey}: ${this.escapeYAMLValue(subValue)}`);
        }
      } else {
        lines.push(`${key}: ${this.escapeYAMLValue(value)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Simple inline YAML object serialization
   */
  private objectToYAMLInline(obj: any): string {
    const parts = [];
    for (const [key, value] of Object.entries(obj || {})) {
      parts.push(`${key}: ${this.escapeYAMLValue(value)}`);
    }
    return `{ ${parts.join(', ')} }`;
  }

  /**
   * Escape YAML values
   */
  private escapeYAMLValue(value: any): string {
    if (typeof value === 'string') {
      // Quote strings that might be ambiguous
      if (value.includes(':') || value.includes('\\n') || value.includes('"')) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }
    return String(value);
  }

  /**
   * Simple YAML parser for frontmatter
   */
  yamlToObject(yaml: string): any {
    // This is a simplified YAML parser for our specific use case
    // In a production environment, you'd want to use a proper YAML library
    const result: any = {};
    const lines = yaml.split('\n');
    let currentKey = '';
    let currentArray: any[] = [];
    let inArray = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('-')) {
        // Array item
        const value = trimmed.substring(1).trim();
        currentArray.push(this.parseYAMLValue(value));
      } else if (trimmed.includes(':')) {
        // Save previous array if we were building one
        if (inArray && currentKey) {
          result[currentKey] = currentArray;
          currentArray = [];
          inArray = false;
        }

        const [key, ...valueParts] = trimmed.split(':');
        const value = valueParts.join(':').trim();

        if (!value) {
          // Start of array or object
          currentKey = key.trim();
          inArray = true;
        } else {
          result[key.trim()] = this.parseYAMLValue(value);
        }
      }
    }

    // Save final array
    if (inArray && currentKey) {
      result[currentKey] = currentArray;
    }

    return result;
  }

  /**
   * Parse individual YAML values
   */
  private parseYAMLValue(value: string): any {
    const trimmed = value.trim();

    // Remove quotes
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    // Parse numbers
    if (!isNaN(Number(trimmed))) {
      return Number(trimmed);
    }

    // Parse booleans
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    return trimmed;
  }
}
