/**
 * The `/skillset` slash command.
 *
 * One command, several forms, because a slash command is the only surface a user
 * reaches while typing a prompt:
 *
 *   /skillset                 list every group and the current state
 *   /skillset <name|id>       turn that group on (groups are peers; combining is allowed)
 *   /skillset off             clear every switch
 *   /skillset add <name>      turn a group on (alias)
 *   /skillset rm <name>       turn a group off
 *
 * A `--for-turn` suffix asks for temporary semantics: the selection is parked on
 * the session with `untilTurn`, which `index.js` expires after that turn stops.
 * The turn number is read off the session log. When it cannot be determined the
 * command performs an ordinary persistent switch and says so in its own reply,
 * rather than pretending the temporary semantics applied.
 */

import {
  clearSelection,
  effectiveSelection,
  findGroup,
  loadState,
  setGroupActive,
  setSessionSelection,
} from './state.js'
import { buildStatus, SkillGroupError } from './api.js'

/** The flag that makes a switch last for a single turn. */
const FOR_TURN_FLAG = '--for-turn'

const ADD_VERBS = new Set(['add', 'on', 'enable'])
const RM_VERBS = new Set(['rm', 'remove', 'disable'])
const CLEAR_VERBS = new Set(['off', 'clear', 'reset', 'none'])

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(text) {
  return { kind: 'error', text }
}

function successText(text) {
  return { kind: 'success', text }
}

