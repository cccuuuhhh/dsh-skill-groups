/**
 * HTTP surface for dsh-skill-groups.
 *
 * Everything the panel and the composer chip need lives under one prefix route,
 * `/api/skill-groups`. This module also owns the group / rule / policy editing
 * primitives: `lib/tools.js` imports them rather than keeping a second copy, so
 * the model tool and the panel can never disagree about what "save" means.
 *
 * Two constraints shape the code:
 *   - `lib/state.js` is the only writer of `state.json`; nothing here caches a
 *     state object across requests.
 *   - Saving the file does not change what the model can discover, so every
 *     mutation ends with `deps.refresh(sessionId)`. Group, policy and rule
 *     edits additionally refresh every live session, because changing a group's
 *     members can mask a skill in sessions that never sent this request.
 */

import {
  clearSelection,
  computeVisibility,
  effectiveSelection,
  findGroup,
  loadState,
  saveState,
  setGroupActive,
  undo,
} from './state.js'

/** Prefix registered on the host web server. */
export const ROUTE_PREFIX = '/api/skill-groups'
/** Request header carrying the acting session id. */
export const SESSION_HEADER = 'x-dsh-skill-groups-session'
/** Ceiling for an import payload: group names, never skill bodies. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** An expected failure that maps onto a JSON error response. */
export class SkillGroupError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SkillGroupError'
    this.code = code
    this.status = status
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Trim, drop empties, and de-duplicate while preserving first-seen order. */
export function uniqueStrings(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    const name = trimmed(item)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function mintId(taken, prefix) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(candidate)) return candidate
  }
  return `${prefix}-${Date.now().toString(36)}`
}

function groupIds(state) {
  return new Set(state.groups.map((group) => group.id))
}

// --- state editing primitives (shared with lib/tools.js) ---------------------

/**
 * Create a group, or update the one named by `id`.
 *
 * `id` means "update this row". Omitting it means "create a new row", and a
 * colliding name is rejected rather than treated as an implicit update: a
 * create that silently replaced an existing group's member list would be data
 * loss triggered by a save button. The panel always holds the id when editing,
 * so it never needs the implicit form.
 */
export async function saveGroup(input) {
  if (!isRecord(input)) throw new SkillGroupError('group.invalid', 'group must be an object')
  const name = trimmed(input.name)
  if (name === '') throw new SkillGroupError('group.name-required', 'a group needs a non-empty name')

  const state = await loadState()
  const explicitId = trimmed(input.id)
  let target
  if (explicitId !== '') {
    target = state.groups.find((group) => group.id === explicitId)
    if (target === undefined) {
      throw new SkillGroupError('group.not-found', `unknown skill group "${explicitId}"`, 404)
    }
  }
  const clash = state.groups.find((group) => group !== target && group.name === name)
  if (clash !== undefined) {
    throw new SkillGroupError(
      'group.duplicate-name',
      `a group named "${name}" already exists; pass its id to update it`,
    )
  }

  const patch = {
    name,
    members: uniqueStrings(input.members),
    note: typeof input.note === 'string' ? input.note : '',
  }
  let id
  if (target !== undefined) {
    Object.assign(target, patch)
    id = target.id
  } else {
    const taken = groupIds(state)
    id = mintId(taken, 'g')
    state.groups.push({ id, ...patch })
  }
  const saved = await saveState(state)
  return { state: saved, group: saved.groups.find((group) => group.id === id) }
}

/** Drop one group and every selection/rule reference to it. */
export async function deleteGroup(ref) {
  const state = await loadState()
  const group = findGroup(state, ref)
  if (group === undefined) throw new SkillGroupError('group.not-found', `unknown skill group "${ref}"`, 404)
  state.groups = state.groups.filter((entry) => entry.id !== group.id)
  pruneGroupRefs(state)
  return { state: await saveState(state), removed: group }
}

/**
 * Persist a new group order from a drag-and-drop reorder.
 *
 * `ids` is the full intended order of group ids. Every existing group must be
 * present exactly once — a missing id would silently drop a group, and a stray
 * one would reorder against nothing — so both are rejected rather than coerced.
 */
export async function reorderGroups(ids) {
  if (!Array.isArray(ids)) throw new SkillGroupError('reorder.invalid', 'ids must be an array')
  const state = await loadState()
  const existing = state.groups.map((group) => group.id)
  if (ids.length !== existing.length) {
    throw new SkillGroupError('reorder.invalid', 'the reorder must name every existing group exactly once')
  }
  const incoming = new Set(ids)
  if (existing.some((id) => !incoming.has(id))) {
    throw new SkillGroupError('reorder.invalid', 'the reorder must name every existing group exactly once')
  }
  const byId = new Map(state.groups.map((group) => [group.id, group]))
  state.groups = ids.map((id) => byId.get(id))
  return { state: await saveState(state) }
}

