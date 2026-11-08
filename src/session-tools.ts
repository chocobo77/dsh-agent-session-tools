/**
 * The `session_create` and `session_inject` tool definitions, built over the
 * Host Session Controller (`ctx.sessionController`). Both registration
 * closures return the tool to the registry; the plugin owns their disposal.
 * @module dsh-agent-session-tools/session-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ModelCatalog,
  SessionCreateRequest,
  SessionCreateValue,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller'
import {
  carriedEffort,
  checkedCwd,
  checkedEffort,
  codeOf,
  describeFailure,
  hasText,
  lookupRetry,
  promptRequestId,
  providerOfModel,
  rememberRetry,
  type RetryRecord,
  type SelectionChoice,
} from './checks.ts'

/**
 * The model selection the calling session would use for its next step, read
 * off the live Agent's `model.current()`. The tool contract only types
 * `agent` broadly, but the agent loop hands over the live runtime Agent
 * (dsh-agent-loop/src/agent.ts dispatches with `agent: this`), whose runtime
 * face (@deepseek-ai/dsh-agent runtime-types) carries the durable
 * model-selection reader. An effort the adapter only defaulted is not pinned
 * in that state, so copying it re-resolves the default instead of freezing
 * one — exactly what "same thinking strength" means. Degrades to undefined
 * when no Agent is on the execution context.
 */
function currentSelection(exec: { readonly agent?: unknown }): SelectionChoice | undefined {
  try {
    const current = (exec.agent as {
      model?: { current?: () => { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined }
    } | undefined)?.model?.current?.()
    if (current === undefined) return undefined
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
    }
  } catch {
    // An unreadable runtime face is the same situation as no face at all:
    // there is nothing to copy, so the deployment default applies.
    return undefined
  }
}

/**
 * The Host model catalog, fetched at most once per call. Catalog trouble must
 * not break a selection that does not need it, so failures read as undefined
 * and every consumer already knows how to proceed without it.
 */
async function lookupCatalog(ctx: Context): Promise<ModelCatalog | undefined> {
  try {
    return await ctx.sessionController.modelCatalog()
  } catch {
    return undefined
  }
}

/**
 * Merge the caller's model arguments with the current session's selection
 * into the one selection `session_create` will record, or undefined to leave
 * the new Session on the deployment default. Resolution happens before the
 * Session is created, so a nameable mistake (ambiguous model, effort the
 * catalog does not offer) fails without leaving a Session behind; only the
 * Host's own availability check can still fail after the fact.
 * @param ctx - the plugin context; only `sessionController` is read.
 * @param args - the model-facing arguments of `session_create`.
 * @param exec - the execution context the current session is read from.
 * @returns the selection to record, or undefined when there is nothing to select.
 * @throws when the arguments cannot combine into a selection.
 */
