import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

/** What the fake Session Controller saw, per call. */
interface Recorded {
  create: unknown[]
  selectModel: unknown[]
  prompt: { request: any; signal: AbortSignal }[]
}

/** A context whose registry and Session Controller only record and reply. */
function makeContext(options: {
  create?: (request: any) => Promise<any>
  selectModel?: (request: any) => Promise<any>
  prompt?: (request: any, signal: AbortSignal) => Promise<any>
  catalog?: any
} = {}): { ctx: Context; registered: ToolDefinition[]; live: Map<string, ToolDefinition>; recorded: Recorded; disposers: (() => void)[] } {
  const registered: ToolDefinition[] = []
  const live = new Map<string, ToolDefinition>()
  const recorded: Recorded = { create: [], selectModel: [], prompt: [] }
  const disposers: (() => void)[] = []
  const ctx = {
    // A minimal fiber: run the effect body at once and keep its disposer.
    effect: (execute: () => () => void) => {
      disposers.push(execute())
    },
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        live.set(definition.name, definition)
        return () => { live.delete(definition.name) }
      },
    },
    sessionController: {
      create: async (request: any) => {
        recorded.create.push(request)
        return options.create === undefined ? { sessionId: 'session-created-1' } : options.create(request)
      },
      selectModel: async (request: any) => {
        recorded.selectModel.push(request)
        if (options.selectModel !== undefined) return options.selectModel(request)
        const { sessionId: _sessionId, ...selection } = request
        return { selected: selection }
      },
      modelCatalog: async () => {
        if (options.catalog !== undefined) return options.catalog
        throw new Error('model catalog not wired in this test')
      },
      prompt: async (request: any, signal: AbortSignal) => {
        recorded.prompt.push({ request, signal })
        return options.prompt === undefined ? { accepted: true } : options.prompt(request, signal)
      },
    },
  }
  return { ctx: ctx as unknown as Context, registered, live, recorded, disposers }
}

/** The tool body for one name, as the registry received it. */
function toolOf(registered: readonly ToolDefinition[], name: string): any {
  const tool = registered.find(definition => definition.name === name)
  if (tool === undefined) throw new Error(`no tool named ${name}`)
  return tool
}

/** An execution context whose interesting members are the signal and call identity. */
function execOf(signal: AbortSignal, callId = 'call-1'): ToolRunContext {
  return { signal, rootCallId: callId } as unknown as ToolRunContext
}

/**
 * An execution context that also carries a live Agent whose runtime model
 * reader answers with the given selection — what `session_create` reads the
 * current session's model and effort from.
 */
function execWithAgent(signal: AbortSignal, selection: any, callId = 'call-1'): ToolRunContext {
  return { signal, rootCallId: callId, agent: { id: 'session-current', model: { current: () => selection } } } as unknown as ToolRunContext
}

const KEY_PREFIX = 'agent-tools:'

let scratch = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ast-tools-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('apply', () => {
  it('registers exactly the two Session tools', () => {
    const { ctx, registered } = makeContext()
    apply(ctx)
    expect(registered.map(definition => definition.name)).toEqual(['session_create', 'session_inject'])
  })

  it('gives the fiber a disposer that takes both registrations back', () => {
    const { ctx, live, disposers } = makeContext()
    apply(ctx)
    expect([...live.keys()]).toEqual(['session_create', 'session_inject'])
    for (const dispose of disposers) dispose()
    expect(live.size).toBe(0)
  })
})

