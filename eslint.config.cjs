// Flat config for ESLint v9+
const js = require('@eslint/js');
const importPlugin = require('eslint-plugin-import');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      '.crush',
      '.idea',
      'scripts/**/*.js',
      'main.js',
      'test-runner.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
      globals: { ...globals.node, ...globals.browser, Bun: 'readonly' },
    },
    plugins: { import: importPlugin, '@typescript-eslint': tsPlugin },
    rules: {
      'no-console': 'off',
      'no-case-declarations': 'off',
      'no-useless-escape': 'off',
      'no-unused-vars': 'off',
      'import/order': [
        'error',
        { 'newlines-between': 'always', alphabetize: { order: 'asc', caseInsensitive: true } },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: ['**/*.test.ts', 'test/**'] },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettier,
];
