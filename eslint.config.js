import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['build/', 'out/', 'node_modules/'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                // GJS 1.88 ships a newer SpiderMonkey than ecmaVersion 2024 knows about.
                ...globals.builtin,
                global: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                console: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
];
