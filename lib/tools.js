/**
 * Model-facing tools for dsh-skill-groups.
 *
 * Seven small tools rather than one dispatcher: the model picks a group by name
 * in conversation ("switch to the research group"), and a flat name per verb
 * keeps that choice legible in a trajectory.
 *
 * The acting session comes from `exec.agent`, so a switch made while serving
 * session A never reconfigures session B. Every mutation ends with
 * `deps.refresh(sessionId)`; without it the catalog the model sees on its next
 * step would still be the old one, and the tool would appear to have done
 * nothing.
 */

import {
  clearSelection,
  computeVisibility,
  effectiveSelection,
  findGroup,
  loadState,
  setGroupActive,
} from './state.js'
import { saveGroup, setGroupMembers, SkillGroupError } from './api.js'

/** Appended to every description: what a switch does NOT do. */
const SEMANTICS =
  'Switching only changes which skills the MODEL can discover; no skill is deleted, no SKILL.md is edited, '
  + 'and the user can still type /skillname to invoke any skill directly.'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Canonical output contract: any JSON object is a valid canonical value. */
function output(render) {
  return { schema: { type: 'object' }, render }
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }]
}

function reasonSuffix(value, fallback) {
  return isRecord(value) && typeof value.error === 'string' ? `${fallback}: ${value.error}` : `${fallback}.`
}

/** One-line status summary, built from the JSON value an execute() returned. */
function renderSummary(value) {
  const selection = isRecord(value?.selection) ? value.selection : {}
  const active = Array.isArray(selection.active) && selection.active.length > 0
    ? selection.active.join(', ')
    : '(none)'
  const visible = typeof value?.visibleCount === 'number' ? value.visibleCount : 0
  const masked = typeof value?.maskedCount === 'number' ? value.maskedCount : 0
  const chars = typeof value?.catalogChars === 'number' ? value.catalogChars : 0
  const tokens = typeof value?.catalogTokens === 'number' ? value.catalogTokens : 0
  return `active groups: ${active} | visible skills: ${visible} | masked: ${masked}`
    + ` | catalog cost: ${chars} chars / ~${tokens} tokens`
}

/** The acting session id, or '' for the global default selection. */
function sessionOf(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return ''
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  const session = agent.session
  if (session !== undefined && session !== null && typeof session.id === 'string') return session.id
  return ''
}

async function currentState(deps) {
  if (deps !== undefined && typeof deps.latestState === 'function') return deps.latestState()
  return loadState()
}

async function currentSkills(deps, sessionId) {
  if (deps === undefined || typeof deps.skillsFor !== 'function') return []
  try {
    const skills = await deps.skillsFor(sessionId)
    return Array.isArray(skills) ? skills : []
  } catch {
    return []
  }
}

/**
 * Push a saved selection into the mask/catalog for one session.
 *
 * By the time this runs the state file is already written, so a refresh failure
 * is returned rather than thrown: reporting the switch as a failure would claim
 * the change did not happen when it did, and silently swallowing it would let
 * the model keep looking at a stale catalog. The caller surfaces it.
 *
 * @returns {Promise<string|undefined>} an error message when the push failed
 */
