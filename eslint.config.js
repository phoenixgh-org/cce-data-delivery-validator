import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // design_handoff_*: vendored design-reference bundle (prototype HTML/JSX/JS),
    // not project source — linted nowhere, recreated in src/web instead.
    ignores: ['dist/', 'node_modules/', 'design_handoff_validator_redesign/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    // Build/tooling scripts run in Node (not bundled), so expose Node globals.
    files: ['scripts/**/*.mjs', 'eslint.config.js', 'vite.config.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    // The React SPA (src/web) runs in the browser, bundled by Vite — expose
    // browser globals so `eslint .` lints the .ts/.tsx cleanly.
    files: ['src/web/**/*.{ts,tsx}'],
    rules: {
      // Stub components (filled in by parallel agents B/C/D/E) accept their
      // contract props but don't use them yet; allow `_`-prefixed unused args.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
      },
    },
  },
);
