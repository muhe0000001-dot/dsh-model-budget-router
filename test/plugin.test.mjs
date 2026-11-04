import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 插件会往 DSH_HOME/storages 写状态文件；测试指到临时目录。
process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'mbr-test-'))

const { apply, inject, name } = await import('../lib/index.js')

/** 支持 4 个假模型：flash 低/高、pro（纯文本）、以及一个不可用的 beta。 */
const CATALOG = {
  'deepseek-flash': { efforts: ['off', 'low', 'high'], modalities: ['text', 'image'] },
  'deepseek-v4-pro': { efforts: ['low', 'high', 'max'], modalities: ['text'] },
  'deepseek-v4-beta': null,
}

function makeHost({ catalog = CATALOG } = {}) {
  const listeners = new Map()
  const commands = []
  const resolveCalls = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(event, handler, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      // 与 cordis 一致：prepend 的监听器排在最前 = waterfall 最外层。
      if (options?.prepend === true) listeners.get(event).unshift(handler)
      else listeners.get(event).push(handler)
      return () => {}
    },
    get(service) {
      return service === 'commands' ? { register: (definition) => { commands.push(definition); return () => {} } } : undefined
    },
    effect(register) {
      const iterator = register()
      iterator.next()
      return () => {}
    },
    llm: {
      async resolveModelInfo(provider, model) {
        resolveCalls.push(`${provider}/${model}`)
        const entry = catalog[model]
        if (entry === undefined || entry === null) {
          const error = new Error(`unknown model ${model}`)
          error.code = 'INVALID_MODEL_INFO'
          throw error
        }
        return {
          provider,
          id: model,
          name: model,
          ...(entry.efforts === undefined ? {} : { reasoning: { efforts: entry.efforts.map((id) => ({ id, name: id })) } }),
          ...(entry.modalities === undefined ? {} : { inputModalities: entry.modalities }),
          context: { contextWindow: 1048576 },
        }
      },
    },
  }
  return { ctx, listeners, commands, resolveCalls }
}

function handlerOf(listeners, event) {
  const list = listeners.get(event)
  assert.ok(list && list.length > 0, `no listener for ${event}`)
  return list[0]
}

let sessionSeq = 0

function fakeAgent({ id, depth = 0, header } = {}) {
  // 让位记录是持久化的，默认 id 必须每次不同，否则用例之间会互相污染。
  const sessionId = id ?? `session-${(sessionSeq += 1)}`
  return {
    id: sessionId,
    options: { subagentDepth: depth },
    session: {
      id: sessionId,
      requestHeader: () => header,
    },
  }
}

