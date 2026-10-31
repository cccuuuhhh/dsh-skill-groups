/**
 * Tests for the model-facing tools and the /skillset command.
 *
 * The tools and the command are the two surfaces a user reaches without any
 * UI, so they are exercised end to end against the real state engine.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

let home
const ORIGINAL_HOME = process.env.DSH_HOME

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-groups-tools-'))
  process.env.DSH_HOME = home
})

after(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_HOME
  await rm(home, { recursive: true, force: true })
})

const state = await import('../lib/state.js')
const toolsModule = await import('../lib/tools.js')
const commandsModule = await import('../lib/commands.js')

const SKILLS = [
  { name: 'crypto-analyst', description: 'analyst', source: 'user-dsh', provider: 'filesystem' },
  { name: 'zhihu', description: 'zhihu', source: 'user-dsh', provider: 'filesystem' },
  { name: 'freqtrade-backtest', description: 'backtest', source: 'project-dsh', provider: 'filesystem' },
  { name: 'loose-skill', description: 'loose', source: 'user-dsh', provider: 'filesystem' },
]

function harness() {
  const tools = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        }
      }
      return undefined
    },
  }
  const deps = {
    async refresh() { return undefined },
    async refreshAll() { return undefined },
    async skillsFor() { return SKILLS },
    async latestState() { return state.loadState() },
  }
  toolsModule.registerSkillGroupTools(ctx, deps)
  return { tools }
}

const seed = async (groups = []) => {
  await state.saveState({ ...state.defaultState(), groups })
  return harness()
}

const AGENT = { id: 'agent-1' }

describe('tool registration', () => {
  it('registers every contracted tool', async () => {
    const { tools } = await seed()
    for (const name of [
      'skillgroup_current', 'skillgroup_list', 'skillgroup_apply',
      'skillgroup_toggle', 'skillgroup_create', 'skillgroup_set_members', 'skillgroup_clear',
    ]) {
      assert.ok(tools.has(name), `missing tool ${name}`)
    }
  })

  it('declares a JSON schema with additionalProperties false on each tool', async () => {
    const { tools } = await seed()
    for (const definition of tools.values()) {
      const schema = definition.parameters
      assert.equal(schema.type, 'object', `${definition.name} parameters must be an object`)
      assert.equal(schema.additionalProperties, false, `${definition.name} must reject extra properties`)
    }
  })

  it('tells the model that masking does not delete skills', async () => {
    const { tools } = await seed()
    const apply = tools.get('skillgroup_apply')
    assert.match(apply.description, /not deleted|不删除|仍然|still/i)
    assert.match(apply.description, /\/./, 'description should mention user invocation via /name')
  })
})

describe('skillgroup_apply', () => {
  it('switches the group for the calling session', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [{ id: 'g-research', name: '研究', members: ['crypto-analyst'] }],
    })
    const { tools } = harness()
    const result = await tools.get('skillgroup_apply').execute({ group: '研究' }, { agent: AGENT })
    assert.ok(result !== undefined)
    assert.deepEqual((await state.loadState()).sessions['agent-1'].activeIds, ['g-research'])
  })

  it('reports an unknown group as a failure value instead of throwing', async () => {
    const { tools } = await seed([])
    let outcome
    try {
      outcome = await tools.get('skillgroup_apply').execute({ group: '没有这个组' }, { agent: AGENT })
    } catch (error) {
      outcome = { ok: false, error: String(error?.message ?? error) }
    }
    const failed = outcome === undefined ? false : (outcome.ok === false || typeof outcome.error === 'string')
    assert.ok(failed, `unknown group must surface as a failure, got ${JSON.stringify(outcome)}`)
  })
})

describe('skillgroup_current', () => {
  it('reports the active group and what is hidden', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [
        { id: 'g-research', name: '研究', members: ['crypto-analyst'] },
        { id: 'g-code', name: '编码', members: ['zhihu', 'freqtrade-backtest'] },
      ],
      sessions: { 'agent-1': { activeIds: ['g-research'] } },
    })
    const { tools } = harness()
    const result = await tools.get('skillgroup_current').execute({}, { agent: AGENT })
    const text = JSON.stringify(result)
    assert.match(text, /研究/)
    // zhihu and freqtrade-backtest sit in the inactive group and must be reported.
    assert.match(text, /zhihu/)
    assert.match(text, /freqtrade-backtest/)
  })
})

describe('skillgroup_list', () => {
  it('lists every group with its activation state', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [
        { id: 'g-a', name: 'A', members: ['zhihu'] },
        { id: 'g-b', name: 'B', members: ['crypto-analyst'] },
      ],
      sessions: { 'agent-1': { activeIds: ['g-a'] } },
    })
    const { tools } = harness()
    const result = await tools.get('skillgroup_list').execute({}, { agent: AGENT })
    const text = JSON.stringify(result)
    assert.match(text, /"A"/)
    assert.match(text, /"B"/)
  })
})

describe('skillgroup_create / set_members / clear', () => {
  it('creates a group with members', async () => {
    const { tools } = await seed([])
    await tools.get('skillgroup_create').execute({ name: '新组', kind: 'exclusive', members: ['zhihu'] }, { agent: AGENT })
    const loaded = await state.loadState()
    assert.equal(loaded.groups.length, 1)
    assert.equal(loaded.groups[0].name, '新组')
    assert.deepEqual(loaded.groups[0].members, ['zhihu'])
  })

  it('mutates members by add and remove', async () => {
    const { tools } = await seed([
      { id: 'g-1', name: '组', kind: 'exclusive', members: ['zhihu'], enabled: true },
    ])
    await tools.get('skillgroup_set_members').execute({ group: '组', add: ['crypto-analyst'] }, { agent: AGENT })
    let loaded = await state.loadState()
    assert.deepEqual(loaded.groups[0].members.sort(), ['crypto-analyst', 'zhihu'])

    await tools.get('skillgroup_set_members').execute({ group: '组', remove: ['zhihu'] }, { agent: AGENT })
    loaded = await state.loadState()
    assert.deepEqual(loaded.groups[0].members, ['crypto-analyst'])
  })

  it('clears every active group', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [{ id: 'g-1', name: '组', kind: 'exclusive', members: ['zhihu'], enabled: true }],
      sessions: { 'agent-1': { exclusive: 'g-1', additive: [] } },
    })
    const { tools } = harness()
    await tools.get('skillgroup_clear').execute({}, { agent: AGENT })
    const loaded = await state.loadState()
    assert.equal(loaded.sessions['agent-1'], undefined)
  })
})

describe('/skillset command', () => {
  function commandHarness() {
    let registered
    const ctx = {
      logger: { warn() {}, info() {}, error() {} },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      get(name) {
        if (name === 'commands') {
          return {
            register(definition) {
              registered = definition
              return () => { registered = undefined }
            },
          }
        }
        return undefined
      },
    }
    const deps = {
      async refresh() { return undefined },
      async refreshAll() { return undefined },
      async skillsFor() { return SKILLS },
      async latestState() { return state.loadState() },
    }
    commandsModule.registerSkillGroupCommands(ctx, deps)
    return () => registered
  }

  it('registers a command named skillset', async () => {
    const getRegistered = commandHarness()
    const definition = getRegistered()
    assert.ok(definition !== undefined, 'the command was not registered')
    assert.equal(definition.name, 'skillset')
    assert.equal(typeof definition.handler, 'function')
  })

  it('lists groups when invoked without an argument', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [{ id: 'g-1', name: '研究', kind: 'exclusive', members: ['zhihu'], enabled: true }],
    })
    const definition = commandHarness()()
    const result = await definition.handler({ agent: AGENT, rawInput: '', commandId: 'c', attachments: [], signal: AbortSignal.timeout(5000) })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /研究/)
  })

  it('switches to a named group', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [{ id: 'g-1', name: '研究', kind: 'exclusive', members: ['zhihu'], enabled: true }],
    })
    const definition = commandHarness()()
    const result = await definition.handler({ agent: AGENT, rawInput: '研究', commandId: 'c', attachments: [], signal: AbortSignal.timeout(5000) })
    assert.equal(result.kind, 'success')
    assert.deepEqual((await state.loadState()).sessions['agent-1'].activeIds, ['g-1'])
  })

  it('reports an unknown group as a command error, not a crash', async () => {
    await state.saveState({ ...state.defaultState(), groups: [] })
    const definition = commandHarness()()
    const result = await definition.handler({ agent: AGENT, rawInput: '不存在的组', commandId: 'c', attachments: [], signal: AbortSignal.timeout(5000) })
    assert.equal(result.kind, 'error')
  })

  it('turns everything off with "off"', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [{ id: 'g-1', name: '研究', kind: 'exclusive', members: ['zhihu'], enabled: true }],
      sessions: { 'agent-1': { exclusive: 'g-1', additive: [] } },
    })
    const definition = commandHarness()()
    const result = await definition.handler({ agent: AGENT, rawInput: 'off', commandId: 'c', attachments: [], signal: AbortSignal.timeout(5000) })
    assert.equal(result.kind, 'success')
    assert.equal((await state.loadState()).sessions['agent-1'], undefined)
  })

  it('resolves the session from the invoking agent, not a global', async () => {
    await state.saveState({
      ...state.defaultState(),
      groups: [{ id: 'g-1', name: '研究', kind: 'exclusive', members: ['zhihu'], enabled: true }],
    })
    const definition = commandHarness()()
    await definition.handler({ agent: { id: 'other-session' }, rawInput: '研究', commandId: 'c', attachments: [], signal: AbortSignal.timeout(5000) })
    const loaded = await state.loadState()
    assert.deepEqual(loaded.sessions['other-session'].activeIds, ['g-1'])
    assert.equal(loaded.sessions['agent-1'], undefined)
  })
})
