/**
 * Persistent state for dsh-skill-groups.
 *
 * One JSON document under $DSH_HOME/skill-groups/state.json, written
 * atomically (temp file + rename) so a crash can never leave a half-written
 * document. A missing or corrupt file degrades to the defaults instead of
 * throwing: losing the user's grouping is recoverable, losing their session is
 * not.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const STATE_VERSION = 2
export const HISTORY_LIMIT = 50

/** Resolve $DSH_HOME the way the host does, falling back to ~/.dsh. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

export function stateFilePath() {
  return join(dshHome(), 'skill-groups', 'state.json')
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    groups: [],
    // The set of active groups. All groups are peers now: the user combines
    // whichever ones they want; there is no exclusive/additive distinction.
    active: { activeIds: [] },
    sessions: {},
    rules: [],
    history: [],
    ui: { sidebarEntry: true, composerChip: true },
    defaultPolicy: 'all',
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '')
}

/**
 * Normalise one selection document into a flat `{ activeIds: string[] }`.
 *
 * Accepts three shapes so a migration or a hand-written history entry never
 * loses ids:
 *   - `{ activeIds: string[] }` (current)
 *   - `{ exclusive, additive }` (legacy v1)
 *   - a bare `string[]` (a history `before` snapshot that already went through
 *     one normalisation pass)
 */
function normalizeSelection(value) {
  const ids = new Set()
  if (Array.isArray(value)) {
    for (const id of value) if (typeof id === 'string' && id !== '') ids.add(id)
    return { activeIds: [...ids] }
  }
  if (isRecord(value)) {
    for (const id of asStringArray(value.activeIds)) ids.add(id)
    if (typeof value.exclusive === 'string' && value.exclusive !== '') ids.add(value.exclusive)
    for (const id of asStringArray(value.additive)) ids.add(id)
  }
  return { activeIds: [...ids] }
}

function normalizeGroup(raw, index) {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '') return undefined
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `g-${index + 1}`
  return {
    id,
    name,
    members: asStringArray(raw.members),
    note: typeof raw.note === 'string' ? raw.note : '',
  }
}

function normalizeRule(raw, index) {
  if (!isRecord(raw) || typeof raw.group !== 'string') return undefined
  const match = isRecord(raw.match) ? raw.match : {}
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `r-${index + 1}`,
    group: raw.group,
    match: {
      workspace: typeof match.workspace === 'string' ? match.workspace : '',
      preset: typeof match.preset === 'string' ? match.preset : '',
      keywords: asStringArray(match.keywords),
    },
  }
}

function normalizeHistoryEntry(raw) {
  if (!isRecord(raw)) return undefined
  const action = typeof raw.action === 'string' ? raw.action : 'toggle'
  return {
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
    action,
    group: typeof raw.group === 'string' ? raw.group : null,
    before: normalizeSelection(raw.before).activeIds,
  }
}

/** Coerce whatever is on disk into a valid state document. Never throws. */
export function normalizeState(raw) {
  const base = defaultState()
  if (!isRecord(raw)) return base

  base.groups = Array.isArray(raw.groups)
    ? raw.groups.map(normalizeGroup).filter((group) => group !== undefined)
    : []
  base.active = normalizeSelection(raw.active)

  if (isRecord(raw.sessions)) {
    for (const [key, value] of Object.entries(raw.sessions)) {
      if (!isRecord(value)) continue
      const selection = normalizeSelection(value)
      base.sessions[key] = typeof value.untilTurn === 'number' ? { ...selection, untilTurn: value.untilTurn } : selection
    }
  }

  base.rules = Array.isArray(raw.rules) ? raw.rules.map(normalizeRule).filter((rule) => rule !== undefined) : []
  base.history = Array.isArray(raw.history)
    ? raw.history.map(normalizeHistoryEntry).filter((entry) => entry !== undefined).slice(-HISTORY_LIMIT)
    : []

  if (isRecord(raw.ui)) {
    base.ui.sidebarEntry = raw.ui.sidebarEntry !== false
    base.ui.composerChip = raw.ui.composerChip !== false
  }
  base.defaultPolicy = raw.defaultPolicy === 'none' ? 'none' : 'all'
  return base
}