/** Add or remove one member of one group. */
export async function setGroupMember(ref, skill, add) {
  const state = await loadState()
  const group = findGroup(state, ref)
  if (group === undefined) throw new SkillGroupError('group.not-found', `unknown skill group "${ref}"`, 404)
  const name = trimmed(skill)
  if (name === '') throw new SkillGroupError('skill.name-required', 'a skill name is required')
  const members = new Set(group.members)
  if (add) members.add(name)
  else members.delete(name)
  group.members = [...members]
  const saved = await saveState(state)
  return { state: saved, group: saved.groups.find((entry) => entry.id === group.id) }
}

/** Replace a group's member list outright. */
export async function setGroupMembers(ref, members) {
  const state = await loadState()
  const group = findGroup(state, ref)
  if (group === undefined) throw new SkillGroupError('group.not-found', `unknown skill group "${ref}"`, 404)
  group.members = uniqueStrings(members)
  const saved = await saveState(state)
  return { state: saved, group: saved.groups.find((entry) => entry.id === group.id) }
}

/**
 * Turn one group on or off for the acting session.
 *
 * All groups are peers now: enabling a group never disables any other, so the
 * user composes whichever combination they want. `setGroupActive` refuses
 * unknown groups only.
 */
export async function setGroupToggle(sessionId, ref, enabled) {
  const state = await loadState()
  const group = findGroup(state, ref)
  if (group === undefined) throw new SkillGroupError('group.not-found', `unknown skill group "${ref}"`, 404)
  try {
    await setGroupActive(sessionId, group.id, enabled)
  } catch (error) {
    throw wrapStateError(error)
  }
  return group
}

export async function setDefaultPolicy(policy) {
  if (policy !== 'all' && policy !== 'none') {
    throw new SkillGroupError('policy.invalid', 'defaultPolicy must be "all" or "none"')
  }
  const state = await loadState()
  state.defaultPolicy = policy
  return saveState(state)
}

export async function setUiOptions(patch) {
  if (!isRecord(patch)) throw new SkillGroupError('ui.invalid', 'ui options must be an object')
  const state = await loadState()
  let touched = false
  for (const key of ['sidebarEntry', 'composerChip']) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') {
      throw new SkillGroupError('ui.invalid', `${key} must be a boolean`)
    }
    state.ui[key] = patch[key]
    touched = true
  }
  if (!touched) return state
  return saveState(state)
}

/** Create or update one auto-activation rule. */
export async function saveRule(input) {
  if (!isRecord(input)) throw new SkillGroupError('rule.invalid', 'rule must be an object')
  const groupRef = trimmed(input.group)
  if (groupRef === '') throw new SkillGroupError('rule.group-required', 'a rule needs a target group')

  const state = await loadState()
  const group = findGroup(state, groupRef)
  if (group === undefined) throw new SkillGroupError('group.not-found', `unknown skill group "${groupRef}"`, 404)
  const match = isRecord(input.match) ? input.match : {}
  const next = {
    group: group.id,
    match: {
      workspace: trimmed(match.workspace),
      preset: trimmed(match.preset),
      keywords: uniqueStrings(match.keywords),
    },
  }
  const explicitId = trimmed(input.id)
  let id
  if (explicitId !== '') {
    const target = state.rules.find((rule) => rule.id === explicitId)
    if (target === undefined) throw new SkillGroupError('rule.not-found', `unknown rule "${explicitId}"`, 404)
    target.group = next.group
    target.match = next.match
    id = target.id
  } else {
    id = mintId(new Set(state.rules.map((rule) => rule.id)), 'r')
    state.rules.push({ id, ...next })
  }
  const saved = await saveState(state)
  return { state: saved, rule: saved.rules.find((rule) => rule.id === id) }
}

export async function deleteRule(id) {
  const state = await loadState()
  const key = trimmed(id)
  const existing = state.rules.find((rule) => rule.id === key)
  if (existing === undefined) throw new SkillGroupError('rule.not-found', `unknown rule "${id}"`, 404)
  state.rules = state.rules.filter((rule) => rule.id !== existing.id)
  return { state: await saveState(state), removed: existing }
}