async function resolveSelection(
  ctx: Context,
  args: { model?: string; provider?: string; reasoningEffort?: string },
  exec: { readonly agent?: unknown },
): Promise<SelectionChoice | undefined> {
  for (const [name, value] of [
    ['model', args.model],
    ['provider', args.provider],
    ['reasoningEffort', args.reasoningEffort],
  ] as const) {
    if (value !== undefined && !hasText(value)) {
      throw new Error(`session_create: ${name} must contain non-whitespace text, got ${JSON.stringify(value)}`)
    }
  }
  if (args.provider !== undefined && args.model === undefined) {
    throw new Error('session_create: provider is only meaningful together with model')
  }
  const current = currentSelection(exec)
  if (args.model === undefined) {
    if (args.reasoningEffort === undefined) {
      // The default: copy the caller's own model and effort wholesale. The
      // Host validates the copy, so no catalog round-trip is spent here.
      return current
    }
    if (current === undefined) {
      throw new Error('session_create: reasoningEffort needs a model to apply to, and this session has none to inherit')
    }
    const catalog = await lookupCatalog(ctx)
    return {
      provider: current.provider,
      model: current.model,
      ...(catalog === undefined
        ? { reasoningEffort: args.reasoningEffort }
        : { reasoningEffort: checkedEffort(args.reasoningEffort, current.provider, current.model, catalog) }),
    }
  }
  // The current session's route is authoritative for its own model id, so an
  // unchanged id resolves without a catalog; only a different id needs one.
  const provider = args.provider
    ?? (current !== undefined && current.model === args.model
      ? current.provider
      : await resolveProvider(args.model, ctx))
  let effort: string | undefined
  if (args.reasoningEffort !== undefined) {
    const catalog = await lookupCatalog(ctx)
    effort = catalog === undefined
      ? args.reasoningEffort
      : checkedEffort(args.reasoningEffort, provider, args.model, catalog)
  } else if (current?.reasoningEffort !== undefined) {
    const catalog = await lookupCatalog(ctx)
    effort = catalog === undefined
      ? current.reasoningEffort
      : carriedEffort(current.reasoningEffort, provider, args.model, catalog)
  }
  return { provider, model: args.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** Resolve the provider of a model id, telling the caller when the catalog cannot. */
async function resolveProvider(model: string, ctx: Context): Promise<string> {
  const catalog = await lookupCatalog(ctx)
  if (catalog === undefined) {
    throw new Error(`session_create: the Host model catalog is unavailable, so the provider of ${JSON.stringify(model)} cannot be resolved; pass provider explicitly`)
  }
  return providerOfModel(model, catalog)
}

/**
 * `session_create`: one ordinary Session for a new conversation.
 * @param ctx - the plugin context; only `sessionController` is read, at call time.
 * @returns the registry-ready definition.
 */
export function createSessionTool(ctx: Context) {
  return defineTool({
    name: 'session_create',
    description: 'Create a new Session and return its id. Use it when no existing Session fits the work; the id it returns is what session_inject targets. The new Session is an ordinary conversation the user can open, not a hidden helper, and it starts idle: nothing runs until a message arrives. By default it runs this session\'s model and reasoning effort; model, provider and reasoningEffort choose otherwise. A selected model is validated by the Host against its model catalog, and the Host also records it as the deployment\'s default model. The Session inherits this deployment\'s default Agent preset and file policy unless agentPreset names another preset. Pass cwd only to own a specific directory; omit it to keep the Host default workspace. Fails when cwd is not an accessible absolute directory, the named preset is unknown, or the requested model or reasoning effort is not servable.',
    parameters: {
      cwd: {
        type: 'string',
        description: 'Absolute directory the new Session owns. Relative paths are rejected; nothing is guessed from a base directory.',
      },
      agentPreset: {
        type: 'string',
        description: 'Agent preset the Session runs, replacing the configured default. Must name a preset this deployment composes.',
      },
      model: {
        type: 'string',
        description: 'Model the new Session runs, replacing the copy of this session\'s model. Omit it to keep this session\'s model. Must be servable by the Host; with provider omitted, the id must name exactly one model in the Host model catalog.',
      },
      provider: {
        type: 'string',
        description: 'Provider route model belongs to. Pass it only to disambiguate a model id that several providers offer; never without model.',
      },
      reasoningEffort: {
        type: 'string',
        description: 'Reasoning effort (thinking strength) for the new Session, replacing the copy of this session\'s effort. Omit it to keep this session\'s effort where the model offers it, and the model\'s default effort otherwise.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          cwd: { type: 'string' },
          agentPreset: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          reasoningEffort: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `session created: ${value.sessionId}`
          + ` (cwd: ${value.cwd ?? 'default'})`
          + (value.agentPreset === undefined ? '' : ` (preset: ${value.agentPreset})`)
          + (value.model === undefined
            ? ''
            : ` (model: ${value.provider}/${value.model}${value.reasoningEffort === undefined ? '' : `, effort: ${value.reasoningEffort}`})`),
      }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('session_create: cancelled before the call began')
      const selection = await resolveSelection(ctx, args, exec)
      // Resolution awaits the catalog and the current selection, so the call
      // can be cancelled after the entry check; creation is un-cancellable
      // once it starts, so this is the last point where aborting is free.
      if (exec.signal.aborted) throw new Error('session_create: cancelled before the session was created')
      const request: SessionCreateRequest = {
        ...(args.cwd === undefined ? {} : { cwd: checkedCwd(args.cwd) }),
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
      }
      let created: SessionCreateValue
      try {
        created = await ctx.sessionController.create(request)
      } catch (error) {
        throw describeFailure('session_create', error)
      }
      if (selection === undefined) {
        return {
          sessionId: created.sessionId,
          ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        }
      }
      try {
        const { selected } = await ctx.sessionController.selectModel({
          sessionId: created.sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        })
        return {
          sessionId: created.sessionId,
          ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        }
      } catch (error) {
        // The Session exists either way; the error names it so the caller can
        // still session_inject into it or retry the selection deliberately.
        const text = error instanceof Error ? error.message : String(error)
        const code = codeOf(error)
        throw new Error(`session_create: session ${created.sessionId} was created but its model selection failed: ${text}`
          + (code === undefined ? '' : ` (${code})`))
      }
    },
  })
}

/**
 * `session_inject`: one real user message into an existing Session.
 * @param ctx - the plugin context; only `sessionController` is read, at call time.
 * @returns the registry-ready definition.
 */
export function injectSessionTool(ctx: Context) {
  /**
   * Prompts this registration has started, by idempotency key. The Host dedups
   * only once the message is in the inbox, and admission awaits attachment
   * handling before that (src/commands.ts:306, 328), so two same-key calls that
   * overlap would both insert. Holding the started promise is what makes the key
   * mean what the description says; a same-key call with different text is
   * refused rather than silently merged.
   */
  const inFlight = new Map<string, { message: string; result: Promise<InjectReceipt> }>()
  /**
   * Finished injections by idempotency key, kept for one minute. The in-flight
   * lock only covers overlap: the executor also runs two same-step calls one
   * after the other, and by then the Host has neither an inbox entry nor a
   * durable row to dedup against. Pruned by age on each lookup and capped in
   * size, and both maps die with the registration.
   */
  const settled = new Map<string, RetryRecord<InjectReceipt>>()
  return defineTool({
    name: 'session_inject',
    description: 'Deliver one message to an existing Session as a real user prompt. The message enters that Session\'s durable log and cannot be undone or recalled; nothing here reviews its content, so the caller owns what it says. Accepting the message also wakes the target Session, which then continues under its own Agent preset, model selection, permission mode and file policy. Sessions owned by subagent routing are refused by the Host as session/agent-busy. Pass requestId only to retry: resending exactly the requestId a previous call returned cannot insert that message twice, and one key must never cover two different texts. Fails when the target Session does not exist, when message is empty, or when a retry is issued for a requestId that is still in flight.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Target Session id, such as the one session_create returned.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Message text. Must contain non-whitespace characters.',
      },
      mode: {
        type: 'string',
        enum: ['queue', 'steer'],
        default: 'queue',
        description: '\'queue\' (default): admitted as its own follow-up turn. \'steer\': admitted at the nearest step boundary, so a running Session consumes it next.',
      },
      requestId: {
        type: 'string',
        description: 'Optional idempotency key. Omit it for a fresh message; to retry after an ambiguous failure, pass exactly the requestId the previous call returned. 4-150 characters of letters, digits, "_" or "-".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          mode: { type: 'string', required: true, enum: ['queue', 'steer'] },
          requestId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `message accepted: session ${value.sessionId} (mode: ${value.mode}, request: ${value.requestId})`,
      }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('session_inject: cancelled before the call began')
      if (!hasText(args.message)) {
        throw new Error('session_inject: message must contain non-whitespace text')
      }
      const mode = args.mode ?? 'queue'
      const requestId = promptRequestId(args.requestId, exec.rootCallId) as SessionRequestId
      const remembered = lookupRetry(settled, requestId, args.message, Date.now())
      if (remembered !== undefined) return remembered.receipt
      const started = inFlight.get(requestId)
      if (started !== undefined) {
        if (started.message !== args.message) {
          throw new Error(`session_inject: requestId ${JSON.stringify(requestId)} is already in flight with different text`)
        }
        return await started.result
      }
      const result = (async (): Promise<InjectReceipt> => {
        const request: SessionPromptRequest = {
          requestId,
          sessionId: args.sessionId as SessionId,
          mode,
          content: [{ type: 'text', text: args.message }],
        }
        try {
          await ctx.sessionController.prompt(request, exec.signal)
        } catch (error) {
          throw describeFailure('session_inject', error)
        }
        const receipt: InjectReceipt = { accepted: true, sessionId: args.sessionId, mode, requestId }
        rememberRetry(settled, requestId, { message: args.message, receipt, at: Date.now() })
        return receipt
      })()
      inFlight.set(requestId, { message: args.message, result })
      try {
        return await result
      } finally {
        inFlight.delete(requestId)
      }
    },
  })
}

/** What one accepted injection reports back. */
interface InjectReceipt {
  accepted: boolean
  sessionId: string
  mode: 'queue' | 'steer'
  requestId: string
}
