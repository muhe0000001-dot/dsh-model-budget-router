/**
 * model-budget-router —— 按任务复杂度自动切换模型 / 推理强度的 DSH 宿主插件。
 *
 * 设计要点：
 * - 只用 `agent/pre-step` 的启发式评估，不额外调用模型，所以评估本身零成本。
 * - 决策按「轮」粘住：同一个用户任务（含后续所有工具步）始终用同一档模型，
 *   避免逐步跳模型把 KV 前缀缓存打散，反而更贵。
 * - 失败有证据才升级：同一轮内工具连续报错、或整轮报错失败，才上一档。
 * - 任何异常都退回上游配置，绝不把一轮对话搞挂。
 *
 * @module model-budget-router
 */
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  TIERS,
  assessPrompt,
  bumpTier,
  clampTier,
  hasImage,
  normalizeConfig,
  pickEffort,
  promptText,
} from './policy.js'

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'model-budget-router'

/** 需要 `llm` 服务提供模型元数据与路由校验。 */
export const inject = ['llm']

const VERSION = '1.6.0'
const MAX_SESSIONS = 256
const MODEL_INFO_TTL_MS = 10 * 60 * 1000
const MODEL_INFO_RETRY_MS = 60 * 1000

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function nowIso() {
  return new Date().toISOString()
}

function routeLabel(route) {
  if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return '?'
  return `${route.provider}/${route.model}`
}

function sameRoute(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model
}

