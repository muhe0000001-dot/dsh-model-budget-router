/**
 * 纯策略层：配置归一化、任务复杂度评估、推理强度映射。
 * 不依赖任何宿主包，可在普通 Node 里直接单测。
 */

export const TIERS = ['cheap', 'standard', 'strong']

/** 推理强度的相对档位，用于把配置值映射到模型支持的集合。 */
const EFFORT_RANK = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const DEFAULT_CHEAP_KEYWORDS = [
  '翻译', '改写', '润色', '改名', '重命名', '格式化', '排版', '总结一下', '归纳一下',
  '这是什么', '什么意思', '怎么读', '列一下', '列个表', '读一下', '解释一下', '写个 commit',
  'translate', 'rename', 'reformat', 'format this', 'summarize', 'summarise',
  'what is', 'what does', 'list the', 'explain this',
]

const DEFAULT_WORK_KEYWORDS = [
  '修复', '修复一下', '排查', '调试', '报错', '异常', '失败', '崩溃', '测试', '分析', '对比',
  '优化', '审查', '评审', '检查', '补全', '迁移', '升级', '依赖',
  'fix', 'debug', 'investigate', 'analyze', 'analyse', 'compare', 'optimize', 'optimise',
  'review', 'test', 'migrate', 'upgrade', 'refactor', 'benchmark',
]

const DEFAULT_HARD_KEYWORDS = [
  '架构', '设计一个', '设计方案', '系统设计', '实现一个', '写一个', '写个', '开发一个', '搭建',
  '重构', '性能优化', '根因', '疑难', '并发', '分布式', '算法', '论文', '证明',
  '插件', '编译器', '协议', '端到端', '从零',
  'architecture', 'design a', 'implement', 'build a', 'create a', 'develop a',
  'refactor', 'root cause', 'concurrency', 'distributed', 'algorithm', 'from scratch',
]

function fail(message) {
  throw new Error(`model-budget-router: ${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} must be a non-empty string`)
  return value.trim()
}

function stringList(value, where, fallback) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) fail(`${where} must be an array of strings`)
  return value.map((item, index) => nonEmptyString(item, `${where}[${index}]`))
}

function finiteNumber(value, where, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} must be a finite number`)
  return value
}

function nonNegativeInteger(value, where, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) fail(`${where} must be a non-negative integer`)
  return value
}

function boolean(value, where, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${where} must be a boolean`)
  return value
}

function oneOf(value, where, allowed, fallback) {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) fail(`${where} must be one of ${allowed.join(', ')}`)
  return value
}

/**
 * 把用户 YAML 配置归一化成完整配置；未知字段直接报错，避免拼写错误静默失效。
 * @param {unknown} raw - 插件行 config。
 * @returns 完整且已校验的配置对象。
 */
