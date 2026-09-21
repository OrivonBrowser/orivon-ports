import { defineConfig } from 'vitest/config'

// `apps/**` is in the include list, and that is the point of it being here.
//
// A bridge's unit tests live next to the bridge, under `apps/<app>/bridge/`,
// because a bridge cannot be shared between apps and neither can its tests.
// An include list of `src/**` alone does not reach them, and naming the file
// on the command line does not rescue it: vitest filters INSIDE its include
// pattern rather than widening it, so `vitest run apps/x/bridge/y.test.ts`
// silently matches nothing and exits 0.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist']
  }
})
