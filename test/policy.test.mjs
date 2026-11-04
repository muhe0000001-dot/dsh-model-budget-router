import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessPrompt,
  bumpTier,
  clampTier,
  normalizeConfig,
  pickEffort,
  promptText,
} from '../lib/policy.js'

const cfg = normalizeConfig({})

function assess(text, extra = {}) {
  return assessPrompt({ text, images: false, ...extra }, cfg)
}

test('默认配置完整且自洽', () => {
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.provider, 'deepseek-account')
  assert.deepEqual(Object.keys(cfg.tiers).sort(), ['cheap', 'standard', 'strong'])
  assert.equal(cfg.tiers.cheap.model, 'deepseek-flash')
  assert.ok(cfg.rules.thresholds.cheap < cfg.rules.thresholds.strong)
})

test('未知配置键直接报错', () => {
  assert.throws(() => normalizeConfig({ tirs: {} }), /unknown config key/)
  assert.throws(() => normalizeConfig({ tiers: { huge: { model: 'x' } } }), /tiers\.huge/)
  assert.throws(() => normalizeConfig({ rules: { thresholds: { cheap: 9, strong: 3 } } }), /less than/)
})

test('短小的翻译/改写任务落到 cheap', () => {
  assert.equal(assess('帮我把这段日志翻译成英文').tier, 'cheap')
  assert.equal(assess('把这个函数改名成 parseConfig').tier, 'cheap')
})

test('带排错意图的中等任务落到 standard', () => {
  const result = assess('这个项目启动报错，帮我看看原因，顺便跑一下测试')
  assert.equal(result.tier, 'standard', JSON.stringify(result))
  assert.ok(result.signals.workHits.length > 0)
})

test('工程量大 / 高密度需求落到 strong', () => {
  const brief = [
    '实现一个插件，根据任务评估自动切换模型，从而达到省钱的目的。',
    '要求：',
    '1. 设计一个可配置的档位表，支持 cheap/standard/strong。',
    '2. 重构现有的路由逻辑，处理并发与失败回退。',
    '3. 写测试，覆盖根因分析与性能优化场景。',
    '```js',
    'const x = 1',
    '```',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
  ].join('\n')
  const result = assess(brief)
  assert.equal(result.tier, 'strong', JSON.stringify(result))
  assert.ok(result.score >= cfg.rules.thresholds.strong)
})

test('长度与代码块都会加分', () => {
  const short = assess('随便聊聊')
  const long = assess('背景：'.padEnd(1200, '细节'))
  assert.ok(long.score > short.score)
  const fenced = assess('看这段：\n```ts\nconst a = 1\n```')
  assert.ok(fenced.signals.fence >= 1)
  assert.ok(fenced.score >= 2)
})

test('promptText 跳过运行时上下文，只取用户文本', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修一下这个 bug' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '今天是 2026 年' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '好的' }] },
  ]
  assert.equal(promptText(messages), '修一下这个 bug')
})

test('档位上下夹取与升级', () => {
  assert.equal(bumpTier('cheap', 1, 'cheap', 'strong'), 'standard')
  assert.equal(bumpTier('strong', 1, 'cheap', 'strong'), 'strong')
  assert.equal(bumpTier('standard', 1, 'standard', 'standard'), 'standard')
  assert.equal(clampTier('strong', 'cheap', 'standard'), 'standard')
  assert.equal(clampTier('cheap', 'standard', 'strong'), 'standard')
})

test('推理强度映射到模型支持的档位', () => {
  assert.deepEqual(pickEffort('low', ['low', 'high']), 'low')
  assert.deepEqual(pickEffort('medium', ['low', 'high']), 'high')
  assert.deepEqual(pickEffort('low', ['high', 'max']), 'high')
  assert.equal(pickEffort('low', undefined), null)
  assert.equal(pickEffort('low', []), null)
  assert.equal(pickEffort('default', ['low']), null)
  assert.equal(pickEffort('inherit', ['low']), undefined)
})

test('默认不允许把思考关掉（会破坏带工具调用的历史）', () => {
  assert.equal(pickEffort('off', ['off', 'low', 'high']), 'low')
  assert.equal(pickEffort('off', ['off', 'low', 'high'], { allowThinkingOff: true }), 'off')
  assert.equal(pickEffort('none', ['off']), null)
})
