import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

// Flat config for the Vite + Svelte + TypeScript app. Indentation (tabs) is
// enforced by .editorconfig rather than ESLint; the core `indent` rule is
// unreliable on TypeScript and Svelte syntax.
//
// Type-aware linting is enabled (recommendedTypeChecked + the project
// service), so rules like no-floating-promises / no-misused-promises can see
// real types. The .svelte files are in the app tsconfig, so they are typed
// too. The root tooling files (eslint/svelte/vite config) live outside that
// tsconfig, so the trailing block turns type-aware linting back off for them.
export default ts.config(
	{
		ignores: [
			'dist/',
			'node_modules/',
			'public/',
			'cmd/',
			'local/',
			'tests/fixtures/',
			// The generated Capacitor Android project (Gradle + Java + the
			// cap-sync copy of dist/): nothing lintable lives there.
			'android/',
			// wrangler dev's scratch: a bundled copy of the worker plus its
			// own generated facade, which fails the repo's style rules and
			// is not ours to fix. Gitignored, but eslint reads the tree.
			'notam-proxy/.wrangler/',
			'account-api/.wrangler/',
		],
	},
	js.configs.recommended,
	ts.configs.recommendedTypeChecked,
	svelte.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				tsconfigRootDir: import.meta.dirname,
			},
			globals: {
				...globals.browser,
				// Build-time constants injected by Vite `define` in
				// vite.config.ts; declared in src/types/build.d.ts.
				__APP_VERSION__: 'readonly',
				__APP_SHA__: 'readonly',
			},
		},
		rules: {
			'linebreak-style': ['error', 'unix'],
			'quotes': ['error', 'single', { avoidEscape: true }],
			'semi': ['error', 'always'],
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			// Svelte event attributes (onclick={async () => ...}) legitimately
			// take an async handler whose returned promise is discarded; only
			// guard against passing a promise where a plain void callback or a
			// conditional is expected.
			'@typescript-eslint/no-misused-promises': [
				'error',
				{ checksVoidReturn: { attributes: false } },
			],
			// Interpolating a number into a template literal is intentional and
			// readable here (coordinates, counts, altitudes, frequencies).
			'@typescript-eslint/restrict-template-expressions': [
				'error',
				{ allowNumber: true },
			],
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				svelteConfig,
			},
		},
		rules: {
			// Surface Svelte compiler warnings (accessibility, unused CSS,
			// ...) as lint errors so they fail CI. svelte-check reports
			// them but exits 0 on warnings, so nothing enforced them.
			'svelte/valid-compile': 'error',
			// Zero {@html} sites is a pinned security posture: the bearer
			// token in localStorage raises what an injection is worth, and
			// GitHub Pages can send no CSP header (docs/accounts-sync.md).
			'svelte/no-at-html-tags': 'error',
		},
	},
	{
		// The repo scripts (i18n lint) run under node, outside the browser
		// globals the app block declares.
		files: ['scripts/**/*.js'],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		// The root tooling files (eslint.config.js, svelte.config.js) and
		// the repo scripts are not part of the app tsconfig; lint them
		// without type information so the project service doesn't reject
		// them. vite.config.ts IS in the tsconfig (svelte-check gates it),
		// so it keeps type-aware linting.
		files: ['**/*.js'],
		...ts.configs.disableTypeChecked,
	},
);
