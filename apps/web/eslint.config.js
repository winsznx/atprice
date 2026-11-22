import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const HEX_COLOUR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

export default tseslint.config(
  { ignores: ['.next/**', 'next-env.d.ts', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  nextPlugin.configs['core-web-vitals'],
  reactHooks.configs.flat['recommended-latest'],
  {
    settings: { next: { rootDir: import.meta.dirname } },
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
    files: ['**/*.tsx'],
    rules: {
      // DD 5: no raw colour in a component; DD 7.10 / motion.md M-04e: only toast.custom and toast.dismiss.
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${HEX_COLOUR}]`,
          message: 'Use a colour token from app/tokens.css, never a raw hex value (DD 5).',
        },
        {
          selector: `TemplateElement[value.raw=${HEX_COLOUR}]`,
          message: 'Use a colour token from app/tokens.css, never a raw hex value (DD 5).',
        },
        {
          selector:
            "MemberExpression[object.name='toast'][property.name=/^(success|error|info|warning|message|loading|promise)$/]",
          message: 'Every toast is toast.custom() with <Notice> (DD 7.10, motion.md M-04e).',
        },
        {
          selector: "CallExpression[callee.name='toast']",
          message: 'Every toast is toast.custom() with <Notice> (DD 7.10, motion.md M-04e).',
        },
        {
          selector:
            "JSXOpeningElement[name.name='Toaster'] > JSXAttribute[name.name=/^(closeButton|toastOptions|richColors)$/]",
          message: 'Sonner styled options carry their own transitions (motion.md M-04e).',
        },
        {
          selector:
            'Literal[value=/(^|\\s)(transition|transition-all|transition-colors|transition-shadow)(\\s|$)/]',
          message: 'Use the M-01 transition list; these animate the focus outline (motion.md rule 8).',
        },
        {
          selector: 'Literal[value=/transition-\\[[^\\]]*(outline|box-shadow|shadow)[^\\]]*\\]/]',
          message: 'Never transition outline or box-shadow (motion.md rule 7).',
        },
      ],
    },
  },
);