function userMessage(text) {
  return {
    id: `m-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

async function preStep(listeners, agent, { turn = 1, step = 1, text = '帮我把这段日志翻译成英文' } = {}) {
  const handler = handlerOf(listeners, 'agent/pre-step')
  const messages = text === '' ? [] : [userMessage(text)]
  return handler({ agent, turn, step, signal: new AbortController().signal, messages }, async () => ({ kind: 'enter', messages }))
}

async function request(listeners, agent, base, { turn = 1, step = 1 } = {}) {
  const handler = handlerOf(listeners, 'agent/request')
  return handler({ agent, turn, step, signal: new AbortController().signal }, async () => base)
}

test('插件导出符合 cordis 约定', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(inject.includes('llm'), true)
  assert.equal(name, 'model-budget-router')
})

test('简单任务被降到 flash/low', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent()
  await preStep(host.listeners, agent)
  const routed = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(routed.model, 'deepseek-flash')
  assert.equal(routed.reasoningEffort, 'low')
})

test('重任务升到 strong 模型与 high 强度', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent()
  const brief = '实现一个插件，设计一个可配置档位表并重构路由逻辑。\n```js\nconst a = 1\n```\n--- a/x\n+++ b/x\n1. 写测试\n2. 做性能优化'
  await preStep(host.listeners, agent, { text: brief })
  const routed = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(routed.model, 'deepseek-v4-pro')
  assert.equal(routed.reasoningEffort, 'high')
})

test('strong 模型不可用时回退到便宜档，而不是报错', async () => {
  const host = makeHost({ catalog: { 'deepseek-flash': { efforts: ['low', 'high'] } } })
  apply(host.ctx, {})
  const agent = fakeAgent()
  await preStep(host.listeners, agent, { text: '实现一个编译器前端，重构整个解析流程。\n```js\nx\n```\n--- a\n+++ b' })
  const routed = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(routed.model, 'deepseek-flash')
})

test('不同 provider 的会话不被接管', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent()
  await preStep(host.listeners, agent)
  const base = { provider: 'openai', model: 'gpt-x', reasoningEffort: 'medium' }
  const routed = await request(host.listeners, agent, base)
  assert.deepEqual(routed, base)
})

test('同一轮内工具连续报错会升级一档，且记录在状态里', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent()
  await preStep(host.listeners, agent, { text: '把这个函数改名成 parseConfig' })
  const first = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(first.reasoningEffort, 'low')

  const sessionEvent = handlerOf(host.listeners, 'session/event')
  const errorResult = { type: 'tool/result', data: { turn: 1, step: 1, message: { isError: true } } }
  sessionEvent(agent.session, errorResult)
  sessionEvent(agent.session, errorResult)

  const second = await request(host.listeners, agent, { ...first }, { turn: 1, step: 2 })
  assert.equal(second.reasoningEffort, 'high')
})

test('整轮失败后，下一轮至少升一档', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent()
  await preStep(host.listeners, agent)
  await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  handlerOf(host.listeners, 'session/event')(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })

  await preStep(host.listeners, agent, { turn: 2, text: '把这个函数改名成 parseConfig' })
  const routed = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, { turn: 2 })
  assert.equal(routed.reasoningEffort, 'high')
})

test('检测到手动换模型后让位，返回上游选择', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  // 请求头里上一次生效的是 flash；本次上游（用户手动选择）改成了 pro。
  const agent = fakeAgent({
    header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } },
  })
  await preStep(host.listeners, agent)
  const manual = { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
  const routed = await request(host.listeners, agent, manual)
  assert.deepEqual(routed, manual)

  // 让位是会话级的：下一轮也不会再接管。
  await preStep(host.listeners, agent, { turn: 2 })
  const again = await request(host.listeners, agent, manual, { turn: 2 })
  assert.deepEqual(again, manual)
})

test('dryRun 只记录不切换', async () => {
  const host = makeHost()
  apply(host.ctx, { dryRun: true })
  const agent = fakeAgent()
  await preStep(host.listeners, agent)
  const base = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  const routed = await request(host.listeners, agent, base)
  assert.deepEqual(routed, base)
})

test('子代理默认不接管', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent({ id: 'child', depth: 1 })
  await preStep(host.listeners, agent, { text: '实现一个编译器' })
  const base = { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
  const routed = await request(host.listeners, agent, base)
  assert.deepEqual(routed, base)
})

test('带图片的重任务不会落到纯文本模型上', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent()
  const handler = handlerOf(host.listeners, 'agent/pre-step')
  const messages = [{
    id: 'img-1',
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '实现一个编译器前端，重构整个解析流程。\n```js\nx\n```\n--- a\n+++ b\n1. 写测试\n2. 性能优化' },
      { type: 'image', attachment: { id: 'a1' } },
    ],
  }]
  await handler({ agent, turn: 1, step: 1, signal: new AbortController().signal, messages }, async () => ({ kind: 'enter', messages }))
  const routed = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(routed.model, 'deepseek-flash', 'strong 档是纯文本模型，必须回退到支持图片的 flash')
})

test('压过入口的模型选择监听器（prepend 回归）', async () => {
  const host = makeHost()
  // 模拟入口在插件之前注册的会话选择：它总是把强度写回 high。
  const selection = async (_payload, next) => {
    const resolved = await next()
    return { ...resolved, provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  }
  host.ctx.on('agent/request', selection)
  apply(host.ctx, {})

  const list = host.listeners.get('agent/request')
  assert.equal(list.length, 2)
  assert.notEqual(list[0], selection, 'prepend 之后插件必须排在最外层')

  const agent = fakeAgent()
  await preStep(host.listeners, agent, { text: '把这个函数改名成 parseConfig' })

  // 按 cordis 语义组装 waterfall：list[0] 最外层，先拿到 next() 的结果再改写。
  const base = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  const dispatch = (index) => (payload) => list[index](payload, () => (index + 1 >= list.length
    ? Promise.resolve(base)
    : dispatch(index + 1)(payload)))
  const routed = await dispatch(0)({ agent, turn: 1, step: 1, signal: new AbortController().signal })
  assert.equal(routed.reasoningEffort, 'low', '外层的选择监听器不能把插件的结果改回去')
})

test('启动自检把各档位可用性写进 status.json', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-status-'))
  try {
    const host = makeHost()
    apply(host.ctx, { log: { dir, decisions: false } })
    const file = path.join(dir, 'status.json')
    let document
    for (let attempt = 0; attempt < 60 && document === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed.tiersUsable !== undefined) document = parsed
    }
    assert.ok(document !== undefined, 'status.json 应包含 tiersUsable')
    assert.equal(document.tiersUsable.cheap.usable, true)
    assert.equal(document.tiersUsable.strong.model, 'deepseek-v4-pro')
    assert.deepEqual(document.tiersUsable.cheap.efforts, ['off', 'low', 'high'])
    assert.equal(document.guards.imageRoute, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不可用的档位模型会在自检里标成 false', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-status-'))
  try {
    const host = makeHost({ catalog: { 'deepseek-flash': { efforts: ['low', 'high'] } } })
    apply(host.ctx, { log: { dir, decisions: false } })
    const file = path.join(dir, 'status.json')
    let document
    for (let attempt = 0; attempt < 60 && document === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed.tiersUsable !== undefined) document = parsed
    }
    assert.equal(document.tiersUsable.cheap.usable, true)
    assert.equal(document.tiersUsable.strong.usable, false)
    assert.match(document.tiersUsable.strong.error, /unknown model/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('热替换后能从中断的那一轮恢复档位', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-restore-'))
  try {
    const first = makeHost()
    apply(first.ctx, { log: { dir, decisions: true } })
    const agent = fakeAgent({ id: 'session-restore' })
    await preStep(first.listeners, agent, { text: '把这个函数改名成 parseConfig' })
    const routed = await request(first.listeners, agent, {
      provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high',
    })
    assert.equal(routed.reasoningEffort, 'low')
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 模拟插件被热替换：同一个会话、同一轮、全新的实例（内存状态为空）。
    const second = makeHost()
    apply(second.ctx, { log: { dir, decisions: true } })
    const resumed = fakeAgent({ id: 'session-restore', header: { config: routed } })
    const restored = await request(second.listeners, resumed, {
      provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high',
    }, { turn: 1, step: 2 })
    assert.equal(restored.reasoningEffort, 'low', '重载后同一轮应恢复原档位')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只改推理强度也算手动选择，插件让位', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent({
    header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' } },
  })
  await preStep(host.listeners, agent)
  // 模型没变，只把强度从 low 拉到 max。
  const manual = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }
  const routed = await request(host.listeners, agent, manual)
  assert.deepEqual(routed, manual)

  // 让位是会话级的，下一轮也不接管。
  await preStep(host.listeners, agent, { turn: 2 })
  const again = await request(host.listeners, agent, manual, { turn: 2 })
  assert.deepEqual(again, manual)
})

test('插件自己写过的配置不会被误判成手动选择', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = fakeAgent({
    header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } },
  })
  await preStep(host.listeners, agent, { text: '把这个函数改名成 parseConfig' })
  const first = await request(host.listeners, agent, {
    provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high',
  })
  assert.equal(first.reasoningEffort, 'low')

  // 下一轮 base 就是插件上一次写过的 low；不能因为和旧 header 不同就让位。
  await preStep(host.listeners, agent, { turn: 2, text: '把这个变量改名成 userName' })
  const second = await request(host.listeners, agent, { ...first }, { turn: 2 })
  assert.equal(second.reasoningEffort, 'low')
})

test('让位记录在重启后依然有效', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-yield-'))
  try {
    const headerBefore = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }
    const manual = { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

    const first = makeHost()
    apply(first.ctx, { log: { dir, decisions: false } })
    const agent = fakeAgent({ id: 'session-yield', header: { config: headerBefore } })
    await preStep(first.listeners, agent)
    assert.deepEqual(await request(first.listeners, agent, manual), manual)
    await new Promise((resolve) => setTimeout(resolve, 120))

    // 模拟重启：全新实例，读同一份 yields.json。
    const second = makeHost()
    apply(second.ctx, { log: { dir, decisions: false } })
    await new Promise((resolve) => setTimeout(resolve, 80))

    const medium = '这个项目启动报错，帮我排查一下原因'
    const yielded = fakeAgent({ id: 'session-yield', header: { config: headerBefore } })
    await preStep(second.listeners, yielded, { text: medium })
    const keptManual = await request(second.listeners, yielded, headerBefore)
    assert.equal(keptManual.reasoningEffort, 'low', '重启后仍应让位，不能把强度提回 high')

    // 对照：没有让位记录的会话照常接管。
    const fresh = fakeAgent({ id: 'session-fresh', header: { config: headerBefore } })
    await preStep(second.listeners, fresh, { text: medium })
    const routed = await request(second.listeners, fresh, headerBefore)
    assert.equal(routed.reasoningEffort, 'high', '没有让位记录的会话应升到 standard')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/budget on 收回让位并清掉持久记录', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mbr-yield-'))
  try {
    const headerBefore = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }
    const host = makeHost()
    apply(host.ctx, { log: { dir, decisions: false } })
    const agent = fakeAgent({ id: 'session-resume', header: { config: headerBefore } })
    await preStep(host.listeners, agent)
    await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    await new Promise((resolve) => setTimeout(resolve, 120))

    const state = await host.commands[0].handler({ agent, rawInput: '' })
    assert.match(state.text, /已让位/)

    const resumed = await host.commands[0].handler({ agent, rawInput: 'on' })
    assert.equal(resumed.kind, 'success')

    await preStep(host.listeners, agent, { turn: 2, text: '这个项目启动报错，帮我排查一下原因' })
    const routed = await request(host.listeners, agent, headerBefore, { turn: 2 })
    assert.equal(routed.reasoningEffort, 'high', '收回让位后应重新接管')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注册了 /budget 命令并能返回状态', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  assert.equal(host.commands.length, 1)
  assert.equal(host.commands[0].name, 'budget')
  const agent = fakeAgent()
  await preStep(host.listeners, agent)
  const result = await host.commands[0].handler({ agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /cheap/)

  const withHeader = fakeAgent({
    header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' } },
  })
  const status = await host.commands[0].handler({ agent: withHeader, rawInput: '' })
  assert.match(status.text, /实际生效: deepseek-account\/deepseek-flash @low/)

  const off = await host.commands[0].handler({ agent, rawInput: 'off' })
  assert.equal(off.kind, 'success')
  const routed = await request(host.listeners, agent, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(routed.reasoningEffort, 'high')
})
