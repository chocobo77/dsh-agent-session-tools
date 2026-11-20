/**
 * The `session_error_audit` tool: scan persisted session logs (`~/.dsh/sessions`)
 * for `isError` tool results and return a BOUNDED summary — category counts,
 * the worst sessions, and the worst offender files/commands. The detail never
 * enters the conversation; callers page a specific session with `read` if they
 * must. Everything classification-side is pure and directly test-driven.
 * @module dsh-agent-session-tools/error-audit
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { describeFailure } from './checks.ts'

/** The async zstd decode runs on libuv's threadpool, keeping the Host event loop free. */
const zstdDecompressAsync = promisify(zstdDecompress) as (bytes: Buffer) => Promise<Buffer>

/** Validated audit arguments after defaulting. */
export interface ErrorAuditInput {
  sinceIso: string | undefined
  cwdContains: string | undefined
  top: number
}

/**
 * Accept bounded arguments: `since` as an ISO date/time, a cwd substring,
 * and a top-N clamped to 5 (the summary is capped by design).
 * @param args - the schema-validated raw arguments.
 * @returns the defaulted input.
 */
export function parseAuditArgs(args: { since?: string; cwd_contains?: string; top?: number }): ErrorAuditInput {
  if (args.since !== undefined && Number.isNaN(Date.parse(args.since))) {
    throw new Error('session_error_audit: since must be an ISO 8601 date/time string')
  }
  const top = args.top === undefined ? 3 : Math.min(Math.max(Math.trunc(args.top), 1), 5)
  return { sinceIso: args.since, cwdContains: args.cwd_contains, top }
}

/**
 * Classify one error text into the recurring failure vocabulary. Order
 * matters: specific patterns first, generic ones last.
 * @param text - the error text (already truncated).
 * @returns a short stable category key.
 */
export function classifyErrorText(text: string): string {
  if (text.includes('old_string was not found')) return 'edit-mismatch'
  if (text.includes('file changed since it was read')) return 'edit-stale'
  if (text.includes('has not been read')) return 'edit-not-read'
  if (text.includes('execution deadline')) return 'timeout'
  if (text.includes('IO error for operation')) return 'search-bad-path'
  if (/Expected|Unexpected token|Expression expected|ReferenceError|invalid syntax|SyntaxError/u.test(text)) return 'syntax'
  if (text.includes('fetch failed') || text.includes('tool call timed out')) return 'network'
  if (text.includes('missing required property') || text.includes('invalid arguments')) return 'bad-args'
  if (text.includes('ENOENT')) return 'enoent'
  return 'other'
}

/**
 * A pre-execute guard denial (dsh-search-path-guard) also reaches the log as
 * an `isError` tool result — the pipeline turns a `deny` into an `Error:`
 * result — but the tool NEVER RAN: it is a prevented failure, not a tool
 * failure. Conflating the two makes the audit penalize the very guardrails it
 * exists to measure ("verify that guardrails reduced a failure category"),
 * since every prevented failure would otherwise land in the categories it is
 * supposed to shrink. The anchors mirror that plugin's denial wording — a
 * cross-package text contract, same style as its zero-result marker.
 * @param text - the error text (already truncated).
 * @returns true when the text is a guard denial rather than a tool error.
 */
export function isGuardDenial(text: string): boolean {
  return text.includes('loop-guard:')
    || text.includes('edit blocked:')
    || text.includes(' search failed: path "')
    || text.includes(' failed: file "')
    || text.includes('read_image only accepts')
}

/** Extract one short human attribution from an error text: the target file or command head. */
export function offenderOf(text: string): string {
  const quoted = /in "([^"]+)"/u.exec(text) ?? /(?:modify|write|edit|read) "([^"]+)"/u.exec(text)
  if (quoted !== null) return quoted[1] as string
  const command = /command:\\?"([^"\\]{10,80})/u.exec(text)
  if (command !== null) return command[1] as string
  return ''
}