/** Short, stable session label: long enough to tell sessions apart in a reply. */
function sessionLabel(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return '全局默认'
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`
}

/** The acting session id from a command invocation, or '' for the global default. */
function sessionOf(invocation) {
  const agent = invocation?.agent
  if (agent === undefined || agent === null) return ''
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  const session = agent.session
  if (session !== undefined && session !== null && typeof session.id === 'string') return session.id
  return ''
}

/** Resolve a group reference: id, exact name, then case-insensitive name. */
function resolveGroup(state, ref) {
  const group = findGroup(state, ref)
  if (group !== undefined) return group
  const lowered = String(ref).toLowerCase()
  return state.groups.find((entry) => entry.name.toLowerCase() === lowered)
}

function groupNames(state) {
  return state.groups.map((group) => group.name)
}

/**
 * Determine the turn a `--for-turn` selection should expire after.
 *
 * Reading the session log is the only way to learn the counter — the host
 * exposes no `agent.turn`. The last turn boundary decides:
 *   - `turn/end` N   → the next turn is N+1, so expire after N+1;
 *   - `turn/start` N → turn N is open, so the switch applies inside it and must
 *     expire when N ends.
 *
 * @returns {number|undefined} the expiry turn, or undefined when the log cannot
 *   be read (the caller then falls back to a persistent switch).
 */
function expiryTurnOf(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return undefined
  let events
  try {
    if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (Array.isArray(session.log)) events = session.log
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || !isRecord(event.data)) continue
    if (typeof event.data.turn !== 'number') continue
    if (event.type === 'turn/end') return event.data.turn + 1
    if (event.type === 'turn/start') return event.data.turn
  }
  // A session with no turn boundary yet: the first turn is 1.
  return 1
}

/** Render the current state plus every group as a plain-text table. */
function renderList(state, status, sessionId) {
  const nameOf = (id) => (typeof id === 'string' && id !== '' ? (findGroup(state, id)?.name ?? id) : null)
  const activeIds = new Set(Array.isArray(status.selection.activeIds) ? status.selection.activeIds : [])
  const active = [...activeIds].map((id) => nameOf(id)).filter((name) => name !== null)
  const untilTurn = typeof status.selection.untilTurn === 'number' ? status.selection.untilTurn : undefined
  const total = Array.isArray(status.effective) ? status.effective.length : 0
  const masked = typeof status.maskedCount === 'number' ? status.maskedCount : 0
  const tokens = typeof status.catalogTokens === 'number' ? status.catalogTokens : 0
  const chars = typeof status.catalogChars === 'number' ? status.catalogChars : 0

  const lines = []
  lines.push(`技能组状态（会话 ${sessionLabel(sessionId)}）`)
  lines.push(`  已激活　：${active.length === 0 ? '（无）' : active.join('、')}`)
  lines.push(`  默认策略：未归组技能${state.defaultPolicy === 'all' ? '保持可见 (all)' : '隐藏 (none)'}`)
  lines.push(`  技能目录：${total - masked} 可见 / ${total} 总数，隐藏 ${masked} 个，约 ${tokens} tokens（${chars} 字符）`)
  if (untilTurn !== undefined) lines.push(`  临时生效：第 ${untilTurn} 轮结束后自动取消`)

  if (state.groups.length === 0) {
    lines.push('')
    lines.push('还没有任何技能组。请先在侧边栏面板中新建一个组。')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('  组名                    技能数  状态')
  for (const group of state.groups) {
    const marker = activeIds.has(group.id) ? '● 生效' : '○ 未激活'
    const name = group.name.length >= 20 ? `${group.name.slice(0, 19)}…` : group.name.padEnd(20, ' ')
    const count = String(group.members.length).padStart(4, ' ')
    lines.push(`  ${name}  ${count}   ${marker}`)
  }
  lines.push('')
  lines.push('开启：/skillset <组名>　关闭全部：/skillset off　增减：/skillset add|rm <组名>')
  lines.push('只对下一轮生效：在上面的任意切换后加 --for-turn')
  return lines.join('\n')
}

/** Split `rawInput` into positional tokens, pulling out the `--for-turn` flag. */
function parseRawInput(rawInput) {
  const tokens = []
  let forTurn = false
  for (const token of trimmed(rawInput).split(/\s+/)) {
    if (token === '') continue
    if (token === FOR_TURN_FLAG) {
      forTurn = true
      continue
    }
    tokens.push(token)
  }
  return { tokens, forTurn }
}

/** Compose the session's next selection for a `--for-turn` switch. */
function composeTemporary(state, sessionId, group) {
  const current = effectiveSelection(state, sessionId)
  return { activeIds: [...new Set([...current.activeIds, group.id])] }
}

/**
 * Register `/skillset`.
 *
 * @param {object} ctx  host context; only `commands` and `effect` are touched
 * @param {object} deps `refresh`, `refreshAll`, `skillsFor`, `latestState`
 * @returns {() => void} disposer that unregisters the command
 */
export function registerSkillGroupCommands(ctx, deps) {
  const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : ctx?.commands
  if (commands === undefined || typeof commands.register !== 'function') {
    try {
      ctx?.logger?.warn?.('skill-groups: commands is unavailable; /skillset stays unregistered')
    } catch {
      // Logging is best-effort.
    }
    return () => {}
  }

  const resolved = deps ?? {}

  /**
   * Push a saved selection into the catalogue for one session.
   *
   * The state file is already written by the time this runs, so a failure is
   * reported in the reply instead of being thrown: the switch did happen, and
   * claiming otherwise would be false. It is surfaced because a stale catalogue
   * means the model still sees the old skills.
   *
   * @returns {Promise<string|undefined>} an error message when the push failed
   */
  const refreshOne = async (sessionId) => {
    if (typeof resolved.refresh !== 'function') return undefined
    try {
      await resolved.refresh(sessionId)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Append the refresh outcome to a reply so a stale catalogue is never silent. */
  const note = (text, failure) => (failure === undefined
    ? text
    : `${text}
注意：状态已保存，但技能目录刷新失败（${failure}），本轮模型可能仍看到旧的技能列表。`)

  const readStatus = (sessionId) => buildStatus(resolved, sessionId)

  const handler = async (invocation) => {
    const sessionId = sessionOf(invocation)
    const { tokens, forTurn } = parseRawInput(invocation?.rawInput)

    try {
      const state = await loadState()

      // --- no target: report -------------------------------------------------
      if (tokens.length === 0) {
        if (forTurn) {
          return errorText('用法：/skillset <组名> --for-turn —— --for-turn 需要一个要切换到的组')
        }
        return successText(renderList(state, await readStatus(sessionId), sessionId))
      }

      const verb = tokens[0].toLowerCase()
      const rest = tokens.slice(1).join(' ').trim()

      // --- clear -------------------------------------------------------------
      if (CLEAR_VERBS.has(verb) && rest === '') {
        if (forTurn) {
          return errorText('--for-turn 只用于切换；/skillset off 会立即关闭全部切换并持续生效。')
        }
        await clearSelection(sessionId)
        const clearFailure = await refreshOne(sessionId)
        return successText(note(`已关闭全部技能组切换。\n${renderList(state, await readStatus(sessionId), sessionId)}`,
          clearFailure))
      }

      // --- group on / off ----------------------------------------------------
      if (ADD_VERBS.has(verb) || RM_VERBS.has(verb)) {
        if (rest === '') return errorText(`用法：/skillset ${verb} <组名>`)
        if (forTurn) {
          // Expiry clears the whole override, so a one-turn toggle would either
          // vanish immediately or leave the rest of the selection behind. Refuse
          // instead of silently doing something the flag does not promise.
          return errorText('--for-turn 只支持开启（/skillset <组名> --for-turn）；增减请去掉该参数。')
        }
        const group = resolveGroup(state, rest)
        if (group === undefined) {
          return errorText(`找不到技能组「${rest}」。可用组：${groupNames(state).join('、') || '（无）'}`)
        }
        const enabled = ADD_VERBS.has(verb)
        await setGroupActive(sessionId, group.id, enabled)
        const toggleFailure = await refreshOne(sessionId)
        const verbText = enabled ? '已启用' : '已关闭'
        return successText(note(`${verbText}「${group.name}」。\n${renderList(state, await readStatus(sessionId), sessionId)}`,
          toggleFailure))
      }

      // --- switch (turn a group ON) ------------------------------------------
      const ref = tokens.join(' ')
      const group = resolveGroup(state, ref)
      if (group === undefined) {
        const names = groupNames(state)
        return errorText(names.length === 0
          ? `找不到技能组「${ref}」。还没有定义任何技能组，请先在侧边栏面板中新建。`
          : `找不到技能组「${ref}」。可用组：${names.join('、')}`)
      }

      if (!forTurn) {
        await setGroupActive(sessionId, group.id, true)
        const switchFailure = await refreshOne(sessionId)
        return successText(note(`已启用「${group.name}」（${group.members.length} 个技能）。`
          + `\n${renderList(state, await readStatus(sessionId), sessionId)}`, switchFailure))
      }

      const untilTurn = expiryTurnOf(invocation?.agent)
      if (untilTurn === undefined) {
        // No readable turn counter: say so, do not fake the semantics.
        await setGroupActive(sessionId, group.id, true)
        const degradedFailure = await refreshOne(sessionId)
        return successText(note(`已启用（本轮临时生效不可用，已改为持续生效）：「${group.name}」。`
          + '\n原因：无法从当前会话读取轮次计数（宿主未暴露可读的 turn 记录）。'
          + '\n该切换会一直生效，直到你再次切换或执行 /skillset off。'
          + `\n${renderList(state, await readStatus(sessionId), sessionId)}`, degradedFailure))
      }

      await setSessionSelection(sessionId, { ...composeTemporary(state, sessionId, group), untilTurn })
      const temporaryFailure = await refreshOne(sessionId)
      return successText(note(`已启用「${group.name}」，仅第 ${untilTurn} 轮生效，该轮结束后自动恢复。`
        + `\n${renderList(state, await readStatus(sessionId), sessionId)}`, temporaryFailure))
    } catch (error) {
      const code = error instanceof SkillGroupError
        ? error.code
        : (typeof error?.code === 'string' ? error.code : 'internal')
      const message = error instanceof Error ? error.message : String(error)
      return errorText(`/skillset 执行失败（${code}）：${message}`)
    }
  }

  const definition = {
    name: 'skillset',
    description:
      'Manage skill groups for this session: /skillset lists them, /skillset <group> turns a group on, '
      + '/skillset off clears them, /skillset add|rm <group> toggles a group, and a --for-turn suffix limits a '
      + 'switch to the next turn. Groups are peers, so combine any of them. Switching only changes which skills '
      + 'the model can discover; no skill is deleted and /skillname still works.',
    handler,
  }

  // A duplicate command name throws on the host, so register exactly once.
  let registered
  const registerOnce = () => {
    if (registered === undefined) registered = commands.register(definition)
    return registered
  }

  if (typeof ctx.effect === 'function') {
    try {
      const fromEffect = ctx.effect(() => registerOnce(), 'skill-groups: /skillset command')
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

export default registerSkillGroupCommands
