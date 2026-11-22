import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const HEX_COLOUR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  reactHooks.configs.flat['recommended-latest'],
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': true, 'ts-nocheck': true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
    },
  },
  {
    files: ['src/**/*.tsx'],
    rules: {
      // DD 5: no raw colour in a component. motion.md rules 7 and 8: no transition of the focus outline.
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${HEX_COLOUR}]`,
          message: 'Use a colour token from apps/web/app/tokens.css, never a raw hex value (DD 5).',
        },
        {
          selector: `TemplateElement[value.raw=${HEX_COLOUR}]`,
          message: 'Use a colour token from apps/web/app/tokens.css, never a raw hex value (DD 5).',
        },
        {
          selector:
            'Literal[value=/(^|\\s)(transition|transition-all|transition-colors|transition-shadow)(\\s|$)/]',
          message: 'Use the M-01 transition list; these animate the focus outline (motion.md rule 8).',
        },
        {
          selector: 'Literal[value=/(^|\\s)animate-/]',
          message: 'Recover has no keyframe animation (recover.md "Shell", Motion row).',
        },
      ],
    },
  },
);
