import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { carriedEffort, checkedCwd, checkedEffort, describeFailure, hasText, lookupRetry, ownerWorkspace, promptRequestId, providerOfModel, rememberRetry, retryLedgerLimit, retryWindowMs, type RetryRecord } from '../src/checks.ts'

describe('ownerWorkspace', () => {
  const workspaces = [
    { id: 'ws-a', title: 'A', path: '/a', sessionIds: ['session-1', 'session-2'] },
    { id: 'ws-b', title: 'B', path: '/b', sessionIds: ['session-3'] },
  ]

  it('finds the Workspace that accounts the session', () => {
    expect(ownerWorkspace(workspaces, 'session-3')?.id).toBe('ws-b')
  })

  it('answers undefined when the call carries no session', () => {
    expect(ownerWorkspace(workspaces, undefined)).toBeUndefined()
  })

  it('answers undefined for a session no Workspace owns', () => {
    expect(ownerWorkspace(workspaces, 'session-loose')).toBeUndefined()
  })
})

/** A catalog with one visible group per entry and nothing failed. */
function catalogOf(groups: { id: string; models: { id: string; reasoning?: { efforts: { id: string }[]; defaultEffort?: string } }[] }[]): ModelCatalog {
  return {
    default: { provider: groups[0]?.id ?? 'p', model: groups[0]?.models[0]?.id ?? 'm' },
    routableProviders: groups.map(group => group.id),
    groups,
    failures: [],
  } as unknown as ModelCatalog
}

describe('retry ledger', () => {
  it('returns the remembered receipt for the same key and text inside the window', () => {
    const ledger = new Map<string, RetryRecord<number>>()
    rememberRetry(ledger, 'k1', { message: 'a', receipt: 7, at: 1000 })
    expect(lookupRetry(ledger, 'k1', 'a', 1000 + retryWindowMs - 1)?.receipt).toBe(7)
  })

  it('forgets a key once the window has passed, and prunes it on the way', () => {
    const ledger = new Map<string, RetryRecord<number>>()
    rememberRetry(ledger, 'k1', { message: 'a', receipt: 7, at: 0 })
    expect(lookupRetry(ledger, 'k1', 'a', retryWindowMs + 1)).toBeUndefined()
    expect(ledger.size).toBe(0)
  })

  it('refuses a reused key that carries different text', () => {
    const ledger = new Map<string, RetryRecord<number>>()
    rememberRetry(ledger, 'k1', { message: 'a', receipt: 7, at: 0 })
    expect(() => lookupRetry(ledger, 'k1', 'b', 10)).toThrow(/already used for different text/)
  })

  it('keeps the ledger inside its size bound', () => {
    const ledger = new Map<string, RetryRecord<number>>()
    for (let index = 0; index < retryLedgerLimit + 25; index += 1) {
      rememberRetry(ledger, `k${index}`, { message: 'x', receipt: index, at: 0 })
    }
    expect(ledger.size).toBe(retryLedgerLimit)
  })
})

