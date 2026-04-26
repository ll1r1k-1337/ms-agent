import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      // Allow chai-style expect assertions in tests
      '@typescript-eslint/no-unused-expressions': 'off',
      // Allow empty catch blocks for now (existing code has many)
      'no-empty': 'warn',
      // Allow empty interfaces (existing code uses them)
      '@typescript-eslint/no-empty-object-type': 'off',
      // Allow require() in tests
      '@typescript-eslint/no-require-imports': 'off',
      // Allow let for variables that are initialized later (closure patterns)
      'prefer-const': 'off',
    },
  },
  {
    ignores: ['out/', 'node_modules/', '.vscode-test/'],
  }
);