describe('session_create', () => {
  it('passes an absolute cwd through unchanged and echoes it back', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const value = await toolOf(registered, 'session_create').execute({ cwd: scratch }, execOf(new AbortController().signal))
    expect(recorded.create).toEqual([{ cwd: scratch }])
    expect(value).toEqual({ sessionId: 'session-created-1', cwd: scratch })
  })

  it('omits cwd entirely when the model supplies none', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const value = await toolOf(registered, 'session_create').execute({}, execOf(new AbortController().signal))
    expect(recorded.create).toEqual([{}])
    expect(value).toEqual({ sessionId: 'session-created-1' })
  })

  it('projects the preset the Host settled on', async () => {
    const { ctx, registered } = makeContext({ create: async () => ({ sessionId: 'session-created-1', agentPreset: 'cordis' }) })
    apply(ctx)
    const value = await toolOf(registered, 'session_create').execute({ agentPreset: 'cordis' }, execOf(new AbortController().signal))
    expect(value).toEqual({ sessionId: 'session-created-1', agentPreset: 'cordis' })
  })

  it('rejects a relative cwd before the Host is asked', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ cwd: './relative-dir' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/session_create: cwd must be an absolute directory, got "\.\/relative-dir"/)
    expect(recorded.create).toEqual([])
  })

  it('wraps a Host failure with its code', async () => {
    const { ctx, registered } = makeContext({
      create: async () => { throw Object.assign(new Error('unknown preset'), { code: 'agent-preset/conflict' }) },
    })
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ agentPreset: 'nope' }, execOf(new AbortController().signal)))
      .rejects.toThrow('session_create: unknown preset (agent-preset/conflict)')
  })

  it('does not start a Session on an already-cancelled call', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const controller = new AbortController()
    controller.abort()
    await expect(toolOf(registered, 'session_create').execute({}, execOf(controller.signal)))
      .rejects.toThrow(/cancelled before the call began/)
    expect(recorded.create).toEqual([])
  })

  it('leaves the deployment default untouched when no model can be inherited', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const value = await toolOf(registered, 'session_create').execute({}, execOf(new AbortController().signal))
    expect(recorded.selectModel).toEqual([])
    expect(value).toEqual({ sessionId: 'session-created-1' })
  })

  it('survives a model reader that throws by falling back to the deployment default', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const exec = {
      signal: new AbortController().signal,
      rootCallId: 'call-1',
      agent: { id: 'session-current', model: { current: () => { throw new Error('unreadable face') } } },
    } as unknown as ToolRunContext
    const value = await toolOf(registered, 'session_create').execute({}, exec)
    expect(recorded.selectModel).toEqual([])
    expect(value).toEqual({ sessionId: 'session-created-1' })
  })

  it('refuses a whitespace-only model, provider, or effort before the Host is asked', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const tool = toolOf(registered, 'session_create')
    await expect(tool.execute({ model: '  ' }, execOf(new AbortController().signal)))
      .rejects.toThrow('session_create: model must contain non-whitespace text, got "  "')
    await expect(tool.execute({ provider: '' }, execOf(new AbortController().signal)))
      .rejects.toThrow('session_create: provider must contain non-whitespace text, got ""')
    await expect(tool.execute({ reasoningEffort: '\t' }, execOf(new AbortController().signal)))
      .rejects.toThrow('session_create: reasoningEffort must contain non-whitespace text, got "\\t"')
    expect(recorded.create).toEqual([])
  })

  it('observes a cancellation that lands during selection, before any Session exists', async () => {
    const { ctx, registered, recorded } = makeContext()
    let release: (value: any) => void = () => {}
    ;(ctx as any).sessionController.modelCatalog = () => new Promise(resolve => { release = resolve })
    apply(ctx)
    const controller = new AbortController()
    const pending = toolOf(registered, 'session_create').execute({ model: 'm2' }, execOf(controller.signal))
    setTimeout(() => {
      controller.abort()
      // A catalog that resolves the model, so selection succeeds and execution
      // reaches the post-resolution abort check with nothing created yet.
      release({
        default: { provider: 'prov-b', model: 'm2' },
        routableProviders: ['prov-b'],
        groups: [{ id: 'prov-b', name: 'B', models: [{ id: 'm2' }] }],
        failures: [],
      })
    }, 10)
    await expect(pending).rejects.toThrow('session_create: cancelled before the session was created')
    expect(recorded.create).toEqual([])
  })

  it('copies the current session\'s model and effort wholesale by default', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const value = await toolOf(registered, 'session_create').execute({}, execWithAgent(
      new AbortController().signal,
      { provider: 'prov-a', model: 'm1', reasoningEffort: 'high' },
    ))
    expect(recorded.create).toEqual([{}])
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-a', model: 'm1', reasoningEffort: 'high' }])
    expect(value).toEqual({
      sessionId: 'session-created-1',
      provider: 'prov-a',
      model: 'm1',
      reasoningEffort: 'high',
    })
  })

  it('copies a selection without an effort as-is', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await toolOf(registered, 'session_create').execute({}, execWithAgent(
      new AbortController().signal,
      { provider: 'prov-a', model: 'm1' },
    ))
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-a', model: 'm1' }])
  })

  it('resolves the provider of an explicit model from the Host catalog', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: ['prov-a', 'prov-b'],
        groups: [
          { id: 'prov-a', name: 'A', models: [{ id: 'm1' }] },
          { id: 'prov-b', name: 'B', models: [{ id: 'm2' }] },
        ],
        failures: [],
      },
    })
    apply(ctx)
    const value = await toolOf(registered, 'session_create').execute({ model: 'm2' }, execOf(new AbortController().signal))
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-b', model: 'm2' }])
    expect(value.model).toBe('m2')
  })

  it('keeps the current session\'s route when the explicit model id is the same one', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await toolOf(registered, 'session_create').execute({ model: 'm1' }, execWithAgent(
      new AbortController().signal,
      { provider: 'prov-a', model: 'm1', reasoningEffort: 'high' },
    ))
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-a', model: 'm1', reasoningEffort: 'high' }])
  })

  it('refuses an ambiguous model id before any Session is created', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: ['prov-a', 'prov-b'],
        groups: [
          { id: 'prov-a', name: 'A', models: [{ id: 'm1' }] },
          { id: 'prov-b', name: 'B', models: [{ id: 'm1' }] },
        ],
        failures: [],
      },
    })
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ model: 'm1' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/several providers \(prov-a, prov-b\)/)
    expect(recorded.create).toEqual([])
    expect(recorded.selectModel).toEqual([])
  })

  it('refuses a model id the catalog does not list before any Session is created', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: [],
        groups: [],
        failures: [{ id: 'prov-c', name: 'C', message: 'offline' }],
      },
    })
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ model: 'm9' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/not listed in the Host model catalog.*prov-c/)
    expect(recorded.create).toEqual([])
  })

  it('refuses provider without model instead of guessing what was meant', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ provider: 'prov-a' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/provider is only meaningful together with model/)
    expect(recorded.create).toEqual([])
  })

  it('refuses an explicit effort the model does not offer before any Session is created', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: ['prov-a'],
        groups: [{ id: 'prov-a', name: 'A', models: [{ id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }],
        failures: [],
      },
    })
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ model: 'm1', reasoningEffort: 'medium' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/not offered for prov-a\/m1 \(offered: low, high\)/)
    expect(recorded.create).toEqual([])
  })

  it('degrades an inherited effort to the new model\'s default when it is not offered there', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: ['prov-a'],
        groups: [{ id: 'prov-a', name: 'A', models: [
          { id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
          { id: 'm2', reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } },
        ] }],
        failures: [],
      },
    })
    apply(ctx)
    await toolOf(registered, 'session_create').execute({ model: 'm2' }, execWithAgent(
      new AbortController().signal,
      { provider: 'prov-a', model: 'm1', reasoningEffort: 'high' },
    ))
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-a', model: 'm2', reasoningEffort: 'low' }])
  })

  it('carries an inherited effort that the new model also offers', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: ['prov-a'],
        groups: [{ id: 'prov-a', name: 'A', models: [
          { id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
          { id: 'm2', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
        ] }],
        failures: [],
      },
    })
    apply(ctx)
    await toolOf(registered, 'session_create').execute({ model: 'm2' }, execWithAgent(
      new AbortController().signal,
      { provider: 'prov-a', model: 'm1', reasoningEffort: 'high' },
    ))
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-a', model: 'm2', reasoningEffort: 'high' }])
  })

  it('applies an explicit effort to the inherited model when model is omitted', async () => {
    const { ctx, registered, recorded } = makeContext({
      catalog: {
        default: { provider: 'prov-a', model: 'm1' },
        routableProviders: ['prov-a'],
        groups: [{ id: 'prov-a', name: 'A', models: [{ id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }],
        failures: [],
      },
    })
    apply(ctx)
    await toolOf(registered, 'session_create').execute(
      { reasoningEffort: 'low' },
      execWithAgent(new AbortController().signal, { provider: 'prov-a', model: 'm1', reasoningEffort: 'high' }),
    )
    expect(recorded.selectModel).toEqual([{ sessionId: 'session-created-1', provider: 'prov-a', model: 'm1', reasoningEffort: 'low' }])
  })

  it('refuses an effort that has no model to apply to', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({ reasoningEffort: 'low' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/reasoningEffort needs a model to apply to/)
    expect(recorded.create).toEqual([])
  })

  it('names the created Session when the Host rejects the model selection afterwards', async () => {
    const { ctx, registered, recorded } = makeContext({
      selectModel: async () => {
        throw Object.assign(new Error('model "m1" is not available'), { code: 'session/model-unavailable' })
      },
    })
    apply(ctx)
    await expect(toolOf(registered, 'session_create').execute({}, execWithAgent(
      new AbortController().signal,
      { provider: 'prov-a', model: 'm1' },
    ))).rejects.toThrow(/session-created-1 was created but its model selection failed.*session\/model-unavailable/)
    expect(recorded.create).toEqual([{}])
  })

  it('renders one compact line for the model', async () => {
    const { ctx, registered } = makeContext()
    apply(ctx)
    const tool = toolOf(registered, 'session_create')
    expect(tool.output.render({}, { sessionId: 'session-created-1' })).toEqual([
      { type: 'text', text: 'session created: session-created-1 (cwd: default)' },
    ])
    expect(tool.output.render({}, { sessionId: 'session-created-1', cwd: scratch, agentPreset: 'cordis' })).toEqual([
      { type: 'text', text: `session created: session-created-1 (cwd: ${scratch}) (preset: cordis)` },
    ])
    expect(tool.output.render({}, { sessionId: 'session-created-1', provider: 'prov-a', model: 'm1', reasoningEffort: 'high' })).toEqual([
      { type: 'text', text: 'session created: session-created-1 (cwd: default) (model: prov-a/m1, effort: high)' },
    ])
    expect(tool.output.render({}, { sessionId: 'session-created-1', provider: 'prov-a', model: 'm1' })).toEqual([
      { type: 'text', text: 'session created: session-created-1 (cwd: default) (model: prov-a/m1)' },
    ])
  })
})