/**
 * Replace the group (and, when supplied, rule) definitions with an imported set.
 *
 * Imported ids are reused when they are present and unique, and freshly minted
 * otherwise: ids are the only stable handle that selections and rules hold, so
 * preserving them is what makes an export/import round trip lossless. Duplicate
 * names are dropped because `findGroup` could not address them.
 */
export async function importDefinitions(groups, rules) {
  if (!Array.isArray(groups)) throw new SkillGroupError('import.invalid', 'groups must be an array')
  if (rules !== undefined && !Array.isArray(rules)) {
    throw new SkillGroupError('import.invalid', 'rules must be an array')
  }
  const state = await loadState()

  const usedIds = new Set()
  const usedNames = new Set()
  const nextGroups = []
  for (const raw of groups) {
    if (!isRecord(raw)) continue
    const name = trimmed(raw.name)
    if (name === '' || usedNames.has(name)) continue
    usedNames.add(name)
    const wanted = trimmed(raw.id)
    const id = wanted !== '' && !usedIds.has(wanted) ? wanted : mintId(usedIds, 'g')
    usedIds.add(id)
    nextGroups.push({
      id,
      name,
      members: uniqueStrings(raw.members),
      note: typeof raw.note === 'string' ? raw.note : '',
    })
  }
  state.groups = nextGroups

  if (rules !== undefined) {
    const byName = new Map(nextGroups.map((group) => [group.name, group]))
    const ruleIds = new Set()
    const nextRules = []
    for (const raw of rules) {
      if (!isRecord(raw) || typeof raw.group !== 'string') continue
      const target = byName.get(raw.group) ?? nextGroups.find((group) => group.id === raw.group)
      if (target === undefined) continue
      const wanted = trimmed(raw.id)
      const id = wanted !== '' && !ruleIds.has(wanted) ? wanted : mintId(ruleIds, 'r')
      ruleIds.add(id)
      const match = isRecord(raw.match) ? raw.match : {}
      nextRules.push({
        id,
        group: target.id,
        match: {
          workspace: trimmed(match.workspace),
          preset: trimmed(match.preset),
          keywords: uniqueStrings(match.keywords),
        },
      })
    }
    state.rules = nextRules
  }

  pruneGroupRefs(state)
  return saveState(state)
}

/**
 * Drop every selection and rule reference to a group that no longer exists.
 *
 * A session override that becomes empty is removed outright: keeping it would
 * pin that session to "nothing selected" and stop it falling back to the global
 * active set, which is not what a deleted group should do.
 */
function pruneGroupRefs(state) {
  const valid = new Set(state.groups.map((group) => group.id))
  const keepIds = (ids) => (Array.isArray(ids) ? ids.filter((id) => valid.has(id)) : [])

  state.active = { activeIds: keepIds(state.active?.activeIds) }

  const sessions = {}
  for (const [sessionId, selection] of Object.entries(state.sessions)) {
    if (!isRecord(selection)) continue
    const activeIds = keepIds(selection.activeIds)
    const untilTurn = typeof selection.untilTurn === 'number' ? { untilTurn: selection.untilTurn } : {}
    if (activeIds.length === 0 && untilTurn.untilTurn === undefined) continue
    sessions[sessionId] = { activeIds, ...untilTurn }
  }
  state.sessions = sessions
  state.rules = state.rules.filter((rule) => valid.has(rule.group))
}

// --- read model -------------------------------------------------------------

async function latestState(deps) {
  if (deps !== undefined && typeof deps.latestState === 'function') return deps.latestState()
  return loadState()
}

async function skillsFor(deps, sessionId) {
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
 * The state file is already written by the time this runs, so a refresh failure
 * must not be turned into a mutation failure — that would report "nothing
 * happened" for a change that did persist. It is reported instead, because a
 * silent refresh failure means the visible catalog disagrees with the saved
 * state and the caller needs to know.
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

/** Attach the refresh outcome to a payload without hiding a failure. */
function attachRefresh(failure, payload) {
  return failure === undefined ? payload : { ...payload, refreshError: failure }
}

/**
 * Build the payload every read and every selection mutation returns.
 *
 * `effective` and the cost figures come from `computeVisibility` — the single
 * authority documented in CONTRACT §4 — so the panel never re-derives them.
 */
export async function buildStatus(deps, sessionId) {
  const state = await latestState(deps)
  const selection = effectiveSelection(state, sessionId)
  const skills = await skillsFor(deps, sessionId)
  const visibility = computeVisibility(state, sessionId, skills)
  return {
    ok: true,
    state,
    selection,
    effective: visibility.effective,
    maskedCount: visibility.maskedCount,
    catalogChars: visibility.catalogChars,
    catalogTokens: visibility.catalogTokens,
    skills,
  }
}

// --- HTTP plumbing ----------------------------------------------------------

function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    const viaGet = ctx.get(name)
    if (viaGet !== undefined) return viaGet
  }
  return ctx[name]
}

