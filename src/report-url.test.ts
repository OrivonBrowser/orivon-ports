import { describe, expect, it } from 'vitest'
import { portProblemUrl, reportName, withSupport } from './report-url.ts'

describe('portProblemUrl', () => {
  it('opens the port-problem form with the app and a title filled in', () => {
    expect(portProblemUrl('The Lounge')).toBe(
      'https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=The%20Lounge&title=Problem%20with%20the%20Orivon%20community%20build%20of%20The%20Lounge')
  })

  it('encodes a name that would otherwise end the query', () => {
    const url = new URL(portProblemUrl('A&B #1'))
    expect(url.searchParams.get('app')).toBe('A&B #1')
    expect(url.hash).toBe('')
  })
})

describe('reportName', () => {
  it('is the hint name, else the recipe name', () => {
    expect(reportName({ name: 'Own name' })).toBe('Own name')
    expect(reportName({ name: 'Own name', hint: { tier: 1, name: 'Upstream name' } })).toBe('Upstream name')
  })
})

describe('withSupport', () => {
  it('adds support.issues, the form address, and keeps every other key', () => {
    const out = JSON.parse(withSupport('{"id":"demo","entry":"index.html"}', 'Demo')) as Record<string, unknown>
    expect(out).toEqual({ id: 'demo', entry: 'index.html', support: { issues: portProblemUrl('Demo') } })
  })

  it('keeps a support the manifest already names', () => {
    const text = '{"id":"demo","support":{"issues":"https://example.com/issues"}}'
    expect(withSupport(text, 'Demo')).toBe(text)
  })

  it('returns text that is not a JSON object as it is', () => {
    for (const text of ['not json', '[]', 'null', '"x"']) expect(withSupport(text, 'Demo')).toBe(text)
  })
})