/** 模型 + 推理强度都相同才算同一套配置；undefined 与 null 视为一致。 */
function sameConfig(left, right) {
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null)
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const startedAt = nowIso()
  const logDir = cfg.log.dir ?? path.join(dshHome(), 'storages', 'model-budget')

  /** sessionId -> 会话级状态 */
  const sessions = new Map()
  /** `${provider}/${model}` -> { attempts, efforts, at, error } */
  const modelInfo = new Map()

  let enabled = cfg.enabled
  let dryRun = cfg.dryRun
  let usability = {}
  let warned = 0
  const warnedTargets = new Set()

  const warn = (message) => {
    warned += 1
    if (warned <= 20) ctx.logger.warn(`[model-budget-router] ${message}`)
  }

  let writeChain = Promise.resolve()
  const yieldsFile = path.join(logDir, 'yields.json')
  /** 让位记录：sessionId -> { kind, at }，持久化，重启后仍然让位。 */
  const yields = new Map()
  const YIELD_TTL_MS = 7 * 24 * 60 * 60 * 1000

  const loadYields = async () => {
    try {
      const raw = JSON.parse(await readFile(yieldsFile, 'utf8'))
      for (const [sessionId, value] of Object.entries(raw?.sessions ?? {})) {
        if (typeof value?.at !== 'string') continue
        if (Date.now() - Date.parse(value.at) > YIELD_TTL_MS) continue
        yields.set(sessionId, value)
      }
    } catch {
      /* 没有让位记录就是全新状态 */
    }
  }

  const saveYields = () => {
    const sessions = {}
    for (const [sessionId, value] of yields) sessions[sessionId] = value
    return writeFile(yieldsFile, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, 'utf8')
      .catch((error) => warn(`cannot write yields: ${error instanceof Error ? error.message : String(error)}`))
  }

  const writeJsonl = (file, record) => {
    writeChain = writeChain
      .then(async () => {
        await mkdir(logDir, { recursive: true })
        await appendFile(path.join(logDir, file), `${JSON.stringify(record)}\n`, 'utf8')
      })
      .catch((error) => warn(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`))
    return writeChain
  }

  const writeStatus = async (patch) => {
    const document = {
      plugin: name,
      version: VERSION,
      startedAt,
      enabled,
      dryRun,
      provider: cfg.provider,
      tiers: cfg.tiers,
      guards: {
        imageRoute: true,
        thinkingOffAllowed: cfg.allowThinkingOff,
        manualOverride: cfg.manualOverride,
        subagents: cfg.subagents,
      },
      ...patch,
    }
    await mkdir(logDir, { recursive: true })
    await writeFile(path.join(logDir, 'status.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }

  const stateOf = (sessionId) => {
    if (typeof sessionId !== 'string') return undefined
    let state = sessions.get(sessionId)
    if (state !== undefined) return state
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next()
      if (!oldest.done) sessions.delete(oldest.value)
    }
    state = {
      sessionId,
      turn: -1,
      tier: null,
      score: 0,
      reason: '',
      decidedAt: 0,
      hasImages: false,
      toolErrors: 0,
      escalations: 0,
      pendingFloor: null,
      yielded: yields.has(sessionId),
      yieldKind: yields.get(sessionId)?.kind ?? null,
      restored: false,
      justRestored: false,
      manualTurn: -1,
      applied: null,
      stats: { turns: 0, cheap: 0, standard: 0, strong: 0, escalations: 0 },
      decisions: [],
    }
    sessions.set(sessionId, state)
    return state
  }

  /** 读取模型能力（强度集合）；失败只缓存一段时间，NO_ADAPTER 视为暂时未就绪。 */
  const effortsFor = async (provider, model) => {
    const key = `${provider}/${model}`
    const cached = modelInfo.get(key)
    if (cached !== undefined && Date.now() - cached.at < (cached.error === undefined ? MODEL_INFO_TTL_MS : MODEL_INFO_RETRY_MS)) {
      return cached
    }
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const record = {
        at: Date.now(),
        efforts: Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((effort) => effort.id) : undefined,
        contextWindow: info?.context?.contextWindow,
        modalities: Array.isArray(info?.inputModalities) ? [...info.inputModalities] : undefined,
      }
      modelInfo.set(key, record)
      return record
    } catch (error) {
      const code = error instanceof Error && typeof error.code === 'string' ? error.code : undefined
      const record = { at: Date.now(), error: error instanceof Error ? error.message : String(error), transient: code === 'NO_ADAPTER' }
      if (!record.transient) {
        modelInfo.set(key, record)
        warn(`model ${key} is not usable: ${record.error}`)
      }
      return record
    }
  }

  /** 解析档位对应的具体路由；模型不可用或看不了图片时逐级回退，最终保留上游路由。 */
  const resolveTarget = async (tierName, base, options = {}) => {
    const order = []
    for (let index = TIERS.indexOf(tierName); index >= 0; index -= 1) order.push(TIERS[index])
    for (const candidate of order) {
      const spec = cfg.tiers[candidate]
      const provider = cfg.provider
      if (base.provider !== provider) continue
      const info = await effortsFor(provider, spec.model)
      if (info.error !== undefined) continue
      // 带图片的任务不能落到纯文本模型上，否则图会被替换成占位符。
      if (options.requireImage === true && Array.isArray(info.modalities) && !info.modalities.includes('image')) continue
      return {
        tier: candidate,
        provider,
        model: spec.model,
        effort: pickEffort(spec.effort, info.efforts, { allowThinkingOff: cfg.allowThinkingOff }),
        contextWindow: info.contextWindow,
        modalities: info.modalities,
      }
    }
    return null
  }

  const recordDecision = (state, base, target, reason) => {
    // 每个工具步都会重新落一次档；同一轮同样的目标只记一次，避免日志噪音。
    const last = state.decisions[state.decisions.length - 1]
    if (last !== undefined && last.turn === state.turn
      && last.to.model === target.model && last.to.effort === (target.effort ?? null)
      && last.from.effort === (base.reasoningEffort ?? null)) {
      return
    }
    const entry = {
      at: nowIso(),
      sessionId: state.sessionId,
      turn: state.turn,
      tier: target.tier,
      score: state.score,
      reason,
      images: state.hasImages === true,
      from: { provider: base.provider, model: base.model, effort: base.reasoningEffort ?? null },
      to: { provider: target.provider, model: target.model, effort: target.effort ?? null },
      dryRun,
    }
    state.decisions.push(entry)
    if (state.decisions.length > 12) state.decisions.shift()
    if (cfg.log.decisions) writeJsonl('decisions.jsonl', entry)
    if (cfg.verbose) {
      ctx.logger.info(`[model-budget-router] turn ${state.turn} ${target.tier} <- ${reason} ${routeLabel(base)} -> ${routeLabel(target)}`)
    }
  }

  // ---------------------------------------------------------------- pre-step
  /** 新的一轮用户任务开始时做一次评估；工具步不重复评估，保持同档。 */
  const onPreStep = (payload, decision) => {
    if (!enabled) return
    if (decision.kind === 'reject') return
    const agent = payload.agent
    const step = payload.step
    if (!agent || step !== 1) return
    const state = stateOf(agent.session?.id)
    if (state === undefined) return

    const depth = agent.options?.subagentDepth ?? 0
    if (depth > 0 && cfg.subagents === 'off') return

    const messages = payload.messages ?? []
    const assessment = assessPrompt({ text: promptText(messages), images: hasImage(messages) }, cfg)

    let tier
    let reason = assessment.reason
    if (depth > 0 && cfg.subagents === 'cheap') {
      tier = 'cheap'
      reason = `subagent ${reason}`
    } else {
      tier = assessment.tier
      if (state.pendingFloor !== null) {
        tier = bumpTier(tier, Math.max(0, TIERS.indexOf(state.pendingFloor) - TIERS.indexOf(tier)), cfg.minTier, cfg.maxTier)
        reason = `after-error ${reason}`
        state.pendingFloor = null
      }
    }
    tier = clampTier(tier, cfg.minTier, cfg.maxTier)

    state.turn = payload.turn
    state.tier = tier
    state.score = assessment.score
    state.reason = reason
    state.decidedAt = Date.now()
    state.hasImages = hasImage(messages)
    state.toolErrors = 0
    state.escalations = 0
    state.stats.turns += 1
    state.stats[tier] += 1
    state.manualTurn = -1
    state.restored = false
  }

  /**
   * 插件被热替换/重载时，内存里的轮次决策会丢；从决策日志里把当前轮找回来，
   * 免得同一轮的后半程突然回到默认模型。
   */
  const restoreDecision = async (state, turn) => {
    if (state.restored || cfg.log.decisions !== true) return false
    state.restored = true
    try {
      const text = await readFile(path.join(logDir, 'decisions.jsonl'), 'utf8')
      const lines = text.trimEnd().split('\n')
      for (let index = lines.length - 1; index >= 0 && index >= lines.length - 500; index -= 1) {
        let entry
        try {
          entry = JSON.parse(lines[index])
        } catch {
          continue
        }
        if (entry?.sessionId !== state.sessionId || entry.turn !== turn || !TIERS.includes(entry.tier)) continue
        state.turn = turn
        state.tier = entry.tier
        state.score = typeof entry.score === 'number' ? entry.score : 0
        state.reason = `restored ${entry.reason ?? ''}`.trim()
        state.hasImages = entry.images === true
        state.decidedAt = Date.parse(entry.at) || Date.now()
        // 刚恢复的这一轮不做手动检测：重载后 base 仍是入口默认值，
        // 与 header 不同是必然的，不是用户刚改过。
        state.justRestored = true
        return true
      }
    } catch {
      /* 日志不存在或读不了就当作没有历史 */
    }
    return false
  }

  // --------------------------------------------------------------- request
  /** 在真正的请求配置上落档；上游（手动选择）变化时按配置让位。 */
  const onRequest = async (payload, base) => {
    if (!enabled) return base
    const agent = payload.agent
    const state = agent === undefined ? undefined : stateOf(agent.session?.id)
    if (state === undefined) return base

    // 本轮没有决策（例如插件刚被热替换）：先从日志恢复，恢复不了就透传。
    if (state.turn !== payload.turn || state.tier === null) {
      if (!(await restoreDecision(state, payload.turn))) return base
    }

    const depth = agent.options?.subagentDepth ?? 0
    if (depth > 0 && cfg.subagents === 'off') return base

    // 让位记录是持久化的；即使状态对象早于 loadYields 建好，这里也补一次。
    if (!state.yielded && yields.has(state.sessionId)) {
      state.yielded = true
      state.yieldKind = yields.get(state.sessionId)?.kind ?? null
    }

    // 手动选择检测：以「上一次真正生效的请求配置」和「插件自己写过的配置」为基准。
    // 只看 provider/model 会漏掉「只改推理强度」这种手动操作，所以三者一起比。
    const headerConfig = agent.session?.requestHeader?.()?.config
    const skipManualCheck = state.justRestored === true
    state.justRestored = false
    const isOwnEcho = state.applied !== null && sameConfig(base, state.applied)
    const differsFromHeader = headerConfig !== undefined && !sameConfig(base, headerConfig)
    if (!skipManualCheck && differsFromHeader && !isOwnEcho && cfg.manualOverride !== 'ignore') {
      const kind = base.model !== headerConfig.model ? 'model' : 'effort'
      state.yieldKind = kind
      if (cfg.manualOverride === 'session') {
        state.yielded = true
        yields.set(state.sessionId, { kind, at: nowIso() })
        void saveYields()
      } else {
        state.manualTurn = payload.turn
      }
      if (cfg.verbose) ctx.logger.info(`[model-budget-router] manual ${kind} selection detected; standing down`)
      return base
    }
    if (state.yielded) return base
    if (state.manualTurn === payload.turn) return base

    const target = await resolveTarget(state.tier, base, { requireImage: state.hasImages === true })
    if (target === null) {
      const key = `${state.tier}/${base.provider}`
      if (!warnedTargets.has(key)) {
        warnedTargets.add(key)
        warn(`no usable model for tier "${state.tier}" on provider "${base.provider}"; passing the request through`)
      }
      return base
    }

    const next = { ...base, provider: target.provider, model: target.model }
    if (target.effort === null) delete next.reasoningEffort
    else if (target.effort !== undefined) next.reasoningEffort = target.effort

    if (sameRoute(base, next) && base.reasoningEffort === next.reasoningEffort) {
      state.applied = next
      return base
    }

    recordDecision(state, base, target, state.reason)
    if (dryRun) return base
    state.applied = next
    state.yielded = false
    return next
  }

  // -------------------------------------------------------------- session
  /** 工具连续报错或整轮失败时，为后续步骤/下一轮留出升级证据。 */
  const onSessionEvent = (session, event) => {
    if (!enabled) return
    const state = session === undefined ? undefined : sessions.get(session.id)
    if (state === undefined) return

    if (event.type === 'tool/result' && event.data?.turn === state.turn) {
      if (event.data?.message?.isError === true) {
        state.toolErrors += 1
        const threshold = cfg.escalation.afterToolErrors
        if (threshold > 0 && state.toolErrors >= threshold && state.tier !== cfg.maxTier) {
          const nextTier = bumpTier(state.tier, 1, cfg.minTier, cfg.maxTier)
          if (nextTier !== state.tier) {
            state.tier = nextTier
            state.escalations += 1
            state.stats.escalations += 1
            state.reason = `${state.reason} tool-errors:${state.toolErrors}`
            state.applied = null
            if (cfg.verbose) ctx.logger.info(`[model-budget-router] escalating to ${nextTier} after ${state.toolErrors} tool errors`)
          }
        }
      }
      return
    }

    if (event.type === 'turn/end' && event.data?.turn === state.turn) {
      const kind = event.data?.reason?.kind
      if (kind === 'error' && cfg.escalation.afterTurnError && state.tier !== cfg.maxTier) {
        state.pendingFloor = bumpTier(state.tier, 1, cfg.minTier, cfg.maxTier)
      }
    }
  }

  // ---------------------------------------------------------------- command
  const statusText = (agent) => {
    const state = agent === undefined ? undefined : sessions.get(agent.session?.id)
    const tierLine = TIERS.map((tier) => {
      const spec = cfg.tiers[tier]
      const usable = usability?.[tier]
      const mark = usable?.usable === false ? ' ⚠不可用' : ''
      return `${tier}=${spec.model}@${spec.effort}${mark}`
    }).join('  ')
    const headerConfig = agent?.session?.requestHeader?.()?.config
    const lines = [
      `模型省钱路由 · ${enabled ? '已启用' : '已停用'}${dryRun ? '（仅观察，不切换）' : ''}`,
      `provider: ${cfg.provider}`,
      `档位: ${tierLine}`,
      `阈值: ≤${cfg.rules.thresholds.cheap} → cheap；≥${cfg.rules.thresholds.strong} → strong；其余 standard`,
      `升级: 同轮工具报错 ≥${cfg.escalation.afterToolErrors} 次${cfg.escalation.afterTurnError ? '，或整轮失败后' : ''}上一档`,
      `手动选择: ${cfg.manualOverride === 'session' ? '让位到本会话结束' : cfg.manualOverride === 'turn' ? '让位到本轮结束' : '忽略'}`,
    ]
    if (headerConfig !== undefined) {
      lines.push(`实际生效: ${headerConfig.provider}/${headerConfig.model} @${headerConfig.reasoningEffort ?? '模型默认'}`)
    }
    if (state === undefined) {
      lines.push('本会话: 还没有路由记录')
    } else {
      const s = state.stats
      lines.push(`本会话: ${s.turns} 轮 · cheap ${s.cheap} / standard ${s.standard} / strong ${s.strong} · 升级 ${s.escalations} 次`)
      lines.push(`当前: ${state.tier ?? '未决定'}${state.reason ? `（${state.reason}）` : ''}`)
      lines.push(`接管: ${state.yielded
        ? `已让位（检测到你手动改了${state.yieldKind === 'effort' ? '推理强度' : '模型'}）· /budget on 可收回`
        : '生效中'}`)
      const recent = state.decisions.slice(-3).map((entry) => `${entry.tier}(${entry.score})`)
      if (recent.length > 0) lines.push(`最近: ${recent.join(' ← ')}`)
    }
    lines.push(`日志: ${path.join(logDir, 'decisions.jsonl')}`)
    lines.push('用法: /budget on | off | reset')
    return { kind: 'success', text: lines.join('\n') }
  }

  const commandHandler = (invocation) => {
    const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
    const agent = invocation?.agent
    if (argument === 'on') {
      enabled = true
      dryRun = false
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string') yields.delete(sessionId)
      const state = agent === undefined ? undefined : sessions.get(agent.session?.id)
      if (state !== undefined) {
        state.yielded = false
        state.yieldKind = null
      }
      void saveYields()
      void writeStatus({ changedAt: nowIso() }).catch(() => {})
      return { kind: 'success', text: '模型省钱路由已启用，并收回了对本会话手动选择的让位（本次运行内有效；持久开关请用「插件」页）。' }
    }
    if (argument === 'off') {
      enabled = false
      void writeStatus({ changedAt: nowIso() }).catch(() => {})
      return { kind: 'success', text: '模型省钱路由已停用，请求保持原模型（本次运行内有效）。' }
    }
    if (argument === 'reset') {
      if (agent !== undefined) sessions.delete(agent.session?.id)
      return { kind: 'success', text: '已清空本会话的路由状态。' }
    }
    return statusText(agent)
  }

  // ----------------------------------------------------------------- setup
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      onPreStep(payload, decision)
    } catch (error) {
      warn(`pre-step assessment failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  })

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    try {
      return await onRequest(payload, base)
    } catch (error) {
      warn(`request routing failed: ${error instanceof Error ? error.message : String(error)}`)
      return base
    }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session, event)
    } catch (error) {
      warn(`session event handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(function* registerBudgetCommand() {
      yield commands.register({
        name: 'budget',
        description: '模型省钱路由：查看状态，或 on/off/reset',
        input: { hint: 'on | off | reset' },
        handler: commandHandler,
      })
    }, 'model-budget-router command')
  }

  // 先恢复「哪些会话已经让位给手动选择」，再开始自检，避免重启后插件重新抢管。
  void loadYields().catch(() => {})

  // 启动自检：解析每个档位的模型能力，把结果写进 status.json。
  // 模型不可用不会让插件失效，只是该档会按 resolveTarget 的规则回退。
  const runSelfCheck = async (retryLeft = 1) => {
    const report = {}
    let pending = false
    for (const tier of TIERS) {
      const model = cfg.tiers[tier].model
      const info = await effortsFor(cfg.provider, model)
      if (info.error !== undefined) {
        pending = pending || info.transient === true
        report[tier] = { model, usable: false, error: info.error, transient: info.transient === true }
        continue
      }
      report[tier] = {
        model,
        usable: true,
        efforts: info.efforts ?? null,
        contextWindow: info.contextWindow ?? null,
        modalities: info.modalities ?? null,
      }
    }
    await writeStatus({ config: cfg, tiersUsable: report })
    usability = report
    if (pending && retryLeft > 0) {
      ctx.effect(() => {
        const timer = setTimeout(() => {
          void runSelfCheck(retryLeft - 1).catch(() => {})
        }, 8000)
        return () => clearTimeout(timer)
      }, 'model-budget-router self-check retry')
    }
  }

  void runSelfCheck().catch((error) => {
    warn(`self-check failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}
