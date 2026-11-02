// ESLint for the dashboard: only what tsc does not check, React's rules of hooks. Types are
// tsc's job and formatting Prettier's.
//
// typescript-eslint does not support TypeScript 7 yet, so this package has TypeScript 6 of its
// own, used only to parse (no type information). Move it to the repository's TypeScript once
// typescript-eslint supports 7.
import nextPlugin from '@next/eslint-plugin-next'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: ['.next/**', '.open-next/**', '.wrangler/**', 'public/**', 'next-env.d.ts'],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    // Next's plugin is loaded for its rule that eslint-disable comments in the code name.
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@next/next/no-img-element': 'error',
    },
  },
]