function json(res, status, payload) {
  if (res === undefined || res === null || res.writableEnded || res.destroyed) return
  try {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  } catch {
    // The socket went away mid-write; nothing useful is left to do.
  }
}

function fail(res, error) {
  const expected = error instanceof SkillGroupError
  json(res, expected ? error.status : 500, {
    ok: false,
    code: expected ? error.code : 'internal',
    error: error instanceof Error ? error.message : String(error),
  })
}

/** Collect the request body under a hard byte ceiling. Never throws. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settle({ error: new SkillGroupError('body.too-large', 'request body is too large', 413) })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        settle({ value: {} })
        return
      }
      try {
        const parsed = JSON.parse(text)
        settle({ value: isRecord(parsed) ? parsed : {} })
      } catch {
        settle({ error: new SkillGroupError('body.invalid-json', 'request body is not valid JSON') })
      }
    })
    req.on('error', () => {
      settle({ error: new SkillGroupError('body.read-failed', 'request body could not be read') })
    })
    req.on('aborted', () => {
      settle({ error: new SkillGroupError('body.read-failed', 'request was aborted') })
    })
  })
}

function sessionOf(req) {
  const raw = req?.headers?.[SESSION_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}

const KNOWN_PATHS = new Set([
  '/state',
  '/apply',
  '/toggle',
  '/clear',
  '/undo',
  '/group/save',
  '/group/delete',
  '/group/member',
  '/group/reorder',
  '/policy',
  '/ui',
  '/export',
  '/import',
  '/rule/save',
  '/rule/delete',
])

const GET_PATHS = new Set(['/state', '/export'])

function requireString(value, field) {
  const text = trimmed(value)
  if (text === '') throw new SkillGroupError('body.invalid', `"${field}" is required`)
  return text
}

/**
 * Re-shape an error thrown by `state.js` into a route error.
 *
 * The mutators tag unknown groups with `code: 'group.not-found'` and would
 * otherwise surface as a 500.
 */
function wrapStateError(error) {
  if (error instanceof SkillGroupError) return error
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const status = code === 'group.not-found' ? 404 : (code === 'internal' ? 500 : 400)
  return new SkillGroupError(code, error instanceof Error ? error.message : String(error), status)
}

/**
 * Run one route's body and return its `{ ok: true, ... }` payload.
 *
 * `track(refreshFailure, payload)` attaches a refresh failure to the payload: by
 * the time it is called the mutation has already been persisted, so its failure
 * must not replace the result.
 */
async function dispatch(deps, { method, sub, body, sessionId, track }) {
  switch (`${method} ${sub}`) {
    case 'GET /state':
      return buildStatus(deps, sessionId)

    case 'POST /apply': {
      // "apply" = turn the group ON (legacy name kept for the composer chip).
      await setGroupToggle(sessionId, requireString(body.group, 'group'), true)
      return track(await refreshOne(deps, sessionId), await buildStatus(deps, sessionId))
    }

    case 'POST /toggle': {
      if (typeof body.enabled !== 'boolean') {
        throw new SkillGroupError('body.invalid', '"enabled" must be a boolean')
      }
      await setGroupToggle(sessionId, requireString(body.group, 'group'), body.enabled)
      return track(await refreshOne(deps, sessionId), await buildStatus(deps, sessionId))
    }

    case 'POST /clear': {
      await clearSelection(sessionId)
      return track(await refreshOne(deps, sessionId), await buildStatus(deps, sessionId))
    }

    case 'POST /undo': {
      await undo(sessionId)
      return track(await refreshOne(deps, sessionId), await buildStatus(deps, sessionId))
    }

    case 'POST /group/save': {
      const result = await saveGroup(body.group)
      return track(await refreshEvery(deps, sessionId), { ok: true, state: result.state, group: result.group })
    }

    case 'POST /group/delete': {
      const result = await deleteGroup(requireString(body.id, 'id'))
      return track(await refreshEvery(deps, sessionId), { ok: true, state: result.state, removed: result.removed })
    }

    case 'POST /group/reorder': {
      const result = await reorderGroups(body.ids)
      return track(await refreshEvery(deps, sessionId), { ok: true, state: result.state })
    }

    case 'POST /group/member': {
      if (typeof body.add !== 'boolean') {
        throw new SkillGroupError('body.invalid', '"add" must be a boolean')
      }
      const result = await setGroupMember(
        requireString(body.id, 'id'),
        requireString(body.skill, 'skill'),
        body.add,
      )
      return track(await refreshEvery(deps, sessionId), { ok: true, state: result.state, group: result.group })
    }

    case 'POST /policy': {
      const state = await setDefaultPolicy(body.defaultPolicy)
      return track(await refreshEvery(deps, sessionId), { ok: true, state })
    }

    case 'POST /ui': {
      const state = await setUiOptions(body)
      return track(await refreshOne(deps, sessionId), { ok: true, state })
    }

    case 'GET /export': {
      const state = await latestState(deps)
      return { ok: true, groups: state.groups, rules: state.rules }
    }

    case 'POST /import': {
      const state = await importDefinitions(body.groups, body.rules)
      return track(await refreshEvery(deps, sessionId), { ok: true, state })
    }

    case 'POST /rule/save': {
      const result = await saveRule(body.rule)
      return track(await refreshEvery(deps, sessionId), { ok: true, state: result.state, rule: result.rule })
    }

    case 'POST /rule/delete': {
      const result = await deleteRule(requireString(body.id, 'id'))
      return track(await refreshEvery(deps, sessionId), { ok: true, state: result.state, removed: result.removed })
    }

    default:
      // Unreachable: the caller validates the path and method pair first.
      throw new SkillGroupError('route.not-found', `no route for ${method} ${sub}`, 404)
  }
}