export function normalizeConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(input)) fail('config must be an object')

  const known = new Set([
    'enabled', 'provider', 'tiers', 'minTier', 'maxTier', 'rules', 'escalation',
    'subagents', 'manualOverride', 'dryRun', 'log', 'verbose', 'allowThinkingOff',
  ])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) fail(`unknown config key "${key}"`)
  }

  const provider = nonEmptyString(input.provider ?? 'deepseek-account', 'provider')

  const rawTiers = input.tiers ?? {}
  if (!isPlainObject(rawTiers)) fail('tiers must be an object')
  for (const key of Object.keys(rawTiers)) {
    if (!TIERS.includes(key)) fail(`tiers.${key} must be one of ${TIERS.join(', ')}`)
  }

  const defaults = {
    cheap: { model: 'deepseek-flash', effort: 'low' },
    standard: { model: 'deepseek-flash', effort: 'high' },
    strong: { model: 'deepseek-v4-pro', effort: 'high' },
  }
  const tiers = {}
  for (const tier of TIERS) {
    const spec = rawTiers[tier] ?? defaults[tier]
    if (!isPlainObject(spec)) fail(`tiers.${tier} must be an object`)
    for (const key of Object.keys(spec)) {
      if (!['model', 'effort'].includes(key)) fail(`tiers.${tier}: unknown key "${key}"`)
    }
    tiers[tier] = {
      model: nonEmptyString(spec.model, `tiers.${tier}.model`),
      // 'inherit' 保留上游选择；'default' 去掉显式强度，交回模型默认；其余按档位映射。
      effort: spec.effort === undefined ? 'inherit' : nonEmptyString(spec.effort, `tiers.${tier}.effort`),
    }
  }

  const rawRules = input.rules ?? {}
  if (!isPlainObject(rawRules)) fail('rules must be an object')
  for (const key of Object.keys(rawRules)) {
    if (!['thresholds', 'cheapKeywords', 'workKeywords', 'hardKeywords', 'lengthSteps'].includes(key)) {
      fail(`rules: unknown key "${key}"`)
    }
  }
  const rawThresholds = rawRules.thresholds ?? {}
  if (!isPlainObject(rawThresholds)) fail('rules.thresholds must be an object')
  const cheapAt = finiteNumber(rawThresholds.cheap, 'rules.thresholds.cheap', 2)
  const strongAt = finiteNumber(rawThresholds.strong, 'rules.thresholds.strong', 7)
  if (cheapAt >= strongAt) fail('rules.thresholds.cheap must be less than rules.thresholds.strong')

  const lengthSteps = rawRules.lengthSteps === undefined
    ? [90, 300, 800, 2000]
    : rawRules.lengthSteps
  if (!Array.isArray(lengthSteps) || lengthSteps.length !== 4
    || lengthSteps.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    || !(lengthSteps[0] < lengthSteps[1] && lengthSteps[1] < lengthSteps[2] && lengthSteps[2] < lengthSteps[3])) {
    fail('rules.lengthSteps must be four strictly increasing positive numbers')
  }

  const rawEscalation = input.escalation ?? {}
  if (!isPlainObject(rawEscalation)) fail('escalation must be an object')
  for (const key of Object.keys(rawEscalation)) {
    if (!['afterToolErrors', 'afterTurnError'].includes(key)) fail(`escalation: unknown key "${key}"`)
  }

  const rawLog = input.log ?? {}
  if (!isPlainObject(rawLog)) fail('log must be an object')
  for (const key of Object.keys(rawLog)) {
    if (!['decisions', 'dir'].includes(key)) fail(`log: unknown key "${key}"`)
  }

  return {
    enabled: boolean(input.enabled, 'enabled', true),
    provider,
    tiers,
    minTier: oneOf(input.minTier, 'minTier', TIERS, 'cheap'),
    maxTier: oneOf(input.maxTier, 'maxTier', TIERS, 'strong'),
    rules: {
      thresholds: { cheap: cheapAt, strong: strongAt },
      cheapKeywords: stringList(rawRules.cheapKeywords, 'rules.cheapKeywords', DEFAULT_CHEAP_KEYWORDS),
      workKeywords: stringList(rawRules.workKeywords, 'rules.workKeywords', DEFAULT_WORK_KEYWORDS),
      hardKeywords: stringList(rawRules.hardKeywords, 'rules.hardKeywords', DEFAULT_HARD_KEYWORDS),
      lengthSteps: [...lengthSteps],
    },
    escalation: {
      afterToolErrors: nonNegativeInteger(rawEscalation.afterToolErrors, 'escalation.afterToolErrors', 2),
      afterTurnError: boolean(rawEscalation.afterTurnError, 'escalation.afterTurnError', true),
    },
    subagents: oneOf(input.subagents, 'subagents', ['off', 'cheap', 'inherit'], 'off'),
    manualOverride: oneOf(input.manualOverride, 'manualOverride', ['session', 'turn', 'ignore'], 'session'),
    dryRun: boolean(input.dryRun, 'dryRun', false),
    allowThinkingOff: boolean(input.allowThinkingOff, 'allowThinkingOff', false),
    log: {
      decisions: boolean(rawLog.decisions, 'log.decisions', true),
      dir: rawLog.dir === undefined ? null : nonEmptyString(rawLog.dir, 'log.dir'),
    },
    verbose: boolean(input.verbose, 'verbose', false),
  }
}

/** 取消息数组中的用户可见文本（跳过运行时注入的上下文）。 */
export function promptText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    if (!message || message.role !== 'user') continue
    const kind = message.source?.kind
    if (kind === 'runtime-context' || kind === 'model-selection') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}

/** 消息里是否带图片块。 */
export function hasImage(messages) {
  for (const message of messages ?? []) {
    if (!message) continue
    for (const block of message.content ?? []) {
      if (block?.type === 'image') return true
    }
  }
  return false
}

function countHits(text, keywords) {
  const lower = text.toLowerCase()
  const hits = []
  for (const keyword of keywords) {
    if (keyword.length === 0) continue
    if (lower.includes(keyword.toLowerCase())) hits.push(keyword)
  }
  return hits
}

function countMatches(text, pattern) {
  const matches = text.match(pattern)
  return matches === null ? 0 : matches.length
}

/**
 * 评估一段用户任务，给出 0..N 的复杂度分与档位。
 * 纯启发式：不发任何额外模型请求，因此在省钱这件事上是零成本的。
 * @param {object} input - { text, images, sourceKinds }。
 * @param {object} cfg - normalizeConfig 的结果。
 * @returns {{score:number, tier:string, signals:object, reason:string}}
 */