async function refreshOne(deps, sessionId) {
  if (deps === undefined || typeof deps.refresh !== 'function') return undefined
  try {
    await deps.refresh(sessionId)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Group and rule edits can mask a skill in sessions that never called this
 * tool, so they refresh every live session, not just the caller's.
 */
async function refreshEvery(deps, sessionId) {
  const failure = await refreshOne(deps, sessionId)
  if (deps === undefined || typeof deps.refreshAll !== 'function') return failure
  try {
    await deps.refreshAll()
    return failure
  } catch (error) {
    return failure ?? (error instanceof Error ? error.message : String(error))
  }
}

/** Merge a refresh failure into a payload without hiding it. */
function withRefresh(payload, failure) {
  return failure === undefined ? payload : { ...payload, refreshError: failure }
}

/** The shared read model: selection, visibility entries, and cost. */
async function describe(deps, sessionId) {
  const state = await currentState(deps)
  const selection = effectiveSelection(state, sessionId)
  const skills = await currentSkills(deps, sessionId)
  const visibility = computeVisibility(state, sessionId, skills)
  const activeIds = new Set(visibility.activeGroupIds)
  const groups = state.groups.map((group) => ({
    id: group.id,
    name: group.name,
    members: group.members,
    memberCount: group.members.length,
    note: group.note,
    active: activeIds.has(group.id),
  }))
  const total = visibility.effective.length
  return {
    state,
    selection,
    groups,
    visibility,
    masked: visibility.effective.filter((entry) => !entry.visible),
    visibleCount: total - visibility.maskedCount,
    totalCount: total,
    catalogChars: visibility.catalogChars,
    catalogTokens: visibility.catalogTokens,
  }
}

/** Resolve a user-supplied group reference, tolerating case differences. */
function resolveGroup(state, ref) {
  const group = findGroup(state, ref)
  if (group !== undefined) return group
  const lowered = String(ref).toLowerCase()
  return state.groups.find((entry) => entry.name.toLowerCase() === lowered)
}

/** Map a selection of group ids onto display names, dropping unknown ids. */
function selectionNames(state, selection) {
  const nameOf = (id) => (typeof id === 'string' && id !== '' ? (findGroup(state, id)?.name ?? id) : null)
  const active = []
  for (const id of (Array.isArray(selection.activeIds) ? selection.activeIds : [])) {
    const name = nameOf(id)
    if (name !== null) active.push(name)
  }
  return { active }
}

function statusPayload(status) {
  return {
    ok: true,
    selection: selectionNames(status.state, status.selection),
    activeGroupIds: status.visibility.activeGroupIds,
    defaultPolicy: status.state.defaultPolicy,
    visibleCount: status.visibleCount,
    totalCount: status.totalCount,
    maskedCount: status.visibility.maskedCount,
    catalogChars: status.catalogChars,
    catalogTokens: status.catalogTokens,
    masked: status.masked.map((entry) => ({
      name: entry.name,
      groups: entry.groups,
      reason: entry.reason,
      ...(typeof entry.group === 'string' ? { blockedBy: entry.group } : {}),
    })),
    groups: status.groups,
  }
}

function asError(error) {
  const code = error instanceof SkillGroupError
    ? error.code
    : (typeof error?.code === 'string' ? error.code : 'internal')
  return {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
  }
}

// --- tool definitions -------------------------------------------------------

function currentTool(deps) {
  return {
    name: 'skillgroup_current',
    description:
      'Report this session\'s skill group state: which groups are active, how many skills the model can see, '
      + 'the catalog token cost, and exactly which skills are hidden and by which group. '
      + 'Use it before answering "which skills do you have right now" or when a skill seems to be missing. '
      + `${SEMANTICS}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: output((_args, value) => text(isRecord(value) && value.ok === true
      ? renderSummary(value)
      : reasonSuffix(value, 'Skill group state unavailable'))),
    async execute(_args, exec) {
      try {
        return statusPayload(await describe(deps, sessionOf(exec)))
      } catch (error) {
        return asError(error)
      }
    },
  }
}

function listTool(deps) {
  return {
    name: 'skillgroup_list',
    description:
      'List every configured skill group with its id, member count, and whether it is currently active for this '
      + 'session. Call this first to learn the exact group name before applying one. '
      + `${SEMANTICS}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: output((_args, value) => {
      if (!isRecord(value) || value.ok !== true) return text(reasonSuffix(value, 'Skill groups unavailable'))
      const groups = Array.isArray(value.groups) ? value.groups : []
      if (groups.length === 0) return text('No skill groups are defined yet.')
      return text(groups
        .map((group) => {
          const note = typeof group.note === 'string' && group.note !== '' ? ` — ${group.note}` : ''
          return `${group.active ? '*' : '-'} ${group.name} (${group.memberCount} skills)${note}`
        })
        .join('\n'))
    }),
    async execute(_args, exec) {
      try {
        const status = await describe(deps, sessionOf(exec))
        return {
          ok: true,
          groups: status.groups,
          defaultPolicy: status.state.defaultPolicy,
          selection: selectionNames(status.state, status.selection),
        }
      } catch (error) {
        return asError(error)
      }
    },
  }
}

function applyTool(deps) {
  return {
    name: 'skillgroup_apply',
    description:
      'Turn a skill group ON for this session by name or id; the change applies to the very next model step. '
      + 'Groups are peers: enabling one never disables another, so apply several to compose the set you need. '
      + `${SEMANTICS}`,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name or id, as reported by skillgroup_list.' },
      },
      required: ['group'],
      additionalProperties: false,
    },
    output: output((_args, value) => {
      if (!isRecord(value) || value.ok !== true) return text(reasonSuffix(value, 'Switch failed'))
      const name = isRecord(value.applied) && typeof value.applied.name === 'string' ? value.applied.name : '(unknown)'
      return text(`Enabled "${name}". ${renderSummary(value)}`)
    }),
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      try {
        const ref = isRecord(args) && typeof args.group === 'string' ? args.group.trim() : ''
        if (ref === '') return { ok: false, code: 'body.invalid', error: '"group" is required' }
        const state = await currentState(deps)
        const group = resolveGroup(state, ref)
        if (group === undefined) {
          return {
            ok: false,
            code: 'group.not-found',
            error: `unknown skill group "${ref}"`,
            availableGroups: state.groups.map((entry) => entry.name),
          }
        }
        await setGroupActive(sessionId, group.id, true)
        const refreshError = await refreshOne(deps, sessionId)
        const status = await describe(deps, sessionId)
        return withRefresh({
          ...statusPayload(status),
          applied: { id: group.id, name: group.name, members: group.members },
        }, refreshError)
      } catch (error) {
        return asError(error)
      }
    },
  }
}