/** Read state, degrading to defaults on a missing, unreadable, or corrupt file. */
export async function loadState() {
  try {
    const text = await readFile(stateFilePath(), 'utf8')
    return normalizeState(JSON.parse(text))
  } catch {
    return defaultState()
  }
}

/** Atomically replace the state document. */
export async function saveState(state) {
  const normalized = normalizeState(state)
  normalized.history = normalized.history.slice(-HISTORY_LIMIT)
  const target = stateFilePath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return normalized
}

/** The active group ids in force for one session: its override, else the global set. */
export function effectiveSelection(state, sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    const override = state.sessions[sessionId]
    if (isRecord(override)) {
      return {
        activeIds: [...asStringArray(override.activeIds)],
        untilTurn: typeof override.untilTurn === 'number' ? override.untilTurn : undefined,
      }
    }
  }
  return { activeIds: [...asStringArray(state.active.activeIds)] }
}

function rememberBefore(state, selection) {
  state.history.push({
    at: Date.now(),
    action: 'toggle',
    group: null,
    before: { activeIds: [...selection.activeIds] },
  })
  if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT)
}

function writeSelection(state, sessionId, selection) {
  const next = { activeIds: [...asStringArray(selection.activeIds)] }
  if (typeof selection.untilTurn === 'number') next.untilTurn = selection.untilTurn
  if (typeof sessionId === 'string' && sessionId !== '') state.sessions[sessionId] = next
  else state.active = { activeIds: [...next.activeIds] }
}

export function findGroup(state, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  return state.groups.find((group) => group.id === ref) ?? state.groups.find((group) => group.name === ref)
}

/**
 * Turn one group on or off for a session (or globally when sessionId is empty).
 *
 * All groups are peers: enabling one does not disable any other, so the user
 * composes whichever combination they want.
 */
export async function setGroupActive(sessionId, groupRef, enabled) {
  const state = await loadState()
  const group = findGroup(state, groupRef)
  if (group === undefined) {
    const error = new Error(`unknown skill group "${groupRef}"`)
    error.code = 'group.not-found'
    throw error
  }
  const current = effectiveSelection(state, sessionId)
  rememberBefore(state, current)
  state.history[state.history.length - 1].action = enabled ? 'activate' : 'deactivate'
  state.history[state.history.length - 1].group = group.id
  const activeIds = enabled
    ? [...new Set([...current.activeIds, group.id])]
    : current.activeIds.filter((id) => id !== group.id)
  writeSelection(state, sessionId, { activeIds })
  return { state: await saveState(state), group }
}

/** Replace the active set wholesale (used by `/import` ordering and batch ops). */
export async function setActiveGroups(sessionId, groupRefs) {
  const state = await loadState()
  const ids = []
  for (const ref of asStringArray(groupRefs)) {
    const group = findGroup(state, ref)
    if (group !== undefined) ids.push(group.id)
  }
  const current = effectiveSelection(state, sessionId)
  rememberBefore(state, current)
  state.history[state.history.length - 1].action = 'set'
  writeSelection(state, sessionId, { activeIds: [...new Set(ids)] })
  return saveState(state)
}

export async function clearSelection(sessionId) {
  const state = await loadState()
  const current = effectiveSelection(state, sessionId)
  rememberBefore(state, current)
  state.history[state.history.length - 1].action = 'clear'
  if (typeof sessionId === 'string' && sessionId !== '') {
    // "Clear" means "stop overriding this session" — delete the override so the
    // session falls back to the global default selection, not to an empty set.
    delete state.sessions[sessionId]
  } else {
    state.active = { activeIds: [] }
  }
  return saveState(state)
}

/** Roll the session selection back to the newest recorded "before" snapshot. */
export async function undo(sessionId) {
  const state = await loadState()
  const entry = state.history[state.history.length - 1]
  if (entry === undefined) return { state, restored: null }
  state.history = state.history.slice(0, -1)
  writeSelection(state, sessionId, { activeIds: entry.before })
  return { state: await saveState(state), restored: entry }
}