export function assessPrompt(input, cfg) {
  const text = typeof input.text === 'string' ? input.text : ''
  const chars = text.length
  const signals = {
    chars,
    fence: countMatches(text, /```/g) === 0 ? 0 : Math.ceil(countMatches(text, /```/g) / 2),
    diff: /^(?:---|\+\+\+) .+$/m.test(text) ? 1 : 0,
    questions: countMatches(text, /[?？]/g),
    steps: countMatches(text, /(?:^|\n)\s*\d+[.、)]/g),
    images: input.images === true,
    cheapHits: countHits(text, cfg.rules.cheapKeywords),
    workHits: countHits(text, cfg.rules.workKeywords),
    hardHits: countHits(text, cfg.rules.hardKeywords),
  }

  const [s1, s2, s3, s4] = cfg.rules.lengthSteps
  let score = 0
  if (chars >= s4) score += 4
  else if (chars >= s3) score += 3
  else if (chars >= s2) score += 2
  else if (chars >= s1) score += 1

  if (signals.fence >= 3) score += 3
  else if (signals.fence >= 1) score += 2

  if (signals.diff > 0) score += 3

  score += Math.min(signals.hardHits.length * 3, 9)
  score += Math.min(signals.workHits.length * 2, 6)
  score -= Math.min(signals.cheapHits.length * 3, 6)

  if (signals.questions >= 2) score += 1
  if (signals.steps >= 2) score += 1

  // 附件图片：需要视觉路由，交给配置里的档位（默认 cheap，flash 支持图片）。
  if (signals.images) score += 1

  const { cheap, strong } = cfg.rules.thresholds
  const tier = score >= strong ? 'strong' : score <= cheap ? 'cheap' : 'standard'

  const reasons = []
  if (signals.hardHits.length > 0) reasons.push(`hard:${signals.hardHits.slice(0, 3).join(',')}`)
  if (signals.workHits.length > 0) reasons.push(`work:${signals.workHits.slice(0, 3).join(',')}`)
  if (signals.cheapHits.length > 0) reasons.push(`cheap:${signals.cheapHits.slice(0, 3).join(',')}`)
  if (signals.fence > 0) reasons.push(`code:${signals.fence}`)
  if (signals.diff > 0) reasons.push('diff')
  reasons.push(`chars:${chars}`)

  return { score, tier, signals, reason: reasons.join(' ') }
}

/** 档位升级/降级。 */
export function tierAt(index) {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, index))]
}

export function bumpTier(tier, delta, minTier, maxTier) {
  const from = Math.max(TIERS.indexOf(minTier), TIERS.indexOf(tier))
  const to = Math.max(TIERS.indexOf(minTier), Math.min(TIERS.indexOf(maxTier), from + delta))
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, to))]
}

/** 把 minTier..maxTier 之外的档位夹回范围内。 */
export function clampTier(tier, minTier, maxTier) {
  const value = Math.max(TIERS.indexOf(minTier), Math.min(TIERS.indexOf(maxTier), TIERS.indexOf(tier)))
  return TIERS[value]
}

/**
 * 把配置里的强度词映射到模型实际支持的集合。
 * @param {string} wanted - 'inherit' | 'default' | 具体强度词。
 * @param {string[]|null|undefined} supported - 模型公布的强度 id 列表；undefined 表示不支持推理。
 * @param {{allowThinkingOff?: boolean}} [options] - 默认拒绝 off/none：
 *   思考关掉后再于同一会话发工具调用，DeepSeek 会拒绝整条历史，代价远大于省下的钱。
 * @returns {string|null|undefined} undefined=保留上游值，null=删除显式强度，string=具体值。
 */
export function pickEffort(wanted, supported, options = {}) {
  const allowThinkingOff = options.allowThinkingOff === true
  let result
  if (wanted === undefined || wanted === 'inherit') return undefined
  if (wanted === 'default' || wanted === 'auto') return null
  if (!Array.isArray(supported) || supported.length === 0) return null
  if (supported.includes(wanted)) {
    result = wanted
  } else {
    let wantedRank = EFFORT_RANK.indexOf(wanted)
    if (wantedRank < 0) wantedRank = EFFORT_RANK.indexOf('medium')
    let best = supported[0]
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of supported) {
      let rank = EFFORT_RANK.indexOf(candidate)
      if (rank < 0) rank = EFFORT_RANK.indexOf('medium')
      const distance = Math.abs(rank - wantedRank)
      // 距离相同时取更高档：宁可多花一点，也不要因为降档丢质量。
      if (distance < bestDistance || (distance === bestDistance && rank > EFFORT_RANK.indexOf(best))) {
        best = candidate
        bestDistance = distance
      }
    }
    result = best
  }

  if (!allowThinkingOff && (result === 'off' || result === 'none')) {
    const thinking = supported.filter((candidate) => candidate !== 'off' && candidate !== 'none')
    return thinking.length === 0 ? null : thinking[0]
  }
  return result
}