function toggleTool(deps) {
  return {
    name: 'skillgroup_toggle',
    description:
      'Turn one skill group on or off for this session. Groups are peers, so this only changes the named group '
      + 'and never disturbs the others. Use it to fine-tune which groups are active alongside each other. '
      + `${SEMANTICS}`,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name or id, as reported by skillgroup_list.' },
        enabled: { type: 'boolean', description: 'true turns the group on, false turns it off.' },
      },
      required: ['group', 'enabled'],
      additionalProperties: false,
    },
    output: output((_args, value) => {
      if (!isRecord(value) || value.ok !== true) return text(reasonSuffix(value, 'Toggle failed'))
      const name = isRecord(value.group) && typeof value.group.name === 'string' ? value.group.name : '(unknown)'
      return text(`${value.enabled === true ? 'Enabled' : 'Disabled'} "${name}". ${renderSummary(value)}`)
    }),
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      try {
        if (!isRecord(args)) return { ok: false, code: 'body.invalid', error: 'arguments are required' }
        const ref = typeof args.group === 'string' ? args.group.trim() : ''
        if (ref === '') return { ok: false, code: 'body.invalid', error: '"group" is required' }
        if (typeof args.enabled !== 'boolean') {
          return { ok: false, code: 'body.invalid', error: '"enabled" must be a boolean' }
        }
        const state = await currentState(deps)
        const group = resolveGroup(state, ref)
        if (group === undefined) {
          return { ok: false, code: 'group.not-found', error: `unknown skill group "${ref}"` }
        }
        await setGroupActive(sessionId, group.id, args.enabled)
        const refreshError = await refreshOne(deps, sessionId)
        const status = await describe(deps, sessionId)
        return withRefresh({
          ...statusPayload(status),
          enabled: args.enabled,
          group: { id: group.id, name: group.name },
        }, refreshError)
      } catch (error) {
        return asError(error)
      }
    },
  }
}

function createTool(deps) {
  return {
    name: 'skillgroup_create',
    description:
      'Create a new skill group, or update the group that already has this name. Names are unique. '
      + 'Groups are peers: any combination of groups can be active at once, so a group is just a named collection '
      + 'of skills to switch as a unit. Members are skill names taken from the session skill catalog. Creating a '
      + 'group does not activate it — call skillgroup_apply for that. '
      + `${SEMANTICS}`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name; unique and human readable.' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill names that belong to the group.',
        },
        note: { type: 'string', description: 'Optional free-form note shown in the panel.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: output((_args, value) => {
      if (!isRecord(value) || value.ok !== true) return text(reasonSuffix(value, 'Group save failed'))
      const group = isRecord(value.group) ? value.group : {}
      const name = typeof group.name === 'string' ? group.name : '(unknown)'
      const members = Array.isArray(group.members) ? group.members.length : 0
      return text(`Saved group "${name}" with ${members} skills.`)
    }),
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      try {
        if (!isRecord(args)) return { ok: false, code: 'body.invalid', error: 'arguments are required' }
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (name === '') return { ok: false, code: 'group.name-required', error: '"name" is required' }
        // Create-or-update: the model works in names, while the API edits by id.
        // Resolving the name here keeps a re-run of the same call idempotent
        // without letting an unnamed create overwrite a different group.
        const state = await currentState(deps)
        const existing = resolveGroup(state, name)
        const result = await saveGroup({
          ...(existing !== undefined ? { id: existing.id } : {}),
          name,
          members: args.members,
          note: args.note,
        })
        const refreshError = await refreshEvery(deps, sessionId)
        return withRefresh({
          ok: true,
          updated: existing !== undefined,
          group: result.group ?? null,
          groups: result.state.groups.map((group) => ({
            id: group.id,
            name: group.name,
            memberCount: group.members.length,
          })),
        }, refreshError)
      } catch (error) {
        return asError(error)
      }
    },
  }
}