export async function setSessionSelection(sessionId, selection) {
  const state = await loadState()
  writeSelection(state, sessionId, selection)
  return saveState(state)
}

/** Turn the session's temporary selection into a plain one (drops untilTurn). */
export async function settleSession(sessionId) {
  const state = await loadState()
  const override = state.sessions[sessionId]
  if (!isRecord(override) || typeof override.untilTurn !== 'number') return state
  delete override.untilTurn
  return saveState(state)
}

/** Drop expired temporary selections once their turn has passed. */
export async function expireSession(sessionId, turn) {
  const state = await loadState()
  const override = state.sessions[sessionId]
  if (!isRecord(override) || typeof override.untilTurn !== 'number') return state
  if (turn < override.untilTurn) return state
  delete state.sessions[sessionId]
  return saveState(state)
}

export function activeGroupIds(state, sessionId) {
  return effectiveSelection(state, sessionId).activeIds
}

/**
 * The single authority on which skills the model may discover.
 *
 * A skill is visible when an active group lists it, or when it belongs to no
 * group at all under `defaultPolicy: 'all'`. Everything else is masked for
 * model invocation only — user invocation (`/name`) stays available.
 */
export function computeVisibility(state, sessionId, summaries, options = {}) {
  const descriptionMaxLength = typeof options.descriptionMaxLength === 'number' ? options.descriptionMaxLength : 500
  const activeIds = new Set(activeGroupIds(state, sessionId))
  const activeGroups = state.groups.filter((group) => activeIds.has(group.id))

  const groupedBy = new Map()
  for (const group of state.groups) {
    for (const member of group.members) {
      const existing = groupedBy.get(member)
      if (existing === undefined) groupedBy.set(member, [])
      groupedBy.get(member).push(group)
    }
  }
  const activeMembers = new Set()
  for (const group of activeGroups) for (const member of group.members) activeMembers.add(member)

  const effective = []
  let catalogChars = 0
  let maskedCount = 0
  for (const summary of summaries) {
    const name = summary.name
    const groups = groupedBy.get(name) ?? []
    const inAny = groups.length > 0
    let visible
    let reason
    let groupName
    if (activeMembers.has(name)) {
      visible = true
      reason = 'active'
      groupName = activeGroups.find((group) => group.members.includes(name))?.name
    } else if (!inAny && state.defaultPolicy === 'all') {
      visible = true
      reason = 'ungrouped'
    } else if (!inAny) {
      visible = false
      reason = 'policy-none'
    } else {
      visible = false
      reason = 'inactive-group'
      groupName = groups[0].name
    }
    if (visible) {
      const description = typeof summary.description === 'string' ? summary.description.slice(0, descriptionMaxLength) : ''
      catalogChars += name.length + description.length + 4
    } else {
      maskedCount += 1
    }
    effective.push({
      name,
      description: summary.description,
      source: summary.source,
      provider: summary.provider,
      groups: groups.map((group) => group.name),
      visible,
      reason,
      group: groupName,
    })
  }
  return {
    effective,
    maskedCount,
    catalogChars,
    catalogTokens: Math.ceil(catalogChars / 4),
    activeGroupIds: [...activeIds],
  }
}

/** Match the configured auto-activation rules against a session's context. */
export function matchRules(state, context = {}) {
  const matches = []
  for (const rule of state.rules) {
    if (findGroup(state, rule.group) === undefined) continue
    const { workspace = '', preset = '', keywords = [] } = rule.match
    let hit = true
    let scored = false
    if (workspace !== '') {
      scored = true
      if (typeof context.workspace !== 'string' || !context.workspace.toLowerCase().includes(workspace.toLowerCase())) hit = false
    }
    if (hit && preset !== '') {
      scored = true
      if (context.preset !== preset) hit = false
    }
    if (hit && keywords.length > 0) {
      scored = true
      const text = typeof context.text === 'string' ? context.text.toLowerCase() : ''
      if (!keywords.some((keyword) => text.includes(keyword.toLowerCase()))) hit = false
    }
    if (hit && scored) matches.push(rule.group)
  }
  return matches
}
