/**
 * Argument checks and failure wording shared by the two Session tools.
 * Everything here is pure, so the tests drive it directly.
 * @module dsh-agent-session-tools/checks
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'

/**
 * Accept only an existing absolute directory as a Session workspace.
 * @param value - the model-supplied `cwd`.
 * @returns the same path, unchanged, once it is proven usable.
 * @throws when the path is relative, unreadable, or not a directory.
 */
export function checkedCwd(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`session_create: cwd must be an absolute directory, got ${JSON.stringify(value)}`)
  }
  let stats
  try {
    stats = statSync(value)
  } catch (error) {
    throw new Error(`session_create: cwd is not accessible (${codeOf(error)}): ${value}`)
  }
  if (!stats.isDirectory()) throw new Error(`session_create: cwd is not a directory: ${value}`)
  return value
}

/** Namespace so this plugin's keys cannot collide with ids another producer minted. */
export const requestIdPrefix = 'agent-tools:'

/**
 * Pick the idempotency key for one prompt.
 *
 * Omitted: one key per model tool call, so an executor re-dispatching the same
 * call cannot insert the message twice. Supplied: the caller's own key, so a
 * retry after an ambiguous failure lands at most once. A key that already
 * carries the namespace is used verbatim, which is what “retry with the
 * requestId the previous call returned” means.
 * @param value - the model-supplied `requestId`, if any.
 * @param callId - the root tool-call id from the execution context.
 * @returns the key to hand to the Host.
 * @throws when a supplied key is not a usable token.
 */
export function promptRequestId(value: string | undefined, callId: string | undefined): string {
  if (value === undefined) {
    const stable = typeof callId === 'string' && callId.length > 0 ? callId : randomUUID()
    return `${requestIdPrefix}${stable}`
  }
  if (value.startsWith(requestIdPrefix)) {
    if (!new RegExp(`^${requestIdPrefix}[\\w-]{4,150}$`).test(value)) {
      throw new Error(`session_inject: requestId must be ${requestIdPrefix} plus 4-150 word characters or "-": ${JSON.stringify(value)}`)
    }
    return value
  }
  if (!/^[\w-]{4,150}$/.test(value)) {
    throw new Error('session_inject: requestId must be 4-150 characters of letters, digits, "_" or "-", or exactly the requestId a previous call returned')
  }
  return `${requestIdPrefix}${value}`
}

/** How long a finished injection is remembered so its key cannot insert twice. */
export const retryWindowMs = 60_000

/** Upper bound on remembered keys, so the ledger cannot grow without limit. */
export const retryLedgerLimit = 256

/** One finished injection, remembered by its idempotency key. */
export interface RetryRecord<T> {
  message: string
  receipt: T
  at: number
}

/**
 * A finished injection this key already bought.
 *
 * The Host dedups only against the inbox and the durable history
 * (src/commands.ts:542-553), and a prompt leaves the inbox as soon as a turn
 * starts while its durable row is written at that turn's start — so a retry
 * inside that window inserts a second copy (observed live: two splices under one
 * key, the durable `user/message` written only after the second call).
 * @param ledger - remembered injections, oldest first.
 * @param key - the idempotency key of the incoming call.
 * @param message - the incoming text, which must match what the key bought.
 * @param now - current time in milliseconds.
 * @returns the remembered record, or undefined when the key is new or expired.
 * @throws when the key was used for different text inside the window.
 */
export function lookupRetry<T>(
  ledger: Map<string, RetryRecord<T>>,
  key: string,
  message: string,
  now: number,
): RetryRecord<T> | undefined {
  for (const [entry, record] of ledger) {
    if (now - record.at > retryWindowMs) ledger.delete(entry)
  }
  const record = ledger.get(key)
  if (record === undefined) return undefined
  if (record.message !== message) {
    throw new Error(`session_inject: requestId ${JSON.stringify(key)} was already used for different text within ${retryWindowMs / 1000}s`)
  }
  return record
}

/**
 * Remember a finished injection, keeping the ledger inside its window and size.
 * @param ledger - remembered injections, oldest first.
 * @param key - the idempotency key that was used.
 * @param record - the text and receipt to remember.
 */
export function rememberRetry<T>(ledger: Map<string, RetryRecord<T>>, key: string, record: RetryRecord<T>): void {
  ledger.set(key, record)
  while (ledger.size > retryLedgerLimit) {
    const oldest = ledger.keys().next()
    if (oldest.done === true) break
    ledger.delete(oldest.value)
  }
}

/**
 * The Workspace that owns one Session, by its ordered session account.
 * @param workspaces - the registry's live workspaces, in display order.
 * @param sessionId - the Session to locate; undefined when the call carries no Agent.
 * @returns the owning Workspace, or undefined when the Session is unclassified.
 */
