import { describe, expect, it } from 'vitest'
import { isAllowedAppFile } from './app-files.ts'

describe('isAllowedAppFile', () => {
  it('allows the files a port consists of', () => {
    for (const path of ['apps/x/recipe.json', 'apps/x/orivon.json', 'apps/x/bridge/x.js', 'apps/x/bridge/members.json', 'apps/x/webpack.orivon.config.cjs']) {
      expect(isAllowedAppFile(path, [])).toBe(true)
    }
  })

  it('refuses anything else in a port', () => {
    for (const path of ['apps/x/src/main.js', 'apps/x/dist/index.html', 'apps/x/patch.diff']) {
      expect(isAllowedAppFile(path, [])).toBe(false)
    }
  })

  it('allows hand-written text files inside a declared site, nested or not', () => {
    for (const path of ['apps/x/site/index.html', 'apps/x/site/app.css', 'apps/x/site/js/app.js', 'apps/x/site/logo.svg']) {
      expect(isAllowedAppFile(path, ['apps/x/site'])).toBe(true)
    }
  })

  // A font or an image under a site is somebody else's work in a directory
  // that is otherwise ours -- the one shape the site allowance must not open.
  it('refuses binary assets even inside a declared site', () => {
    for (const path of ['apps/x/site/font.woff2', 'apps/x/site/shot.png', 'apps/x/site/app.wasm']) {
      expect(isAllowedAppFile(path, ['apps/x/site'])).toBe(false)
    }
  })

  // The site is matched as a directory, so neither a sibling that shares its
  // prefix nor another app's directory rides on the declaration.
  it('allows a site only for the app and directory that declare it', () => {
    expect(isAllowedAppFile('apps/x/site-old/index.html', ['apps/x/site'])).toBe(false)
    expect(isAllowedAppFile('apps/y/site/index.html', ['apps/x/site'])).toBe(false)
    expect(isAllowedAppFile('apps/x/index.html', ['apps/x/site'])).toBe(false)
  })

  it('treats a trailing slash on the declared directory the same', () => {
    expect(isAllowedAppFile('apps/x/site/index.html', ['apps/x/site/'])).toBe(true)
  })

  // A port whose upstream is a Node server has no site/: the page that starts
  // the server is ours, and lives beside the recipe.
  it('allows a port\'s launcher files, and their unit tests, and nothing else in it', () => {
    for (const path of ['apps/x/launcher/index.html', 'apps/x/launcher/launcher.css', 'apps/x/launcher/launcher.js', 'apps/x/launcher/plan.js', 'apps/x/launcher/plan.test.ts', 'apps/x/launcher/logo.svg']) {
      expect(isAllowedAppFile(path, [])).toBe(true)
    }
    for (const path of ['apps/x/launcher/x.png', 'apps/x/launcher/font.woff2', 'apps/x/launcher/app.wasm', 'apps/x/launcher/sub/plan.js', 'apps/x/launcher/plan.ts', 'apps/x/launcher.js', 'apps/x/launchers/plan.js']) {
      expect(isAllowedAppFile(path, [])).toBe(false)
    }
  })
})
