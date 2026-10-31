/**
 * The mask engine: hides a skill from the model without touching the disk.
 *
 * Host merge semantics the engine relies on (both verified in `dsh-skill`):
 *   - within one layer, duplicates resolve to the lowest numeric rank;
 *   - across layers, a nearer scope layer OVERWRITES the global layer outright,
 *     with no rank comparison at all (`collectFresh` does a plain `merged.set`
 *     per layer, global first).
 *
 * Masking uses the second rule: the shim provider is registered into the
 * AGENT's own scope, so for that session it shadows the global filesystem
 * entries by proximity. `MASK_RANK` is only a tiebreaker for the case where a
 * preset registers skills into that same scope layer.
 *
 * The shim carries content captured from the real provider (the host offers no
 * way to read a shadowed copy), so a masked skill's body is never invented —
 * `/skillname` still loads exactly what the skill says.
 *
 * Because the shim lives in the agent's scope, two sessions can hold different
 * groups at the same time.
 */

import { computeVisibility } from './state.js'

/**
 * Rank used only to break ties *within* one scope layer.
 *
 * Masking does not depend on this value: the shim is registered into the
 * agent's own scope, and a nearer scope layer overwrites the global layer
 * outright with no rank comparison (see the header note). Kept below the
 * project root rank (100) so that, if a preset registers skills into the same
 * scope layer, the shim still wins.
 */
export const MASK_RANK = 50
/** Prefix for the shim provider's diagnostic name. */
export const MASK_PROVIDER = 'skill-groups-mask'

/**
 * @typedef {object} MaskRuntime
 * @property {Map<string, Set<string>>} maskedBySession  session id -> masked skill names
 * @property {Map<string, object>} definitions           skill name -> captured SkillDefinition
 * @property {Map<string, {invalidate: () => void}>} controls session id -> registration control
 * @property {Map<string, string>} providerNames         session id -> provider name used for it
 */

export function createMaskRuntime() {
  return {
    maskedBySession: new Map(),
    definitions: new Map(),
    controls: new Map(),
    providerNames: new Map(),
    sequence: 0,
  }
}

function shimCandidate(definition, name, providerName) {
  return {
    name,
    description: definition.description,
    ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
    invocation: { modelInvocable: false, userInvocable: true },
    source: definition.source,
    provider: providerName,
    rank: MASK_RANK,
    ...(definition.path !== undefined ? { path: definition.path } : {}),
    locator: { name },
  }
}

/**
 * Capture the real content of every skill any group references.
 *
 * Capture happens against the unmasked catalog: callers must refresh before a
 * mask is installed, otherwise `get` would read back the shim it is replacing.
 */
export async function captureDefinitions(ctx, state, skills, cwd) {
  const names = new Set()
  for (const group of state.groups) for (const member of group.members) names.add(member)
  const captured = new Map()
  for (const name of names) {
    try {
      const definition = await skills.get(name, { cwd })
      if (definition !== undefined && typeof definition.content === 'string') captured.set(name, definition)
    } catch {
      // A skill that vanished simply cannot be masked; it also does not need to be.
    }
  }
  return captured
}

/**
 * Build the provider a session registers to hide its inactive groups' skills.
 *
 * The provider name is unique per mount. The registry rejects a duplicate name
 * within one scope, and a remount (plugin reload, or an agent re-created with
 * the same id) can race the previous registration's disposal. A unique name
 * makes a remount always bind, and the stale registration is harmless because
 * it is disposed with its own fiber.
 */
export function createMaskProvider(sessionId, runtime) {
  const providerName = runtime.providerNames.get(sessionId) ?? MASK_PROVIDER
  return {
    name: providerName,
    async list() {
      const masked = runtime.maskedBySession.get(sessionId) ?? new Set()
      const candidates = []
      for (const name of masked) {
        const definition = runtime.definitions.get(name)
        if (definition === undefined) continue
        candidates.push(shimCandidate(definition, name, providerName))
      }
      return { candidates, complete: true }
    },
    async get(candidate) {
      const definition = runtime.definitions.get(candidate.name)
      if (definition === undefined) return undefined
      return {
        name: definition.name,
        description: definition.description,
        ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
        invocation: { modelInvocable: false, userInvocable: true },
        source: definition.source,
        provider: providerName,
        content: definition.content,
        ...(definition.resourceBase !== undefined ? { resourceBase: definition.resourceBase } : {}),
        ...(definition.path !== undefined ? { path: definition.path } : {}),
        ...(definition.metadata !== undefined ? { metadata: definition.metadata } : {}),
      }
    },
  }
}

/**
 * Recompute one session's masked set, refresh captured content, and push the
 * change into the registry cache so the next model step sees it.
 */
export async function refreshSession(state, skills, runtime, sessionId, cwd) {
  let summaries = []
  try {
    summaries = await skills.list({ cwd })
  } catch {
    summaries = []
  }
  const visibility = computeVisibility(state, sessionId, summaries)
  const masked = new Set()
  for (const entry of visibility.effective) if (!entry.visible) masked.add(entry.name)
  runtimeSet(runtime, sessionId, masked)
  return visibility
}

function runtimeSet(runtime, sessionId, masked) {
  runtime.maskedBySession.set(sessionId, masked)
  const control = runtime.controls.get(sessionId)
  if (control !== undefined && typeof control.invalidate === 'function') {
    try {
      control.invalidate()
    } catch {
      // The registration may already be disposed; the next mount refreshes again.
    }
  }
}

/**
 * Register the shim provider into one agent's skill scope.
 *
 * `skills` must be the agent-scoped traceable service (obtained from
 * `agent.ctx.get('skills')`): `registerProvider` files the registration under
 * the scope of its own `this.ctx`, so the mask follows that session alone.
 * Passing a process-global service would mask every session at once.
 */
export function mountSessionSkillMask(skills, runtime, sessionId) {
  if (skills === undefined || typeof skills.registerProvider !== 'function') return () => {}
  runtime.sequence += 1
  runtime.providerNames.set(sessionId, `${MASK_PROVIDER}-${runtime.sequence}`)
  let dispose
  try {
    dispose = skills.registerProvider((control) => {
      runtime.controls.set(sessionId, control)
      if (control.signal !== undefined && typeof control.signal.addEventListener === 'function') {
        control.signal.addEventListener('abort', () => {
          if (runtime.controls.get(sessionId) === control) runtime.controls.delete(sessionId)
        }, { once: true })
      }
      return createMaskProvider(sessionId, runtime)
    })
  } catch (error) {
    // A mask is an optimisation for the model's context: if the registration
    // cannot bind, the session keeps the full catalog rather than failing.
    runtime.controls.delete(sessionId)
    runtime.maskedBySession.delete(sessionId)
    runtime.providerNames.delete(sessionId)
    return () => {}
  }
  return () => {
    runtime.controls.delete(sessionId)
    runtime.maskedBySession.delete(sessionId)
    runtime.providerNames.delete(sessionId)
    if (typeof dispose === 'function') dispose()
  }
}
