/**
 * End-to-end tests for the HTTP surface, driven through a fake Host context.
 *
 * This is the closest thing to a live test that does not require installing the
 * plugin: the real handler runs against a real `node:http` request/response
 * pair and the real state engine on a temporary DSH_HOME. Only the Cordis
 * services are faked.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'

let home
const ORIGINAL_HOME = process.env.DSH_HOME

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-groups-api-'))
  process.env.DSH_HOME = home
})

after(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_HOME
  await rm(home, { recursive: true, force: true })
})

const state = await import('../lib/state.js')
const api = await import('../lib/api.js')

const SKILLS = [
  { name: 'crypto-analyst', description: 'analyst', source: 'user-dsh', provider: 'filesystem' },
  { name: 'zhihu', description: 'zhihu', source: 'user-dsh', provider: 'filesystem' },
  { name: 'freqtrade-backtest', description: 'backtest', source: 'project-dsh', provider: 'filesystem' },
  { name: 'untracked-skill', description: 'loose', source: 'user-dsh', provider: 'filesystem' },
]

/** Build a fake ctx exposing just the services registerSkillGroupApi touches. */
function fakeCtx() {
  const registered = []
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : () => {}
      registered.push(wrapped)
      return wrapped
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            registered.push(() => {})
            ctx.__route = route
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

function fakeDeps(visibility) {
  const calls = []
  return {
    calls,
    async refresh(sessionId) { calls.push(['refresh', sessionId]); return visibility },
    async refreshAll() { calls.push(['refreshAll']) },
    async skillsFor() { return SKILLS },
    async latestState() { return state.loadState() },
  }
}

/** Drive the registered handler with a real Node req/res pair. */
async function call(route, method, path, { body, session = 'sess-1' } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  req.method = method
  req.url = path
  req.headers = {
    'x-dsh-skill-groups-session': session,
    'content-type': 'application/json',
  }
  const chunks = []
  const res = {
    statusCode: 0,
    headers: undefined,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this },
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
    setHeader() {},
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, json: text === '' ? undefined : JSON.parse(text) }
}

async function setup(groups = []) {
  await state.saveState({ ...state.defaultState(), groups })
  const ctx = fakeCtx()
  const deps = fakeDeps()
  api.registerSkillGroupApi(ctx, deps)
  return { route: ctx.__route, deps }
}

describe('route registration', () => {
  it('registers a prefix route at the contracted path', async () => {
    const { route } = await setup()
    assert.equal(route.path, api.ROUTE_PREFIX)
    assert.equal(route.kind, 'prefix')
  })
})

