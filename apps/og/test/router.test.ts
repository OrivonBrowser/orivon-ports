import { describe, expect, it } from 'vitest'
import { manageHash, nameHash, parseRoute, ROUTES } from '../site/router.js'

describe('the router', () => {
  it('opens the search for the start and for an empty fragment', () => {
    expect(parseRoute('')).toEqual({ name: 'search', hash: '', label: null })
    expect(parseRoute('#/')).toEqual({ name: 'search', hash: '#/', label: null })
  })
  it('opens the search with a name typed for a name link', () => {
    expect(parseRoute('#/name/harbor')).toMatchObject({ name: 'search', label: 'harbor' })
    expect(parseRoute(nameHash('hello world'))).toMatchObject({ name: 'search', label: 'hello world' })
  })
  it('opens the list of names, and the page of one of them', () => {
    expect(parseRoute('#/names')).toEqual({ name: 'names', hash: '#/names', label: null })
    expect(parseRoute('#/names/harbor')).toMatchObject({ name: 'manage', label: 'harbor' })
    expect(parseRoute(manageHash('日本語'))).toMatchObject({ name: 'manage', label: '日本語' })
    expect(parseRoute('#/names?x=1')).toMatchObject({ name: 'names' })
  })
  it('names the two pages of the bar, and no other', () => {
    expect(ROUTES.map((route) => route.path)).toEqual(['/', '/names'])
  })
  it('does not know any other page, and does not throw on a fragment that does not decode', () => {
    expect(parseRoute('#/other').name).toBe('notFound')
    expect(parseRoute('#/name/a/b').name).toBe('notFound')
    expect(parseRoute('#/names/a/b').name).toBe('notFound')
    expect(parseRoute('#/name/%E0%A4%A').name).toBe('notFound')
    expect(parseRoute('#/names/%E0%A4%A').name).toBe('notFound')
    expect(parseRoute(undefined as never).name).toBe('search')
  })
})