function setMembersTool(deps) {
  return {
    name: 'skillgroup_set_members',
    description:
      'Change which skills belong to an existing group. Provide exactly one of "add", "remove", or "set": "add" '
      + 'appends names, "remove" drops them, and "set" replaces the member list outright. '
      + `${SEMANTICS}`,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name or id.' },
        add: { type: 'array', items: { type: 'string' }, description: 'Skill names to add.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Skill names to remove.' },
        set: { type: 'array', items: { type: 'string' }, description: 'Replacement member list.' },
      },
      required: ['group'],
      additionalProperties: false,
    },
    output: output((_args, value) => {
      if (!isRecord(value) || value.ok !== true) return text(reasonSuffix(value, 'Member update failed'))
      const group = isRecord(value.group) ? value.group : {}
      const name = typeof group.name === 'string' ? group.name : '(unknown)'
      const members = Array.isArray(group.members) ? group.members.length : 0
      return text(`Group "${name}" now has ${members} skills.`)
    }),
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      try {
        if (!isRecord(args)) return { ok: false, code: 'body.invalid', error: 'arguments are required' }
        const ref = typeof args.group === 'string' ? args.group.trim() : ''
        if (ref === '') return { ok: false, code: 'body.invalid', error: '"group" is required' }
        const state = await currentState(deps)
        const group = resolveGroup(state, ref)
        if (group === undefined) {
          return { ok: false, code: 'group.not-found', error: `unknown skill group "${ref}"` }
        }
        const modes = ['add', 'remove', 'set'].filter((key) => args[key] !== undefined)
        if (modes.length !== 1) {
          return { ok: false, code: 'body.invalid', error: 'provide exactly one of "add", "remove", or "set"' }
        }
        const mode = modes[0]
        const values = args[mode]
        if (!Array.isArray(values)) {
          return { ok: false, code: 'body.invalid', error: `"${mode}" must be an array of skill names` }
        }
        let members
        if (mode === 'set') {
          members = values
        } else {
          const merged = new Set(group.members)
          for (const raw of values) {
            if (typeof raw !== 'string' || raw.trim() === '') continue
            if (mode === 'add') merged.add(raw.trim())
            else merged.delete(raw.trim())
          }
          members = [...merged]
        }
        const result = await setGroupMembers(group.id, members)
        const refreshError = await refreshEvery(deps, sessionId)
        return withRefresh({ ok: true, mode, group: result.group ?? null }, refreshError)
      } catch (error) {
        return asError(error)
      }
    },
  }
}

function clearTool(deps) {
  return {
    name: 'skillgroup_clear',
    description:
      'Turn off every active skill group for this session, so visibility falls back to the default policy '
      + '(ungrouped skills visible, grouped skills hidden). Use it to reset before switching, or when the user asks '
      + 'to stop filtering. The previous selection can be restored with the panel\'s undo action. '
      + `${SEMANTICS}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: output((_args, value) => text(isRecord(value) && value.ok === true
      ? `Cleared all group switches. ${renderSummary(value)}`
      : reasonSuffix(value, 'Clear failed'))),
    async execute(_args, exec) {
      const sessionId = sessionOf(exec)
      try {
        await clearSelection(sessionId)
        const refreshError = await refreshOne(deps, sessionId)
        return withRefresh(statusPayload(await describe(deps, sessionId)), refreshError)
      } catch (error) {
        return asError(error)
      }
    },
  }
}

/**
 * Register every `skillgroup_*` tool.
 *
 * @param {object} ctx  host context; only `tools` and `effect` are touched
 * @param {object} deps `refresh`, `refreshAll`, `skillsFor`, `latestState`
 * @returns {() => void} disposer that unregisters every tool
 */
export function registerSkillGroupTools(ctx, deps) {
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') {
    try {
      ctx?.logger?.warn?.('skill-groups: tools service is unavailable; the skillgroup_* tools stay unregistered')
    } catch {
      // Logging is best-effort.
    }
    return () => {}
  }

  const resolved = deps ?? {}
  const definitions = [
    currentTool(resolved),
    listTool(resolved),
    applyTool(resolved),
    toggleTool(resolved),
    createTool(resolved),
    setMembersTool(resolved),
    clearTool(resolved),
  ]

  /** Register all seven and return one combined disposer. Runs exactly once. */
  const registerAll = () => {
    const disposers = []
    try {
      for (const definition of definitions) {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    } catch (error) {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Keep unwinding the rest.
        }
      }
      throw error
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A failed dispose must not block the rest.
        }
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    try {
      let owned
      const fromEffect = ctx.effect(() => {
        owned = registerAll()
        return owned
      }, 'skill-groups: model tools')
      if (typeof fromEffect === 'function') return fromEffect
      if (typeof owned === 'function') return owned
    } catch {
      // Fall through to a plain registration below.
    }
  }
  return registerAll()
}

export default registerSkillGroupTools
