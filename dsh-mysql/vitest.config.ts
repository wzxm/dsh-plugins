import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Testing Library's automatic cleanup is installed by its `afterEach` hook
    // only when the test framework exposes globals. Without it, components
    // mounted by an earlier test stay in the document and every role query
    // returns their nodes too — which silently turns "one switch per row" into
    // "one switch per row, per test already run".
    globals: true,
  },
})