describe('session_inject', () => {
  it('sends one text prompt part, keyed by the tool call, and returns the receipt', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const controller = new AbortController()
    const value = await toolOf(registered, 'session_inject').execute(
      { sessionId: 'session-target-1', message: 'hello there' },
      execOf(controller.signal, 'call-9'),
    )
    expect(recorded.prompt).toHaveLength(1)
    const request = recorded.prompt[0]!.request
    expect(request.sessionId).toBe('session-target-1')
    expect(request.mode).toBe('queue')
    expect(request.content).toEqual([{ type: 'text', text: 'hello there' }])
    expect(request.requestId).toBe(`${KEY_PREFIX}call-9`)
    expect(recorded.prompt[0]!.signal).toBe(controller.signal)
    expect(value).toEqual({
      accepted: true,
      sessionId: 'session-target-1',
      mode: 'queue',
      requestId: request.requestId,
    })
  })

  it('honours mode: steer', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await toolOf(registered, 'session_inject').execute(
      { sessionId: 'session-target-1', message: 'turn left', mode: 'steer' },
      execOf(new AbortController().signal),
    )
    expect(recorded.prompt[0]!.request.mode).toBe('steer')
  })

  it('keys one key per tool call and buys the message once even on a re-dispatch', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const tool = toolOf(registered, 'session_inject')
    await tool.execute({ sessionId: 'session-target-1', message: 'once' }, execOf(new AbortController().signal, 'call-a'))
    await tool.execute({ sessionId: 'session-target-1', message: 'once' }, execOf(new AbortController().signal, 'call-a'))
    await tool.execute({ sessionId: 'session-target-1', message: 'once' }, execOf(new AbortController().signal, 'call-b'))
    const keys = recorded.prompt.map(entry => entry.request.requestId)
    expect(keys).toEqual([`${KEY_PREFIX}call-a`, `${KEY_PREFIX}call-b`])
  })

  it('honours a supplied requestId so a model retry is idempotent, and takes its own key back verbatim', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const tool = toolOf(registered, 'session_inject')
    const first = await tool.execute({ sessionId: 'session-target-1', message: 'retry me', requestId: 'retry-1' }, execOf(new AbortController().signal, 'call-a'))
    const second = await tool.execute({ sessionId: 'session-target-1', message: 'retry me', requestId: 'retry-1' }, execOf(new AbortController().signal, 'call-b'))
    const third = await tool.execute({ sessionId: 'session-target-1', message: 'retry me', requestId: `${KEY_PREFIX}retry-1` }, execOf(new AbortController().signal, 'call-c'))
    expect(recorded.prompt.map(entry => entry.request.requestId)).toEqual([`${KEY_PREFIX}retry-1`])
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('refuses a requestId that was already used for different text', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const tool = toolOf(registered, 'session_inject')
    await tool.execute({ sessionId: 'session-target-1', message: 'one', requestId: 'taken-1' }, execOf(new AbortController().signal, 'call-a'))
    await expect(tool.execute({ sessionId: 'session-target-1', message: 'two', requestId: 'taken-1' }, execOf(new AbortController().signal, 'call-b')))
      .rejects.toThrow(/was already used for different text/)
    expect(recorded.prompt).toHaveLength(1)
  })

  it('merges two parallel calls under one requestId instead of inserting twice', async () => {
    const { ctx, registered, recorded } = makeContext({
      prompt: async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return { accepted: true }
      },
    })
    apply(ctx)
    const tool = toolOf(registered, 'session_inject')
    const [first, second] = await Promise.all([
      tool.execute({ sessionId: 'session-target-1', message: 'same text', requestId: 'dup-1' }, execOf(new AbortController().signal, 'call-a')),
      tool.execute({ sessionId: 'session-target-1', message: 'same text', requestId: 'dup-1' }, execOf(new AbortController().signal, 'call-b')),
    ])
    expect(recorded.prompt).toHaveLength(1)
    expect(first.requestId).toBe(`${KEY_PREFIX}dup-1`)
    expect(second).toEqual(first)
  })

  it('refuses a parallel same-key call that carries different text', async () => {
    const { ctx, registered, recorded } = makeContext({
      prompt: async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return { accepted: true }
      },
    })
    apply(ctx)
    const tool = toolOf(registered, 'session_inject')
    const first = tool.execute({ sessionId: 'session-target-1', message: 'one', requestId: 'dup-2' }, execOf(new AbortController().signal, 'call-a'))
    const second = tool.execute({ sessionId: 'session-target-1', message: 'two', requestId: 'dup-2' }, execOf(new AbortController().signal, 'call-b'))
    await expect(second).rejects.toThrow(/is already in flight with different text/)
    expect((await first).accepted).toBe(true)
    expect(recorded.prompt).toHaveLength(1)
  })

  it('refuses a requestId that is not a usable token, before the Host is asked', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    const tool = toolOf(registered, 'session_inject')
    await expect(tool.execute({ sessionId: 'session-target-1', message: 'x', requestId: 'two words' }, execOf(new AbortController().signal)))
      .rejects.toThrow(/requestId must be 4-150 characters/)
    await expect(tool.execute({ sessionId: 'session-target-1', message: 'x', requestId: `${KEY_PREFIX}t` }, execOf(new AbortController().signal)))
      .rejects.toThrow(/requestId must be agent-tools: plus 4-150/)
    expect(recorded.prompt).toEqual([])
  })

  it('rejects an empty message before the Host is asked', async () => {
    const { ctx, registered, recorded } = makeContext()
    apply(ctx)
    await expect(toolOf(registered, 'session_inject').execute(
      { sessionId: 'session-target-1', message: '   ' },
      execOf(new AbortController().signal),
    )).rejects.toThrow('session_inject: message must contain non-whitespace text')
    expect(recorded.prompt).toEqual([])
  })

  it('reports an unknown target Session with the Host code', async () => {
    const { ctx, registered } = makeContext({
      prompt: async () => { throw Object.assign(new Error('session "session-x" not found'), { code: 'session/not-found' }) },
    })
    apply(ctx)
    await expect(toolOf(registered, 'session_inject').execute(
      { sessionId: 'session-x', message: 'any' },
      execOf(new AbortController().signal),
    )).rejects.toThrow('session_inject: session "session-x" not found (session/not-found)')
  })

  it('renders one compact line for the model', async () => {
    const { ctx, registered } = makeContext()
    apply(ctx)
    expect(toolOf(registered, 'session_inject').output.render({}, {
      accepted: true,
      sessionId: 'session-target-1',
      mode: 'steer',
      requestId: 'req-1',
    })).toEqual([
      { type: 'text', text: 'message accepted: session session-target-1 (mode: steer, request: req-1)' },
    ])
  })
})