/** The sessions root this audit scans by default. */
export function defaultSessionsRoot(): string {
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * Decode one session log into its line array. The decompression runs on
 * libuv's threadpool, so a large artifact does not stall the Host event loop;
 * the file's concatenated frames (independent header frame first) decode in
 * one pass, and the header line is itself a JSONL record, so no special
 * framing is needed downstream.
 * @param bytes - the complete `.jsonl.zstd` file bytes.
 * @returns the decoded lines; empty for a corrupt or unreadable artifact.
 */
export async function decodeSessionLines(bytes: Buffer): Promise<string[]> {
  if (bytes.length === 0) return []
  try {
    const decoded = await zstdDecompressAsync(bytes)
    return decoded.toString('utf8').split('\n')
  } catch {
    return [] // corrupt artifact: skip, do not fail the audit
  }
}

/**
 * Run the audit over one sessions directory. One directory level and one file
 * at a time, with every read and the zstd decode off the main thread; error
 * text is truncated at extraction, so only the bounded summary is returned.
 * @param root - the sessions root (workspace directories, each holding
 *   per-session directories).
 * @param input - the validated filter arguments.
 * @returns the bounded summary text.
 */
export async function auditSessions(root: string, input: ErrorAuditInput): Promise<string> {
  const sinceMs = input.sinceIso === undefined ? Number.NEGATIVE_INFINITY : Date.parse(input.sinceIso)
  const categories = new Map<string, number>()
  const perSession = new Map<string, { cwd: string; count: number }>()
  const offenders = new Map<string, number>()
  let total = 0
  let denials = 0
  let scanned = 0
  for (const workspace of await readdir(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    for (const session of await readdir(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = join(workspaceDir, session.name)
      for (const file of await readdir(sessionDir)) {
        if (!file.endsWith('.jsonl.zstd') && !file.endsWith('.jsonl')) continue
        const bytes = await readFile(join(sessionDir, file))
        const lines = file.endsWith('.jsonl.zstd') ? await decodeSessionLines(bytes) : bytes.toString('utf8').split('\n')
        const record = scanLines(lines, sinceMs)
        if (record === undefined) continue
        if (input.cwdContains !== undefined && !record.cwd.includes(input.cwdContains)) continue
        // The header's denominator is SESSIONS WITH ERRORS: guard-only sessions
        // contribute denials but must not inflate it or the worst-sessions list,
        // and cwd-filtered sessions must not inflate it either (the `scanned`
        // line used to sit before the filter).
        if (record.errors.length > 0) {
          scanned += 1
          const sessionKey = record.cwd === '?' ? session.name : record.cwd
          const bucket = perSession.get(sessionKey) ?? { cwd: sessionKey, count: 0 }
          bucket.count += record.errors.length
          perSession.set(sessionKey, bucket)
        }
        total += record.errors.length
        denials += record.denials
        for (const error of record.errors) {
          categories.set(error, (categories.get(error) ?? 0) + 1)
        }
        if (record.denials > 0) categories.set('guard-denied', (categories.get('guard-denied') ?? 0) + record.denials)
        for (const offender of record.offenders) {
          offenders.set(offender, (offenders.get(offender) ?? 0) + 1)
        }
      }
    }
  }
  return renderSummary(total, scanned, denials, categories, perSession, offenders, input.top)
}

/**
 * Scan one decoded log: cwd, tool names per call id, the tool-error records,
 * and the guard-denial count. One counted error per call id: the durable log
 * is append-only, and the replace mechanism (infinite-context's tool archive,
 * the host tool-result pruner) appends a SHADOW row (`surfaceOp: replace`)
 * carrying the same message — a naive line scan counts the same failure once
 * per row, inflating exactly the long archived sessions the audit is meant to
 * study. First row wins, which is also the un-pruned original text.
 */
function scanLines(lines: readonly string[], sinceMs: number): { cwd: string; errors: readonly string[]; offenders: readonly string[]; denials: number } | undefined {
  let cwd = '?'
  const callNames = new Map<string, string>()
  const counted = new Set<string>()
  const errors: string[] = []
  const offenders: string[] = []
  let denials = 0
  for (const line of lines) {
    if (line.length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const time = typeof event.time === 'number' ? event.time : 0
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'session': {
        cwd = typeof event.cwd === 'string' ? event.cwd : '?'
        break
      }
      case 'tool/call': {
        if (typeof data.callId === 'string') callNames.set(data.callId, typeof data.name === 'string' ? data.name : '?')
        break
      }
      case 'tool/result': {
        const message = (data.message ?? {}) as Record<string, unknown>
        if (message.isError !== true || time < sinceMs) break
        const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
        if (callId.length > 0) {
          if (counted.has(callId)) break // shadow/replace row of a counted result
          counted.add(callId)
        }
        const text = plainText((message.content ?? []) as unknown[]).slice(0, 200)
        if (isGuardDenial(text)) {
          denials += 1
        } else {
          errors.push(classifyErrorText(text))
        }
        // The offender attribution is useful for denials too: it shows where
        // the guard keeps blocking the model, which is the prevention signal.
        const name = callNames.get(callId) ?? '?'
        const offender = offenderOf(text)
        offenders.push(`${name}${offender.length > 0 ? ` → ${offender.slice(0, 80)}` : ''}`)
        break
      }
      default: break
    }
  }
  return errors.length > 0 || denials > 0 ? { cwd, errors, offenders, denials } : undefined
}

/** Concatenate the text parts of one LLM content array. */
function plainText(content: readonly unknown[]): string {
  let text = ''
  for (const part of content) {
    if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') {
      text += (part as { text: string }).text
    }
  }
  return text
}

/** Rank helper: descending count, key asc for determinism. */
function topEntries<K>(map: Map<K, number>, limit: number): readonly (readonly [K, number])[] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit)
}