describe('status and switching', () => {
  it('reports groups, skills, and cost through GET /state', async () => {
    const { route } = await setup([
      { id: 'g-research', name: '研究', kind: 'exclusive', members: ['crypto-analyst', 'zhihu'], enabled: true },
      { id: 'g-code', name: '编码', kind: 'exclusive', members: ['freqtrade-backtest'], enabled: true },
    ])
    const { status, json } = await call(route, 'GET', '/api/skill-groups/state')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.state.groups.length, 2)
    assert.equal(json.skills.length, 4)
    assert.equal(typeof json.catalogChars, 'number')
    assert.ok(json.catalogTokens >= 0)
  })

  it('switches groups and refreshes exactly that session', async () => {
    const { route, deps } = await setup([
      { id: 'g-research', name: '研究', members: ['crypto-analyst'] },
    ])
    const { status, json } = await call(route, 'POST', '/api/skill-groups/apply', { body: { group: '研究' } })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(json.selection.activeIds, ['g-research'])
    assert.ok(deps.calls.some(([kind, id]) => kind === 'refresh' && id === 'sess-1'))
    assert.deepEqual((await state.loadState()).sessions['sess-1'].activeIds, ['g-research'])
  })

  it('rejects a switch to an unknown group without writing state', async () => {
    const { route } = await setup([])
    const { status, json } = await call(route, 'POST', '/api/skill-groups/apply', { body: { group: '不存在' } })
    assert.ok(status >= 400, `expected a 4xx, got ${status}`)
    assert.equal(json.ok, false)
    assert.equal((await state.loadState()).sessions['sess-1'], undefined)
  })

  it('rejects a malformed apply body rather than throwing', async () => {
    const { route } = await setup([])
    const { status, json } = await call(route, 'POST', '/api/skill-groups/apply', { body: {} })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
    assert.equal(json.code, 'body.invalid')
  })

  it('clears and undoes through the API', async () => {
    const { route } = await setup([
      { id: 'g-research', name: '研究', members: ['crypto-analyst'] },
      { id: 'g-code', name: '编码', members: ['zhihu'] },
    ])
    await call(route, 'POST', '/api/skill-groups/apply', { body: { group: '研究' } })
    await call(route, 'POST', '/api/skill-groups/apply', { body: { group: '编码' } })

    const undone = await call(route, 'POST', '/api/skill-groups/undo', { body: {} })
    assert.deepEqual(undone.json.selection.activeIds, ['g-research'])

    const cleared = await call(route, 'POST', '/api/skill-groups/clear', { body: {} })
    assert.deepEqual(cleared.json.selection.activeIds, [])
    // clear removes the session override, so it now inherits the global default
    assert.equal((await state.loadState()).sessions['sess-1'], undefined)
  })

  it('toggles a group on and off', async () => {
    const { route } = await setup([
      { id: 'g-always', name: '常驻', members: ['crypto-analyst'] },
    ])
    const on = await call(route, 'POST', '/api/skill-groups/toggle', { body: { group: '常驻', enabled: true } })
    assert.deepEqual(on.json.selection.activeIds, ['g-always'])
    const off = await call(route, 'POST', '/api/skill-groups/toggle', { body: { group: '常驻', enabled: false } })
    assert.deepEqual(off.json.selection.activeIds, [])
  })

  it('returns a masked count that reflects the active group', async () => {
    const { route } = await setup([
      { id: 'g-research', name: '研究', kind: 'exclusive', members: ['crypto-analyst'], enabled: true },
      { id: 'g-code', name: '编码', kind: 'exclusive', members: ['zhihu', 'freqtrade-backtest'], enabled: true },
    ])
    const { json } = await call(route, 'POST', '/api/skill-groups/apply', { body: { group: '研究' } })
    // zhihu + freqtrade-backtest are in the inactive group and get masked.
    assert.equal(json.maskedCount, 2)
  })
})

