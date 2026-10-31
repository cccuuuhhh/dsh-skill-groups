/**
 * Host half of dsh-skill-groups.
 *
 * Responsibility split:
 *   - This file owns lifecycle: live agents, per-session mask mounting, the
 *     `deps` bundle the other host modules receive, and auto-rule activation.
 *   - `lib/state.js` is the single source of truth (loaded fresh on every read).
 *   - `lib/mask.js` turns a session's group selection into a model-visible
 *     catalog, without touching disk.
 */

import {
  computeVisibility,
  effectiveSelection,
  expireSession,
  loadState,
  matchRules,
  saveState,
} from './lib/state.js'
import {
  captureDefinitions,
  createMaskRuntime,
  mountSessionSkillMask,
  refreshSession,
} from './lib/mask.js'
import { registerSkillGroupApi } from './lib/api.js'
import { registerSkillGroupTools } from './lib/tools.js'
import { registerSkillGroupCommands } from './lib/commands.js'

/** Description cap used by @deepseek-ai/dsh-tool-skill's catalog projection. */
const DESCRIPTION_MAX_LENGTH = 500

function disposeAll(disposers) {
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A failed dispose must not block the remaining teardown.
      }
    }
  }
}

export async function apply(ctx) {
  const runtime = createMaskRuntime()
  const disposers = []
  const mounted = new Map()

  const skillsOf = (agent) => {
    const agentCtx = agent?.ctx
    if (agentCtx === undefined) return undefined
    return typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx.skills
  }

  const cwdOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }

  /**
   * Recompute one session's mask.
   *
   * Capture happens first, against the catalog as it looks before this mask is
   * installed: a shim must carry the real skill body, so it can never be built
   * from the previous shim.
   */
  const refresh = async (sessionId) => {
    const agent = agentFor(sessionId)
    const skills = skillsOf(agent)
    if (skills === undefined) return undefined
    const state = await loadState()
    const cwd = cwdOf(agent)
    if (state.groups.length > 0) {
      const captured = await captureDefinitions(ctx, state, skills, cwd)
      for (const [name, definition] of captured) runtime.definitions.set(name, definition)
    }
    const visibility = await refreshSession(state, skills, runtime, sessionId, cwd)
    publishVisibility(visibility)
    return visibility
  }

  const agentFor = (sessionId) => {
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.get === 'function') {
      const found = agents.get(sessionId)
      if (found !== undefined) return found
    }
    return { id: sessionId }
  }

  const liveSessions = () => {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return []
    return agents.list()
  }

  const refreshAll = async () => {
    for (const agent of liveSessions()) {
      try {
        await refresh(agent.id)
      } catch (error) {
        ctx.logger?.warn?.(`skill-groups: refresh failed for ${agent.id}: ${String(error?.message ?? error)}`)
      }
    }
  }

  const skillsFor = async (sessionId) => {
    const agent = agentFor(sessionId)
    const skills = skillsOf(agent)
    if (skills === undefined) return []
    try {
      return await skills.list({ cwd: cwdOf(agent) })
    } catch {
      return []
    }
  }

  const latestState = () => loadState()

  const deps = { refresh, refreshAll, skillsFor, latestState }

  // --- lifecycle: mount a mask into every agent's own skill scope ------------

  const mount = (agent) => {
    if (agent === undefined || agent.id === undefined || mounted.has(agent.id)) return
    const skills = skillsOf(agent)
    if (skills === undefined || typeof skills.registerProvider !== 'function') return
    // `skills` here is the agent-scoped traceable: calling registerProvider on
    // it binds `this.ctx` to the agent's scope, which is what makes the mask
    // per-session. Fabricating a substitute context would lose that scope and
    // silently mask globally instead.
    const dispose = mountSessionSkillMask(skills, runtime, agent.id)
    mounted.set(agent.id, dispose)
    refresh(agent.id).catch(() => {})
  }

  const unmount = (agent) => {
    const sessionId = agent?.id
    if (sessionId === undefined) return
    const dispose = mounted.get(sessionId)
    mounted.delete(sessionId)
    if (typeof dispose === 'function') dispose()
  }

  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/created', ({ agent }) => mount(agent)) ?? (() => {}))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => unmount(agent)) ?? (() => {}))
  }

  // --- auto-activation rules -------------------------------------------------

  /**
   * Apply matching rules to a session that has no explicit selection yet.
   *
   * A rule may only ever activate a group the user configured; it never
   * deactivates anything the user chose, so an explicit switch always wins.
   */
  const applyRules = async (agent) => {
    const state = await loadState()
    if (state.rules.length === 0) return
    if (state.sessions[agent.id] !== undefined) return
    const preset = agent?.session?.header?.agentPreset
    const workspace = cwdOf(agent)
    const matches = matchRules(state, { workspace, preset })
    if (matches.length === 0) return
    const next = { ...state }
    next.sessions = { ...state.sessions }
    next.sessions[agent.id] = { activeIds: [...new Set(matches)] }
    await saveState(next)
    await refresh(agent.id)
  }

  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/created', ({ agent }) => {
      applyRules(agent).catch(() => {})
    }) ?? (() => {}))
    // A turn boundary expires `--for-turn` selections.
    disposers.push(ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      expireSession(agent.id, turn)
        .then(() => refresh(agent.id))
        .catch(() => {})
    }) ?? (() => {}))
  }

  // --- host surfaces ---------------------------------------------------------

  for (const register of [registerSkillGroupApi, registerSkillGroupTools, registerSkillGroupCommands]) {
    try {
      const dispose = register(ctx, deps)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.(`skill-groups: a host surface failed to register: ${String(error?.message ?? error)}`)
    }
  }

  // Mount onto agents that already exist when this plugin loads.
  for (const agent of liveSessions()) mount(agent)

  ctx.effect?.(() => disposeAll(disposers), 'skill-groups: host surfaces')
  return disposeAll(disposers)
}

/**
 * Seed the default selection the first time the plugin runs.
 *
 * Called by the API layer after a state mutation; exported so tests can drive
 * it without a live agent.
 */
export async function initializeSelection(state, sessionId) {
  const selection = effectiveSelection(state, sessionId)
  const summaries = []
  return computeVisibility(state, sessionId, summaries, { descriptionMaxLength: DESCRIPTION_MAX_LENGTH })
}

let lastPublished = ''
function publishVisibility(visibility) {
  if (visibility === undefined) return
  const digest = `${visibility.activeGroupIds.join(',')}|${visibility.maskedCount}`
  if (digest === lastPublished) return
  lastPublished = digest
}

export default apply
