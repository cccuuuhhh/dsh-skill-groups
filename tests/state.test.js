/**
 * Contract tests for the state engine and visibility rule.
 *
 * These exercise the pure logic only — no host, no disk writes outside a
 * temporary DSH_HOME. Run with:
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'

let home
const ORIGINAL_HOME = process.env.DSH_HOME

// state.js resolves $DSH_HOME lazily on every call, so setting it before import
// is enough to keep the tests off the real profile.
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-groups-test-'))
  process.env.DSH_HOME = home
})

after(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_HOME
  await rm(home, { recursive: true, force: true })
})

const state = await import('../lib/state.js')

function summary(name, description = `about ${name}`) {
  return { name, description, source: 'user-dsh', provider: 'filesystem' }
}

function makeState(overrides = {}) {
  return {
    ...state.defaultState(),
    groups: [
      { id: 'g-research', name: '研究', members: ['crypto-analyst', 'zhihu'], note: '' },
      { id: 'g-code', name: '编码', members: ['freqtrade-backtest'], note: '' },
      { id: 'g-always', name: '常驻', members: ['openviking-memory'], note: '' },
    ],
    ...overrides,
  }
}

describe('state normalization', () => {
  it('degrades to defaults when the file is missing', async () => {
    const loaded = await state.loadState()
    assert.deepEqual(loaded.groups, [])
    assert.equal(loaded.defaultPolicy, 'all')
    assert.deepEqual(loaded.active.activeIds, [])
  })

  it('survives a corrupt state file instead of throwing', async () => {
    await mkdir(dirname(state.stateFilePath()), { recursive: true })
    await writeFile(state.stateFilePath(), '{ this is not json', 'utf8')
    const loaded = await state.loadState()
    assert.deepEqual(loaded.groups, [])
  })

  it('round-trips a saved state and drops malformed groups', async () => {
    const saved = await state.saveState(makeState({
      groups: [
        { id: 'g-1', name: 'ok', members: ['a', 'b'], note: '' },
        { name: '   ' },
        'nonsense',
        { id: 'g-2', name: 'second', members: ['c'], note: 'note' },
      ],
    }))
    assert.equal(saved.groups.length, 2)
    assert.deepEqual(saved.groups[0].members, ['a', 'b'])
    assert.equal(saved.groups[1].name, 'second')
    assert.equal(saved.groups[0].kind, undefined, 'kind is gone from the model')
    const reread = await state.loadState()
    assert.deepEqual(reread.groups.map((g) => g.id), ['g-1', 'g-2'])
  })

  it('migrates a legacy v1 exclusive/additive selection into activeIds', () => {
    const normalized = state.normalizeState({
      version: 1,
      groups: [
        { id: 'g-a', name: 'A', kind: 'exclusive', members: ['x'], enabled: true },
        { id: 'g-b', name: 'B', kind: 'additive', members: ['y'], enabled: true },
      ],
      active: { exclusive: 'g-a', additive: ['g-b'] },
    })
    assert.deepEqual(normalized.active.activeIds, ['g-a', 'g-b'])
    assert.equal(normalized.groups[0].kind, undefined)
  })

  it('caps the history at the documented limit', async () => {
    const history = Array.from({ length: 90 }, (_, index) => ({
      at: index, action: 'toggle', group: 'g-1', before: [],
    }))
    const saved = await state.saveState(makeState({ history }))
    assert.equal(saved.history.length, state.HISTORY_LIMIT)
    assert.equal(saved.history.at(-1).at, 89)
  })

  it('writes a document that is valid JSON on disk', async () => {
    await state.saveState(makeState())
    const text = await readFile(state.stateFilePath(), 'utf8')
    assert.doesNotThrow(() => JSON.parse(text))
    assert.equal(JSON.parse(text).version, state.STATE_VERSION)
  })
})

describe('visibility rule', () => {
  const skills = ['crypto-analyst', 'zhihu', 'freqtrade-backtest', 'openviking-memory', 'untracked-skill']

  it('keeps ungrouped skills visible under defaultPolicy all', () => {
    const visibility = state.computeVisibility(makeState(), 's1', skills.map((n) => summary(n)))
    const byName = Object.fromEntries(visibility.effective.map((entry) => [entry.name, entry]))
    assert.equal(byName['untracked-skill'].visible, true)
    assert.equal(byName['untracked-skill'].reason, 'ungrouped')
  })

  it('hides skills of inactive groups and keeps user invocation honest', () => {
    const withSelection = makeState({ active: { activeIds: ['g-research'] } })
    const visibility = state.computeVisibility(withSelection, 's1', skills.map((n) => summary(n)))
    const byName = Object.fromEntries(visibility.effective.map((entry) => [entry.name, entry]))
    assert.equal(byName['crypto-analyst'].visible, true)
    assert.equal(byName['freqtrade-backtest'].visible, false)
    assert.equal(byName['freqtrade-backtest'].reason, 'inactive-group')
    assert.equal(byName['freqtrade-backtest'].group, '编码')
  })

  it('unions every active group', () => {
    const withSelection = makeState({ active: { activeIds: ['g-research', 'g-always'] } })
    const visibility = state.computeVisibility(withSelection, 's1', skills.map((n) => summary(n)))
    const visible = visibility.effective.filter((entry) => entry.visible).map((entry) => entry.name)
    assert.deepEqual(visible.sort(), ['crypto-analyst', 'openviking-memory', 'untracked-skill', 'zhihu'])
  })

  it('combines three active groups with no exclusivity', () => {
    const withSelection = makeState({ active: { activeIds: ['g-research', 'g-code', 'g-always'] } })
    const visibility = state.computeVisibility(withSelection, 's1', skills.map((n) => summary(n)))
    const visible = visibility.effective.filter((entry) => entry.visible).map((entry) => entry.name)
    assert.deepEqual(visible.sort(), ['crypto-analyst', 'freqtrade-backtest', 'openviking-memory', 'untracked-skill', 'zhihu'])
  })

  it('hides ungrouped skills when the default policy is none', () => {
    const strict = makeState({ active: { activeIds: ['g-research'] }, defaultPolicy: 'none' })
    const visibility = state.computeVisibility(strict, 's1', skills.map((n) => summary(n)))
    const byName = Object.fromEntries(visibility.effective.map((entry) => [entry.name, entry]))
    assert.equal(byName['untracked-skill'].visible, false)
    assert.equal(byName['untracked-skill'].reason, 'policy-none')
  })

  it('counts catalog cost only for visible entries and caps descriptions', () => {
    const long = 'x'.repeat(900)
    const withSelection = makeState({ active: { activeIds: ['g-research'] } })
    const visibility = state.computeVisibility(
      withSelection,
      's1',
      [summary('crypto-analyst'), summary('freqtrade-backtest', long)],
    )
    // 500-char cap: 'crypto-analyst' (14) + desc (17) + 4; the long one is hidden.
    assert.equal(visibility.catalogChars, 14 + 'about crypto-analyst'.length + 4)
    assert.equal(visibility.catalogTokens, Math.ceil(visibility.catalogChars / 4))
    assert.equal(visibility.maskedCount, 1)
  })

  it('prefers a session override over the global active set', () => {
    const base = makeState({ active: { activeIds: ['g-research'] } })
    base.sessions.s2 = { activeIds: ['g-code'] }
    assert.deepEqual(state.effectiveSelection(base, 's2').activeIds, ['g-code'])
    assert.deepEqual(state.effectiveSelection(base, 'other').activeIds, ['g-research'])
  })
})

describe('mutations', () => {
  it('turns a group on without disturbing the others', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    let loaded = await state.loadState()
    assert.deepEqual(loaded.sessions.s1.activeIds, ['g-research'])

    await state.setGroupActive('s1', '编码', true)
    loaded = await state.loadState()
    assert.deepEqual(loaded.sessions.s1.activeIds, ['g-research', 'g-code'])
  })

  it('lets the user compose any combination of groups', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    await state.setGroupActive('s1', '常驻', true)
    await state.setGroupActive('s1', '编码', true)
    const loaded = await state.loadState()
    assert.deepEqual(loaded.sessions.s1.activeIds.sort(), ['g-always', 'g-code', 'g-research'])
  })

  it('turns a group off without touching the others', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    await state.setGroupActive('s1', '常驻', true)
    await state.setGroupActive('s1', '研究', false)
    const loaded = await state.loadState()
    assert.deepEqual(loaded.sessions.s1.activeIds, ['g-always'])
  })

  it('isolates sessions from each other', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    await state.setGroupActive('s2', '编码', true)
    const loaded = await state.loadState()
    assert.deepEqual(loaded.sessions.s1.activeIds, ['g-research'])
    assert.deepEqual(loaded.sessions.s2.activeIds, ['g-code'])
  })

  it('clears a session by removing its override so it falls back to global', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    await state.setGroupActive('s1', '常驻', true)
    await state.clearSelection('s1')
    const loaded = await state.loadState()
    // The override is gone, so the session inherits the global default.
    assert.equal(loaded.sessions.s1, undefined)
    assert.deepEqual(state.effectiveSelection(loaded, 's1').activeIds, loaded.active.activeIds)
  })

  it('clear falls back to a configured global default rather than an empty set', async () => {
    const withDefault = makeState({ active: { activeIds: ['g-always'] } })
    await state.saveState(withDefault)
    await state.setGroupActive('s1', '研究', true)
    await state.clearSelection('s1')
    const loaded = await state.loadState()
    const selection = state.effectiveSelection(loaded, 's1')
    assert.deepEqual(selection.activeIds, ['g-always'])
  })

  it('undoes the last switch only', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    await state.setGroupActive('s1', '编码', true)
    const { restored } = await state.undo('s1')
    assert.ok(restored !== null)
    const loaded = await state.loadState()
    assert.deepEqual(loaded.sessions.s1.activeIds, ['g-research'])
  })

  it('reports an unknown group instead of writing a dangling selection', async () => {
    await state.saveState(makeState())
    await assert.rejects(() => state.setGroupActive('s1', '不存在的组', true), /unknown skill group/)
    const loaded = await state.loadState()
    assert.equal(loaded.sessions.s1, undefined)
  })

  it('expires a temporary selection once its turn has passed', async () => {
    await state.saveState(makeState())
    await state.setGroupActive('s1', '研究', true)
    await state.setSessionSelection('s1', { activeIds: ['g-research'], untilTurn: 3 })
    await state.expireSession('s1', 2)
    assert.deepEqual((await state.loadState()).sessions.s1.activeIds, ['g-research'])
    await state.expireSession('s1', 3)
    assert.equal((await state.loadState()).sessions.s1, undefined)
  })
})

describe('auto rules', () => {
  it('matches on workspace, preset, and keywords together', () => {
    const withRules = makeState({
      rules: [
        { id: 'r-1', group: 'g-research', match: { workspace: 'paper', preset: '', keywords: [] } },
        { id: 'r-2', group: 'g-code', match: { workspace: '', preset: 'standard', keywords: ['backtest'] } },
      ],
    })
    assert.deepEqual(state.matchRules(withRules, { workspace: 'F:/workspace/paper', preset: 'other' }), ['g-research'])
    assert.deepEqual(state.matchRules(withRules, { workspace: 'F:/x', preset: 'standard', text: 'run a Backtest' }), ['g-code'])
    assert.deepEqual(state.matchRules(withRules, { workspace: 'F:/x', preset: 'standard', text: 'hi' }), [])
  })

  it('ignores rules pointing at a deleted group', () => {
    const withRules = makeState({
      rules: [{ id: 'r-1', group: 'g-gone', match: { workspace: 'paper', preset: '', keywords: [] } }],
    })
    assert.deepEqual(state.matchRules(withRules, { workspace: 'paper' }), [])
  })
})
