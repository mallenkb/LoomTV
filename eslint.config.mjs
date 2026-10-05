// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// A synchronous child process freezes the Electron main thread (and the
// in-process canonical server) for as long as the command runs. Use the async
// forms. Quit-time cleanup that genuinely must block can opt out on one line
// with a comment saying why.
const SYNC_CHILD_PROCESS = ['execFileSync', 'execSync', 'spawnSync'];
const SYNC_CHILD_PROCESS_MESSAGE = 'Synchronous child processes block the main thread; use the async form.';
const noSyncChildProcess = {
  'no-restricted-imports': ['error', {
    paths: ['child_process', 'node:child_process'].map((name) => ({
      name,
      importNames: SYNC_CHILD_PROCESS,
      message: SYNC_CHILD_PROCESS_MESSAGE,
    })),
  }],
  'no-restricted-syntax': ['error', {
    selector: `MemberExpression[property.name=/^(${SYNC_CHILD_PROCESS.join('|')})$/]`,
    message: SYNC_CHILD_PROCESS_MESSAGE,
  }],
};

export default defineConfig([
  {
    ignores: [
      '**/.vite/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      '**/.expo/**',
      '**/android/**',
      '**/ios/**',
      '**/Pods/**',
      '**/release-evidence/**',
      '**/target/**',
    ],
  },
  {
    basePath: 'apps/desktop',
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    settings: {
      'import-x/core-modules': ['electron'],
      'import-x/resolver': {
        node: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
        typescript: { project: 'apps/desktop/tsconfig.json' },
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-function': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    basePath: 'packages',
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: { sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    basePath: 'packages',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { sourceType: 'module' },
    },
  },
  {
    basePath: 'apps/server',
    files: ['src/**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { sourceType: 'module' },
    },
  },
  {
    basePath: 'apps/desktop',
    files: ['src/main.ts', 'src/main/**/*.ts'],
    rules: noSyncChildProcess,
  },
  {
    // The canonical server and capability probes also run inside the desktop
    // main process.
    files: ['apps/server/src/**/*.{js,mjs,cjs}', 'packages/transcode-capabilities/src/**/*.{js,mjs,cjs}'],
    rules: noSyncChildProcess,
  },
  {
    basePath: 'apps/tv',
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    basePath: 'scripts',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { sourceType: 'module' },
    },
  },
  {
    basePath: 'apps/mobile',
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        __DEV__: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]);
