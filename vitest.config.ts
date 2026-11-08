// No import alias is needed: this plugin's @deepseek-ai references are either
// type-only (erased at transpile time) or resolved by the shim `scripts/build.mjs`
// links into ./node_modules, so the suite runs against the TS sources with any
// vitest install — e.g. the DSH checkout's own
// `node_modules/.bin/vitest run --config vitest.config.ts`.
export default {
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
}