describe('promptRequestId', () => {
  it('keys an omitted requestId by the tool call, so a re-dispatch dedups', () => {
    expect(promptRequestId(undefined, 'call-7')).toBe('agent-tools:call-7')
  })

  it('falls back to a fresh uuid when the execution carries no call id', () => {
    const first = promptRequestId(undefined, undefined)
    const second = promptRequestId(undefined, undefined)
    expect(first).toMatch(/^agent-tools:[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })

  it('namespaces a supplied key, and takes its own key back verbatim', () => {
    expect(promptRequestId('retry-1', 'call-7')).toBe('agent-tools:retry-1')
    expect(promptRequestId('agent-tools:retry-1', 'call-8')).toBe('agent-tools:retry-1')
  })

  it('refuses tokens that are not usable as an idempotency key', () => {
    expect(() => promptRequestId('two words', 'call-7')).toThrow(/4-150 characters/)
    expect(() => promptRequestId('ab', 'call-7')).toThrow(/4-150 characters/)
    expect(() => promptRequestId('agent-tools:x', 'call-7')).toThrow(/agent-tools: plus 4-150/)
  })
})

describe('hasText', () => {
  it('accepts any non-whitespace text', () => {
    expect(hasText('a')).toBe(true)
    expect(hasText('  中文  ')).toBe(true)
  })

  it('rejects empty and whitespace-only messages', () => {
    expect(hasText('')).toBe(false)
    expect(hasText(' \n\t ')).toBe(false)
  })
})

describe('describeFailure', () => {
  it('keeps the Host error code where the model can act on it', () => {
    const error = Object.assign(new Error('session "session-x" not found'), { code: 'session/not-found' })
    expect(describeFailure('session_inject', error).message)
      .toBe('session_inject: session "session-x" not found (session/not-found)')
  })

  it('handles a value that is not an Error', () => {
    expect(describeFailure('session_create', 'boom').message).toBe('session_create: boom')
  })
})

describe('checkedCwd', () => {  let scratch = ''
  let inside = ''

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ast-checks-'))
    inside = join(scratch, 'workspace')
    mkdirSync(inside)
    writeFileSync(join(scratch, 'a-file'), '')
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('rejects a relative path without guessing a base directory', () => {
    expect(() => checkedCwd('./relative-dir')).toThrow(/must be an absolute directory/)
  })

  it('accepts an existing absolute directory and returns it unchanged', () => {
    expect(checkedCwd(inside)).toBe(inside)
  })

  it('names the missing directory instead of creating one', () => {
    expect(() => checkedCwd(join(scratch, 'nope'))).toThrow(/is not accessible/)
  })

  it('refuses a file that is not a directory', () => {
    expect(() => checkedCwd(join(scratch, 'a-file'))).toThrow(/is not a directory/)
  })
})

describe('providerOfModel', () => {
  const catalog = catalogOf([
    { id: 'prov-a', models: [{ id: 'm1' }] },
    { id: 'prov-b', models: [{ id: 'm2' }] },
  ])

  it('resolves a catalog-unique model id to its provider', () => {
    expect(providerOfModel('m1', catalog)).toBe('prov-a')
    expect(providerOfModel('m2', catalog)).toBe('prov-b')
  })

  it('refuses an id no visible group lists, naming the providers that failed to load', () => {
    const broken: ModelCatalog = { ...catalog, failures: [{ id: 'prov-c', name: 'C', message: 'offline' }] } as ModelCatalog
    expect(() => providerOfModel('m9', broken)).toThrow(/not listed in the Host model catalog.*prov-c/)
  })

  it('refuses an id several providers offer instead of guessing a route', () => {
    const shared = catalogOf([
      { id: 'prov-a', models: [{ id: 'm1' }] },
      { id: 'prov-b', models: [{ id: 'm1' }] },
    ])
    expect(() => providerOfModel('m1', shared)).toThrow(/several providers \(prov-a, prov-b\)/)
  })
})

describe('checkedEffort', () => {
  const catalog = catalogOf([
    { id: 'prov-a', models: [{ id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] },
    { id: 'prov-b', models: [{ id: 'm2' }] },
  ])

  it('keeps an effort the visible catalog offers', () => {
    expect(checkedEffort('high', 'prov-a', 'm1', catalog)).toBe('high')
  })

  it('refuses an effort the visible catalog does not offer, listing what is', () => {
    expect(() => checkedEffort('medium', 'prov-a', 'm1', catalog)).toThrow(/not offered for prov-a\/m1 \(offered: low, high\)/)
  })

  it('passes an effort through when the route has no visible effort list', () => {
    expect(checkedEffort('anything', 'prov-b', 'm2', catalog)).toBe('anything')
    expect(checkedEffort('anything', 'prov-z', 'm9', catalog)).toBe('anything')
  })
})

describe('carriedEffort', () => {
  const catalog = catalogOf([
    { id: 'prov-a', models: [
      { id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
      { id: 'm2', reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } },
    ] },
  ])

  it('carries no effort when the current session chose none', () => {
    expect(carriedEffort(undefined, 'prov-a', 'm2', catalog)).toBeUndefined()
  })

  it('carries the effort onto a route whose visible list offers it', () => {
    expect(carriedEffort('high', 'prov-a', 'm1', catalog)).toBe('high')
  })

  it('degrades to the new route\'s default effort when it does not offer the inherited one', () => {
    expect(carriedEffort('high', 'prov-a', 'm2', catalog)).toBe('low')
  })

  it('carries the effort as-is when the new route has no visible effort list', () => {
    expect(carriedEffort('high', 'prov-b', 'm9', catalog)).toBe('high')
  })
})
