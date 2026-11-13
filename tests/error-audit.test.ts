/**
 * Direct unit tests for the pure audit classification and decoding helpers.
 * @module dsh-agent-session-tools/error-audit
 */

import { describe, expect, it } from 'vitest'
import { classifyErrorText, offenderOf, parseAuditArgs, decodeSessionLines } from '../src/error-audit.ts'

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
    expect(offenderOf('old_string was not found in "D:\\code\\ED\\apps\\radar.html"')).toBe('D:\\code\\ED\\apps\\radar.html')
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
  it('returns empty for garbage bytes instead of throwing', () => {
    expect(decodeSessionLines(Buffer.from('not zstd at all'))).toEqual([])
    expect(decodeSessionLines(Buffer.alloc(0))).toEqual([])
  })
})
