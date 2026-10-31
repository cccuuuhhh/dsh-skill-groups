/**
 * Tests for the mask engine against a simulated host skill registry.
 *
 * The simulation reproduces the two host rules the engine depends on:
 *   1. within one layer, duplicate names resolve to the lowest rank;
 *   2. a provider's `list()` output is validated and merged, and `get()`
 *      receives the winning candidate.
 *
 * This does not prove behaviour inside a live host — it proves the shim is
 * built from real content and wins the rank comparison. Live verification is
 * a separate, explicit step.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MASK_PROVIDER, MASK_RANK, createMaskProvider, createMaskRuntime, mountSessionSkillMask, refreshSession } from '../lib/mask.js'
import { defaultState } from '../lib/state.js'

/**
 * Faithful stand-in for the host registry's merge, which has two distinct
 * rules and they are easy to conflate:
 *
 *   1. WITHIN one layer, candidates sort by ascending rank and the first
 *      wins a duplicate name (`compareIndexedCandidates` + first-wins).
 *   2. ACROSS layers, a later (nearer) layer OVERWRITES an earlier one
 *      outright — rank is never compared across layers
 *      (`collectFresh` does a plain `merged.set` per layer).
 *
 * @param layers ordered farthest first, each an array of candidates.
 */
function simulateCatalog(layers) {
  const merged = new Map()
  for (const layer of layers) {
    const seen = new Set()
    for (const candidate of [...layer].sort((a, b) => a.rank - b.rank)) {
      if (seen.has(candidate.name)) continue
      seen.add(candidate.name)
      merged.set(candidate.name, candidate)
    }
  }
  return merged
}

