/**
 * Direct unit tests for the pure audit classification and decoding helpers,
 * plus one integration pass over the directory walk.
 * @module dsh-agent-session-tools/error-audit
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { auditSessions, classifyErrorText, offenderOf, parseAuditArgs, decodeSessionLines } from '../src/error-audit.ts'

describe('classifyErrorText', () => {
  it('maps the recurring vocabulary to stable categories', () => {
    expect(classifyErrorText('Error: old_string was not found in "a.ts"')).toBe('edit-mismatch')
    expect(classifyErrorText('Error: cannot edit "a.ts": file changed since it was read')).toBe('edit-stale')
    expect(classifyErrorText('cannot modify "a.md": file has not been read')).toBe('edit-not-read')
    expect(classifyErrorText('code run failed (timeout): execution deadline reached (60000ms)')).toBe('timeout')
    expect(classifyErrorText('rg: D:\\x: IO error for operation on D:\\x')).toBe('search-bad-path')
    expect(classifyErrorText("Expected ',', got 'string literal'")).toBe('syntax')
    expect(classifyErrorText('web fetch failed: TypeError: fetch failed')).toBe('network')
    expect(classifyErrorText('invalid arguments: missing required property "file_path"')).toBe('bad-args')
    expect(classifyErrorText('ENOENT: no such file or directory')).toBe('enoent')
    expect(classifyErrorText('something entirely novel')).toBe('other')
  })

  it('prefers the first specific match over a generic one', () => {
    // A mismatch error that also contains a path IO error classifies as the
    // more actionable edit category.
    expect(classifyErrorText('old_string was not found in "x"; rg: y: IO error for operation on y')).toBe('edit-mismatch')
  })
})

describe('offenderOf', () => {
  it('extracts quoted edit targets and command heads', () => {
    expect(offenderOf('old_string was not found in "/home/dev/app/index.html"')).toBe('/home/dev/app/index.html')
    expect(offenderOf('cannot read "D:\\x\\log.txt": binary file')).toBe('D:\\x\\log.txt')
    expect(offenderOf('code run failed (timeout): execution deadline reached')).toBe('')
  })
})

describe('parseAuditArgs', () => {
  it('defaults and clamps', () => {
    expect(parseAuditArgs({})).toEqual({ sinceIso: undefined, cwdContains: undefined, top: 3 })
    expect(parseAuditArgs({ top: 99 }).top).toBe(5)
    expect(parseAuditArgs({ top: 0 }).top).toBe(1)
  })
  it('rejects a non-ISO since', () => {
    expect(() => parseAuditArgs({ since: 'not-a-date' })).toThrow(/ISO/)
  })
})

describe('decodeSessionLines', () => {
  it('returns empty for garbage bytes instead of throwing', async () => {
    expect(await decodeSessionLines(Buffer.from('not zstd at all'))).toEqual([])
    expect(await decodeSessionLines(Buffer.alloc(0))).toEqual([])
  })

  it('round-trips compressed frames into their lines', async () => {
    const compressed = zstdCompressSync(Buffer.from('first\nsecond\n'))
    expect(await decodeSessionLines(compressed)).toEqual(['first', 'second', ''])
  })
})

describe('auditSessions', () => {
  it('walks the workspace/session layout, skips a corrupt artifact, and renders the bounded summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ast-audit-'))
    try {
      const sessionDir = join(root, 'ws-1', 'session-abc')
      mkdirSync(sessionDir, { recursive: true })
      const log = [
        JSON.stringify({ type: 'session', cwd: '/demo' }),
        JSON.stringify({ type: 'tool/call', data: { callId: 'c1', name: 'edit' } }),
        JSON.stringify({
          type: 'tool/result',
          time: 1_000,
          data: { message: { isError: true, toolCallId: 'c1', content: [{ type: 'text', text: 'old_string was not found in "index.html"' }] } },
        }),
        JSON.stringify({ type: 'user/message' }),
      ].join('\n')
      writeFileSync(join(sessionDir, 'log.jsonl'), log)
      // A corrupt artifact is skipped, not fatal.
      writeFileSync(join(sessionDir, 'log.jsonl.zstd'), Buffer.from('garbage'))
      const summary = await auditSessions(root, parseAuditArgs({}))
      expect(summary).toContain('1 tool errors across 1 sessions with errors')
      expect(summary).toContain('edit-mismatch')
      expect(summary).toContain('/demo')
      expect(summary).toContain('edit → index.html')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('honours the since lower bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ast-audit-since-'))
    try {
      const sessionDir = join(root, 'ws-1', 'session-abc')
      mkdirSync(sessionDir, { recursive: true })
      const log = [
        JSON.stringify({ type: 'session', cwd: '/demo' }),
        JSON.stringify({
          type: 'tool/result',
          time: 5_000,
          data: { message: { isError: true, toolCallId: 'c1', content: [{ type: 'text', text: 'execution deadline reached' }] } },
        }),
      ].join('\n')
      writeFileSync(join(sessionDir, 'log.jsonl'), log)
      const late = parseAuditArgs({ since: '1970-01-01T00:00:10.000Z' })
      expect(await auditSessions(root, late)).toContain('0 tool errors across 0 sessions with errors')
      const early = parseAuditArgs({ since: '1970-01-01T00:00:01.000Z' })
      expect(await auditSessions(root, early)).toContain('1 tool errors across 1 sessions with errors')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
