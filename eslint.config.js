import neostandard from 'neostandard'

export default [
  ...neostandard({ ignores: ['node_modules/**', 'coverage/**'] }),
  {
    rules: {
      // Library code logs through the pluggable logger; stdout/stderr writes are explicit.
      'no-console': 'error',
    },
  },
]