function realCandidate(name, rank = 400) {
  return {
    name,
    description: `real ${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
    rank,
    locator: { name },
  }
}

const REAL = [
  realCandidate('crypto-analyst'),
  realCandidate('zhihu'),
  realCandidate('freqtrade-backtest', 100),
  realCandidate('untracked-skill'),
]

function definitionFor(name) {
  return {
    name,
    description: `real ${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
    content: `# ${name}\n\nreal body for ${name}`,
  }
}

function setup() {
  const runtime = createMaskRuntime()
  for (const candidate of REAL) runtime.definitions.set(candidate.name, definitionFor(candidate.name))
  runtime.maskedBySession.set('session-a', new Set(['crypto-analyst', 'freqtrade-backtest']))
  runtime.maskedBySession.set('session-b', new Set())
  return runtime
}

describe('mask provider', () => {
  it('outranks every filesystem root, including project skills', () => {
    // Project .dsh rank is 100, the lowest real root; the shim must beat it.
    assert.ok(MASK_RANK < 100, `MASK_RANK ${MASK_RANK} must be below the project rank 100`)
  })

  it('returns only the session it was built for', async () => {
    const runtime = setup()
    const a = await createMaskProvider('session-a', runtime).list()
    const b = await createMaskProvider('session-b', runtime).list()
    assert.equal(a.candidates.length, 2)
    assert.equal(b.candidates.length, 0)
    assert.deepEqual(a.candidates.map((c) => c.name).sort(), ['crypto-analyst', 'freqtrade-backtest'])
  })

  it('masks model invocation but keeps user invocation', async () => {
    const runtime = setup()
    const { candidates } = await createMaskProvider('session-a', runtime).list()
    for (const candidate of candidates) {
      assert.equal(candidate.invocation.modelInvocable, false)
      assert.equal(candidate.invocation.userInvocable, true)
      assert.ok(candidate.provider.startsWith(MASK_PROVIDER))
    }
  })

  it('gives each mount a unique provider name so a remount never collides', async () => {
    const runtime = createMaskRuntime()
    const skills = {
      registerProvider(create) {
        create({ invalidate() {}, signal: undefined })
        return () => {}
      },
    }
    mountSessionSkillMask(skills, runtime, 's1')
    const first = runtime.providerNames.get('s1')
    mountSessionSkillMask(skills, runtime, 's1')
    const second = runtime.providerNames.get('s1')
    assert.notEqual(first, second)
    assert.ok(first.startsWith(MASK_PROVIDER) && second.startsWith(MASK_PROVIDER))
  })

  it('degrades to no mask when the registration throws', async () => {
    const runtime = createMaskRuntime()
    const skills = {
      registerProvider() {
        throw new Error('a skill provider named "dup" is already registered in this scope')
      },
    }
    let dispose
    assert.doesNotThrow(() => { dispose = mountSessionSkillMask(skills, runtime, 's1') })
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
    assert.equal(runtime.controls.has('s1'), false)
  })

  it('wins the catalog and hides the skill from the model', async () => {
    const runtime = setup()
    const shim = await createMaskProvider('session-a', runtime).list()
    const winner = simulateCatalog([REAL, shim.candidates])

    assert.equal(winner.get('crypto-analyst').invocation.modelInvocable, false)
    assert.equal(winner.get('freqtrade-backtest').invocation.modelInvocable, false)
    // A skill this session did not mask keeps its real entry.
    assert.equal(winner.get('zhihu').invocation.modelInvocable, true)
    assert.equal(winner.get('untracked-skill').invocation.modelInvocable, true)
    // Nothing disappeared from the catalog — only its policy changed.
    assert.equal(winner.size, REAL.length)
  })

  it('serves the real body through get, never a stub', async () => {
    const runtime = setup()
    const provider = createMaskProvider('session-a', runtime)
    const { candidates } = await provider.list()
    const crypto = candidates.find((c) => c.name === 'crypto-analyst')
    const loaded = await provider.get(crypto)
    assert.equal(loaded.content, '# crypto-analyst\n\nreal body for crypto-analyst')
    assert.equal(loaded.invocation.modelInvocable, false)
    assert.equal(loaded.invocation.userInvocable, true)
  })

  it('drops a skill that vanished before capture instead of emitting a broken entry', async () => {
    const runtime = setup()
    runtime.definitions.delete('zhihu')
    runtime.maskedBySession.set('session-a', new Set(['zhihu', 'crypto-analyst']))
    const { candidates } = await createMaskProvider('session-a', runtime).list()
    assert.deepEqual(candidates.map((c) => c.name), ['crypto-analyst'])
  })

  it('keeps two sessions independent under one shared runtime', async () => {
    const runtime = setup()
    const a = await createMaskProvider('session-a', runtime).list()
    const b = await createMaskProvider('session-b', runtime).list()

    const catalogA = simulateCatalog([REAL, a.candidates])
    const catalogB = simulateCatalog([REAL, b.candidates])

    assert.equal(catalogA.get('crypto-analyst').invocation.modelInvocable, false)
    assert.equal(catalogB.get('crypto-analyst').invocation.modelInvocable, true)
  })
})

/**
 * refreshSession is the function index.js calls on every switch. It once
 * referenced an out-of-scope `runtime` and threw on every call, which no test
 * caught because only createMaskProvider was exercised. These guard that.
 */
describe('refreshSession', () => {
  function fakeSkills(names) {
    return {
      async list() {
        return names.map((name) => ({
          name,
          description: `real ${name}`,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh',
          provider: 'filesystem',
        }))
      },
    }
  }

  it('records the masked set for the session instead of throwing', async () => {
    const runtime = createMaskRuntime()
    const state = {
      ...defaultState(),
      groups: [
        { id: 'g-research', name: '研究', members: ['crypto-analyst'] },
        { id: 'g-code', name: '编码', members: ['zhihu', 'freqtrade-backtest'] },
      ],
      sessions: { s1: { activeIds: ['g-research'] } },
    }
    const skills = fakeSkills(['crypto-analyst', 'zhihu', 'freqtrade-backtest', 'loose'])
    const visibility = await refreshSession(state, skills, runtime, 's1', undefined)

    assert.ok(visibility !== undefined)
    const masked = runtime.maskedBySession.get('s1')
    assert.deepEqual([...masked].sort(), ['freqtrade-backtest', 'zhihu'])
  })

  it('produces a mask the provider then honours', async () => {
    const runtime = createMaskRuntime()
    for (const candidate of REAL) runtime.definitions.set(candidate.name, definitionFor(candidate.name))
    const state = {
      ...defaultState(),
      groups: [
        { id: 'g-research', name: '研究', members: ['crypto-analyst'] },
        { id: 'g-code', name: '编码', members: ['zhihu'] },
      ],
      sessions: { s1: { activeIds: ['g-research'] } },
    }
    await refreshSession(state, fakeSkills(REAL.map((c) => c.name)), runtime, 's1', undefined)
    const { candidates } = await createMaskProvider('s1', runtime).list()
    assert.deepEqual(candidates.map((c) => c.name), ['zhihu'])
  })

  it('invalidates the registration so the next step sees the change', async () => {
    const runtime = createMaskRuntime()
    let invalidated = 0
    runtime.controls.set('s1', { invalidate: () => { invalidated += 1 } })
    const state = {
      ...defaultState(),
      groups: [{ id: 'g-1', name: '组', members: ['a'] }],
      sessions: { s1: { activeIds: ['g-1'] } },
    }
    await refreshSession(state, fakeSkills(['a', 'b']), runtime, 's1', undefined)
    assert.equal(invalidated, 1)
  })

  it('survives a failing catalog read by masking nothing', async () => {
    const runtime = createMaskRuntime()
    const skills = { async list() { throw new Error('registry down') } }
    const state = { ...defaultState(), groups: [] }
    const visibility = await refreshSession(state, skills, runtime, 's1', undefined)
    assert.equal(visibility.maskedCount, 0)
  })
})
