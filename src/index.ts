/**
 * Host-only tool bundle: `session_create` and `session_inject` over the Host
 * Session Controller. No Client surface, no Config, no state of its own.
 * @module dsh-agent-session-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSessionTool, injectSessionTool } from './session-tools.ts'

export const name = 'agent-session-tools'
export const inject = ['tools', 'sessionController']

/**
 * Register both tools for the plugin lifetime. `ctx.tools.register` hands back
 * its exact disposer, which `ctx.effect` runs when this entry unloads.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(createSessionTool(ctx)), 'session_create')
  ctx.effect(() => ctx.tools.register(injectSessionTool(ctx)), 'session_inject')
}
