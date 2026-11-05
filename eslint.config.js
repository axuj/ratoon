import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
    typescript: true,
    formatters: false,
    ignores: ['node_modules/', 'coverage/'],
  },
  {
    name: 'custom/ratoon',
    rules: {
      'no-console': 'off',
      'node/prefer-global/process': 'off',
      'test/prefer-lowercase-title': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    name: 'custom/ratoon-tests',
    rules: {
      'ts/no-explicit-any': 'off',
      'eslint-comments/no-unlimited-disable': 'off',
    },
  },
)