/**
 * Render the bounded summary: hard-capped at roughly 40 lines regardless of
 * how many sessions or error kinds were seen.
 */
function renderSummary(
  total: number,
  scanned: number,
  denials: number,
  categories: Map<string, number>,
  perSession: Map<string, { cwd: string; count: number }>,
  offenders: Map<string, number>,
  top: number,
): string {
  const lines: string[] = []
  // Guard denials are PREVENTED failures: kept out of the tool-error total
  // (which feeds worst-sessions and the trend the audit exists to measure)
  // but shown so prevention is visible, not silently dropped.
  lines.push(`session_error_audit: ${total} tool errors across ${scanned} sessions with errors`
    + (denials > 0 ? ` (${denials} pre-guard denial(s) counted separately, not as tool errors)` : ''))
  lines.push('— categories —')
  for (const [category, count] of topEntries(categories, 10)) lines.push(`${String(count).padStart(4)}  ${category}`)
  lines.push('— worst sessions —')
  const sessionCounts = new Map<string, number>()
  for (const [cwd, bucket] of perSession) sessionCounts.set(cwd, bucket.count)
  for (const [cwd, count] of topEntries(sessionCounts, top)) lines.push(`${String(count).padStart(4)}  ${cwd}`)
  lines.push('— top offenders (tool → file/command) —')
  for (const [offender, count] of topEntries(offenders, top)) lines.push(`${String(count).padStart(4)}  ${offender}`)
  return lines.join('\n')
}

/**
 * The `session_error_audit` tool definition. Read-only over the session
 * store; the result is the bounded summary text and nothing else, so one
 * weekly call costs the conversation roughly forty lines.
 * @param ctx - the plugin context (unused today; kept for service parity
 * with the sibling tools).
 * @returns the registered tool.
 */
export function auditSessionTool(ctx: Context): ReturnType<typeof defineTool> {
  void ctx
  return defineTool({
    name: 'session_error_audit',
    description: 'Summarize recurring tool-call and edit errors across persisted DSH sessions. Returns a bounded summary only (category counts, worst sessions, top offender files/commands, ~40 lines); session detail stays on disk — page a specific session with read if needed. Duplicate rows of one archived result are counted once; pre-execute guard denials are reported under guard-denied, separate from tool-error totals. Use it to audit error trends or verify that guardrails reduced a failure category.',
    parameters: {
      since: { type: 'string', description: 'Optional ISO 8601 lower bound on error time.' },
      cwd_contains: { type: 'string', description: 'Optional substring filter on the session working directory.' },
      top: { type: 'number', description: 'Rows in the worst-session and top-offender tables. Defaults to 3, clamped to 1-5.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'The bounded multi-line summary.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const input = parseAuditArgs(args)
      let summary: string
      try {
        summary = await auditSessions(defaultSessionsRoot(), input)
      } catch (error) {
        // A missing or unreadable sessions root should fail as a tool result,
        // not as a raw filesystem exception.
        throw describeFailure('session_error_audit', error)
      }
      return { summary }
    },
  })
}