function createHandler(deps) {
  return async function handleSkillGroupRequest(req, res) {
    try {
      let pathname = '/'
      try {
        pathname = new URL(typeof req?.url === 'string' ? req.url : '/', 'http://localhost').pathname
      } catch {
        json(res, 400, { ok: false, code: 'route.invalid', error: 'unparseable request URL' })
        return
      }
      const trimmedPath = pathname.replace(/\/+$/, '')
      if (!trimmedPath.startsWith(ROUTE_PREFIX)) {
        json(res, 404, { ok: false, code: 'route.not-found', error: `unknown route ${pathname}` })
        return
      }
      const rest = trimmedPath.slice(ROUTE_PREFIX.length)
      const sub = rest === '' ? '/' : rest
      if (!KNOWN_PATHS.has(sub)) {
        json(res, 404, { ok: false, code: 'route.not-found', error: `unknown route ${pathname}` })
        return
      }

      const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
      if (method !== 'GET' && method !== 'POST') {
        json(res, 405, { ok: false, code: 'method.not-allowed', error: `${method} is not supported` })
        return
      }
      const wantsPost = !GET_PATHS.has(sub)
      if (wantsPost !== (method === 'POST')) {
        json(res, 405, {
          ok: false,
          code: 'method.not-allowed',
          error: `${sub} is ${wantsPost ? 'POST' : 'GET'}-only`,
        })
        return
      }

      let body = {}
      if (method === 'POST') {
        const read = await readBody(req)
        if (read.error !== undefined) {
          fail(res, read.error)
          return
        }
        body = read.value
      }

      const payload = await dispatch(deps, {
        method,
        sub,
        body,
        sessionId: sessionOf(req),
        track: attachRefresh,
      })
      json(res, 200, payload)
    } catch (error) {
      try {
        fail(res, error)
      } catch {
        // Nothing left to report to.
      }
    }
  }
}

/**
 * Register the HTTP route.
 *
 * @param {object} ctx  host context; only `webServer` and `effect` are touched
 * @param {object} deps `refresh`, `refreshAll`, `skillsFor`, `latestState`
 * @returns {() => void} disposer that unregisters the route
 */
export function registerSkillGroupApi(ctx, deps) {
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    try {
      ctx?.logger?.warn?.('skill-groups: webServer is unavailable; the HTTP API stays unmounted')
    } catch {
      // Logging is best-effort.
    }
    return () => {}
  }

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createHandler(deps ?? {}),
  }

  // Registration runs exactly once: a duplicate (kind, path) throws on the host,
  // so the effect path and the plain fallback must never both fire.
  let registered
  const registerOnce = () => {
    if (registered === undefined) registered = webServer.register(route)
    return registered
  }

  if (typeof ctx.effect === 'function') {
    try {
      const fromEffect = ctx.effect(() => registerOnce(), 'skill-groups: HTTP API')
      if (typeof fromEffect === 'function') return fromEffect
    } catch {
      // Fall through to a plain registration.
    }
  }
  registerOnce()
  return () => {
    if (typeof registered === 'function') registered()
    registered = undefined
  }
}

export default registerSkillGroupApi