export function ownerWorkspace<T extends { id: string; sessionIds: readonly string[] }>(
  workspaces: readonly T[],
  sessionId: string | undefined,
): T | undefined {
  if (sessionId === undefined) return undefined
  return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
}

/**
 * Whether a prompt carries something the target Agent should see.
 * @param value - the model-supplied `message`.
 * @returns false for empty or whitespace-only text.
 */
export function hasText(value: string): boolean {
  return value.trim().length > 0
}

/**
 * Explain a Host failure in one model-facing line, keeping the Remote error code.
 * @param tool - the tool the model called.
 * @param error - whatever the Session Controller threw.
 * @returns the error to throw so the tool result carries a clear failure.
 */
export function describeFailure(tool: string, error: unknown): Error {
  const code = codeOf(error)
  const text = error instanceof Error ? error.message : String(error)
  return new Error(`${tool}: ${text}${code === undefined ? '' : ` (${code})`}`)
}

/** The error code a Host or filesystem failure carries, when it carries one. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * The complete model selection `session_create` can hand to the Host's
 * `selectModel`, after the caller's arguments and the current session's own
 * choice have been merged and, where the Host catalog can see it, checked.
 */
export interface SelectionChoice {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The catalog entry of one model route, when the catalog lists it. */
function entryOf(catalog: ModelCatalog, provider: string, model: string) {
  return catalog.groups.find(group => group.id === provider)?.models.find(entry => entry.id === model)
}

/** Whether a visible model entry lists reasoning efforts at all. */
function effortList(catalog: ModelCatalog, provider: string, model: string) {
  return entryOf(catalog, provider, model)?.reasoning?.efforts
}

/**
 * Resolve the provider that serves a model id the caller named without one.
 * Only a catalog-unique id resolves this way; anything else must come with an
 * explicit `provider`, because guessing a route would silently run the model
 * somewhere the caller did not mean.
 * @param model - the model id to place.
 * @param catalog - the Host model catalog.
 * @returns the single provider whose group lists the id.
 * @throws when no visible group lists the id, or more than one does.
 */
export function providerOfModel(model: string, catalog: ModelCatalog): string {
  const providers = catalog.groups.filter(group => group.models.some(entry => entry.id === model)).map(group => group.id)
  if (providers.length === 1) return providers[0]
  if (providers.length === 0) {
    const failed = catalog.failures.map(failure => failure.id)
    throw new Error(`session_create: model ${JSON.stringify(model)} is not listed in the Host model catalog`
      + (failed.length === 0 ? '' : ` (these providers failed to load: ${failed.join(', ')})`))
  }
  throw new Error(`session_create: model ${JSON.stringify(model)} is offered by several providers (${providers.join(', ')}); pass provider to pick one`)
}

/**
 * Keep an explicitly requested reasoning effort only when the visible catalog
 * admits it. A route the catalog cannot see (load failure, unknown provider)
 * passes through so the Host's own `selectModel` validation decides.
 * @param effort - the caller-supplied effort id.
 * @param provider - the provider route the effort applies to.
 * @param model - the model the effort applies to.
 * @param catalog - the Host model catalog.
 * @returns the same effort, unchanged, once it is not visibly wrong.
 * @throws when the model entry is visible and lists efforts that exclude it.
 */
export function checkedEffort(effort: string, provider: string, model: string, catalog: ModelCatalog): string {
  const efforts = effortList(catalog, provider, model)
  if (efforts !== undefined && efforts.length > 0 && !efforts.some(candidate => candidate.id === effort)) {
    throw new Error(`session_create: reasoning effort ${JSON.stringify(effort)} is not offered for ${provider}/${model}`
      + ` (offered: ${efforts.map(candidate => candidate.id).join(', ')})`)
  }
  return effort
}

/**
 * Carry an inherited reasoning effort onto a model route. The same route
 * always accepts it; a different route keeps it only while the visible
 * catalog offers it, and otherwise degrades to that route's default effort —
 * the caller asked for "same strength", not for a validation failure on a
 * model that never had it.
 * @param effort - the inherited effort id, if the current session chose one.
 * @param provider - the provider route the effort is carried onto.
 * @param model - the model the effort is carried onto.
 * @param catalog - the Host model catalog.
 * @returns the effort to record, or undefined to follow the route's default.
 */
export function carriedEffort(
  effort: string | undefined,
  provider: string,
  model: string,
  catalog: ModelCatalog,
): string | undefined {
  if (effort === undefined) return undefined
  const reasoning = entryOf(catalog, provider, model)?.reasoning
  const efforts = reasoning?.efforts
  if (efforts !== undefined && efforts.length > 0 && !efforts.some(candidate => candidate.id === effort)) {
    return reasoning?.defaultEffort
  }
  return effort
}