describe('group management', () => {
  it('creates and updates a group', async () => {
    const { route } = await setup([])
    const created = await call(route, 'POST', '/api/skill-groups/group/save', {
      body: { group: { name: '新组', kind: 'exclusive', members: ['zhihu'] } },
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    assert.equal(created.json.group.name, '新组')

    const renamed = await call(route, 'POST', '/api/skill-groups/group/save', {
      body: { group: { id: created.json.group.id, name: '改名了', kind: 'additive', members: [] } },
    })
    assert.equal(renamed.json.group.name, '改名了')
    assert.equal(renamed.json.state.groups.length, 1)
  })

  it('adds and removes members', async () => {
    const { route } = await setup([
      { id: 'g-1', name: '组', kind: 'exclusive', members: [], enabled: true },
    ])
    await call(route, 'POST', '/api/skill-groups/group/member', { body: { id: 'g-1', skill: 'zhihu', add: true } })
    let loaded = await state.loadState()
    assert.deepEqual(loaded.groups[0].members, ['zhihu'])

    await call(route, 'POST', '/api/skill-groups/group/member', { body: { id: 'g-1', skill: 'zhihu', add: false } })
    loaded = await state.loadState()
    assert.deepEqual(loaded.groups[0].members, [])
  })

  it('deletes a group and drops it from the active selection', async () => {
    const { route } = await setup([
      { id: 'g-1', name: '组', members: ['zhihu'] },
    ])
    await call(route, 'POST', '/api/skill-groups/apply', { body: { group: 'g-1' } })
    await call(route, 'POST', '/api/skill-groups/group/delete', { body: { id: 'g-1' } })
    const loaded = await state.loadState()
    assert.equal(loaded.groups.length, 0)
    assert.ok(!loaded.sessions['sess-1']?.activeIds?.includes('g-1'))
  })

  it('persists the default policy and UI switches', async () => {
    const { route } = await setup([])
    await call(route, 'POST', '/api/skill-groups/policy', { body: { defaultPolicy: 'none' } })
    await call(route, 'POST', '/api/skill-groups/ui', { body: { composerChip: false } })
    const loaded = await state.loadState()
    assert.equal(loaded.defaultPolicy, 'none')
    assert.equal(loaded.ui.composerChip, false)
  })

  it('rejects an invalid default policy', async () => {
    const { route } = await setup([])
    const { status, json } = await call(route, 'POST', '/api/skill-groups/policy', { body: { defaultPolicy: 'bogus' } })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
  })

  it('round-trips export and import', async () => {
    const { route } = await setup([
      { id: 'g-1', name: '组', kind: 'exclusive', members: ['zhihu'], enabled: true },
    ])
    const exported = await call(route, 'GET', '/api/skill-groups/export')
    assert.equal(exported.json.ok, true)
    assert.equal(exported.json.groups.length, 1)

    const { json } = await call(route, 'POST', '/api/skill-groups/import', {
      body: { groups: [{ name: '导入组', kind: 'exclusive', members: ['zhihu'] }] },
    })
    assert.equal(json.ok, true)
    const names = json.state.groups.map((group) => group.name)
    assert.ok(names.includes('导入组'))
  })

  it('saves and deletes an auto rule', async () => {
    const { route } = await setup([
      { id: 'g-1', name: '组', kind: 'exclusive', members: ['zhihu'], enabled: true },
    ])
    const saved = await call(route, 'POST', '/api/skill-groups/rule/save', {
      body: { rule: { group: 'g-1', match: { workspace: 'paper', keywords: ['研究'] } } },
    })
    assert.equal(saved.json.ok, true)
    assert.equal(saved.json.state.rules.length, 1)

    const ruleId = saved.json.state.rules[0].id
    const deleted = await call(route, 'POST', '/api/skill-groups/rule/delete', { body: { id: ruleId } })
    assert.equal(deleted.json.state.rules.length, 0)
  })
})

describe('robustness', () => {
  it('answers an unknown sub-path with a 404 JSON body', async () => {
    const { route } = await setup([])
    const { status, json } = await call(route, 'GET', '/api/skill-groups/nope')
    assert.equal(status, 404)
    assert.equal(json.ok, false)
  })

  it('answers an unsupported method with a JSON error', async () => {
    const { route } = await setup([])
    const { status, json } = await call(route, 'DELETE', '/api/skill-groups/state')
    assert.ok(status >= 400)
    assert.equal(json.ok, false)
  })

  it('tolerates a missing session header', async () => {
    const { route } = await setup([{ id: 'g-1', name: '组', kind: 'exclusive', members: ['zhihu'], enabled: true }])
    const { status, json } = await call(route, 'GET', '/api/skill-groups/state', { session: '' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
  })

  it('keeps two sessions independent through the API', async () => {
    const { route } = await setup([
      { id: 'g-a', name: 'A', members: ['zhihu'] },
      { id: 'g-b', name: 'B', members: ['crypto-analyst'] },
    ])
    await call(route, 'POST', '/api/skill-groups/apply', { body: { group: 'A' }, session: 'one' })
    await call(route, 'POST', '/api/skill-groups/apply', { body: { group: 'B' }, session: 'two' })

    const one = await call(route, 'GET', '/api/skill-groups/state', { session: 'one' })
    const two = await call(route, 'GET', '/api/skill-groups/state', { session: 'two' })
    assert.deepEqual(one.json.selection.activeIds, ['g-a'])
    assert.deepEqual(two.json.selection.activeIds, ['g-b'])
  })
})
