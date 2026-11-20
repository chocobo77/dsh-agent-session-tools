/**
 * Host-only tool bundle: `session_create` and `session_inject` wrap the Host
 * Session Controller; `session_error_audit` is a read-only scan of the local
 * session logs. No Client surface, no Config, no state of its own.
 * @module dsh-agent-session-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSessionTool, injectSessionTool } from './session-tools.ts'
import { auditSessionTool } from './error-audit.ts'

export const name = 'agent-session-tools'
export const inject = ['tools', 'sessionController', 'workspaceRegistry']

/**
 * Register the Session tools and the error audit for the plugin lifetime.
 * `ctx.tools.register` hands back
 * its exact disposer, which `ctx.effect` runs when this entry unloads.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(createSessionTool(ctx)), 'session_create')
  ctx.effect(() => ctx.tools.register(injectSessionTool(ctx)), 'session_inject')
  ctx.effect(() => ctx.tools.register(auditSessionTool(ctx)), 'session_error_audit')
}
