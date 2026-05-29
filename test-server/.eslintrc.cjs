/**
 * Local override so the parent's typed-linting setup ignores this folder.
 * The repository's root .eslintrc is configured with a parserOptions.project
 * pointing to the parent tsconfig.json which (intentionally) does not include
 * test-server files.
 */
module.exports = {
	root: true,
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 2020,
		sourceType: 'module',
		project: null
	},
	plugins: ['@typescript-eslint'],
	env: { node: true, jest: true },
	rules: {}
}
