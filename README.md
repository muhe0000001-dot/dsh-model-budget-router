# dsh-model-budget-router

按任务复杂度自动切换**模型**和**推理强度**的 DeepSeek Harness 插件，目标是省钱。

- 只用启发式规则评估任务，**不额外调用模型**评估，所以评估本身是零成本。
- 决策按「轮」粘住：一个用户任务（含它后续所有工具步）用同一档模型，不会逐步跳模型把 KV 前缀缓存打散。
- 失败有证据才升级：同一轮内工具连续报错、或整轮失败，才上一档。
- 任何异常都退回原配置，不会把一轮对话搞挂。

## 怎么判定

每次新的用户指令进来时（`agent/pre-step` 的 step 1）打分：

| 信号 | 加分 |
|---|---|
| 长度：≥90 / ≥300 / ≥800 / ≥2000 字 | +1 / +2 / +3 / +4 |
| 代码块 ≥1 / ≥3 个 | +2 / +3 |
| 出现 diff（`--- a/`、`+++ b/`） | +3 |
| 高难度词（架构、重构、实现、写一个、插件、编译器…） | 每个 +3，最多 +9 |
| 工作类词（修复、排查、报错、测试、分析、优化…） | 每个 +2，最多 +6 |
| 低成本词（翻译、改名、格式化、总结、解释一下…） | 每个 −3，最多 −6 |
| 多个问号 / 多步骤编号 | 各 +1 |
| 带图片 | +1（且只会路由到支持图片的模型） |

分档：`score ≤ 2` → **cheap**；`score ≥ 7` → **strong**；其余 **standard**。

默认档位：

| 档位 | 模型 | 推理强度 |
|---|---|---|
| cheap | deepseek-flash | low |
| standard | deepseek-flash | high |
| strong | deepseek-v4-pro | high |

模型会在启动后按账号目录校验：`strong` 模型不可用时自动降级到 `standard`，仍不可用则原样透传（不会报错）。`cheap`/`standard` 若共用同一模型，省的是思考 token。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里那条 `model-budget-router` 行的 `config`：

```yaml
- insert:
    - id: model-budget-router
      name: dsh-model-budget-router
      config:
        provider: deepseek-account
        tiers:
          cheap:    { model: deepseek-flash,   effort: low }
          standard: { model: deepseek-flash,   effort: high }
          strong:   { model: deepseek-v4-pro,  effort: high }
        rules:
          thresholds: { cheap: 2, strong: 7 }
        escalation:
          afterToolErrors: 2
          afterTurnError: true
        manualOverride: session
        subagents: off
        log:
          decisions: true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `provider` | `deepseek-account` | 只接管这个 provider 的会话 |
| `tiers.<档>.model` | 见上 | 该档使用的模型 id |
| `tiers.<档>.effort` | 见上 | `low`/`high`/任意强度词、`default`（交回模型默认）、`inherit`（沿用原值） |
| `minTier` / `maxTier` | `cheap` / `strong` | 允许的档位范围 |
| `rules.thresholds` | `{cheap:2, strong:7}` | 分档阈值，调低更容易升级 |
| `rules.cheapKeywords` 等 | 内置 | 三个词表，会整表替换 |
| `rules.lengthSteps` | `[90,300,800,2000]` | 长度加分的四个台阶 |
| `escalation.afterToolErrors` | `2` | 同轮工具报错几次后升一档（`0` 关闭） |
| `escalation.afterTurnError` | `true` | 整轮失败后，下一轮至少升一档 |
| `subagents` | `off` | `off` 不管子代理；`cheap` 子代理一律用便宜档；`inherit` 同主代理 |
| `manualOverride` | `session` | 检测到你手动换模型后：`session` 让位到会话结束、`turn` 只让位本轮、`ignore` 忽略 |
| `allowThinkingOff` | `false` | 是否允许把思考关到 `off`（默认禁止，见下文） |
| `dryRun` | `false` | 只记录不切换，用来先观察 |
| `log.decisions` | `true` | 把每次决策写进 JSONL |
| `log.dir` | `$DSH_HOME/storages/model-budget` | 日志目录 |
| `verbose` | `false` | 每次切换打一行 info 日志 |

## 和你手动选模型 / 改推理强度怎么共存

**默认不会打架：手动优先。**

插件每一轮都会把「本次请求想用的配置」和「会话上一次真正生效的配置（`request/header`）」比一次，三个字段都比：provider、model、`reasoningEffort`。

- 两者一样 → 是正常继承，插件按自己的判断落档。
- 不一样，但等于插件自己上次写下去的值 → 是插件自己的回声，不算手动。
- 其余情况 → 判定为你手动改过，**立刻让位**，本会话不再接管。

| `manualOverride` | 你手动改之后的行为 |
|---|---|
| `session`（默认） | 让位到本会话结束，插件不再插手；`/budget on` 可收回。**记录会落盘，重启后依然让位** |
| `turn` | 只让位当前这一轮，下一轮恢复自动 |
| `ignore` | 完全忽略你的手动选择，下一轮照旧覆盖 —— 这才是"会打架"的模式 |

**推荐的用法：**

- 平时就用手动选型 → 保持 `session`，选完插件自动退场。
- 想彻底锁定某个模型 → 手动选好，再 `/budget off`。
- 只想临时看一眼原生行为 → `/budget off`，看完 `/budget on`。

**怎么查看当前到底谁说了算：**

```text
/budget
  实际生效: deepseek-account/deepseek-flash @low    ← 请求头里真正在用的
  接管: 生效中                                       ← 或「已让位（检测到你手动改了推理强度）」
  当前: cheap（chars:22）                            ← 插件本轮的判断
```

三行对照就能看出：插件判了什么、实际用了什么、现在谁在管。

## 命令

- `/budget` —— 当前配置、本会话各档次数、最近的决策。
- `/budget off` —— 本次运行内停用（不改配置文件）。
- `/budget on` —— 重新启用，并解除对手动选择的让位。
- `/budget reset` —— 清空本会话的路由状态。

## 可观测

- `$DSH_HOME/storages/model-budget/status.json` —— 启动时间、生效配置、`tiersUsable`（每个档位模型的实际可用性、支持的强度列表、上下文窗口）。插件有没有被加载，看这个文件的时间戳。
- `$DSH_HOME/storages/model-budget/decisions.jsonl` —— 每次切换的记录，含 from/to、档位、分数、原因；不含提示词原文。同一轮重复的相同决策会被去重。
- `$DSH_HOME/storages/model-budget/yields.json` —— 哪些会话已经让位给手动选择（7 天后自动过期）。`/budget on` 会删掉本会话那条。

### 怎么确认它**真的**改了请求

`decisions.jsonl` 只证明插件做了决策，不证明请求被改。真正的证据在会话日志里——每次请求配置变化都会追加一条 `request/header`：

```text
reason=initial  deepseek-account/deepseek-flash  effort=high
reason=change   deepseek-account/deepseek-flash  effort=low    ← 插件生效的那一步
```

会话日志是 `$DSH_HOME/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`（zstd 分帧压缩，需要逐帧解压）。或者在对话里直接发 `/budget`，它有一行 `实际生效:`，读的就是当前会话请求头。

## 已知限制

- **切换模型会打断 KV 缓存**：所以只按轮决策，不按步。频繁在 flash / pro 之间来回切的长会话，省下的钱可能被重复读入前缀抵消。想更省就只配两档（cheap=standard），只调推理强度。
- **不评估语义**：纯字数/关键词/结构启发式，中文长句可能被低估。调 `rules.thresholds` 或补 `hardKeywords`。
- **默认禁止 `off`**：思考关掉后，同一会话再发带工具调用的请求会被 DeepSeek 拒绝整条历史；宁可多花一点。
- **手动选择优先**：`manualOverride: session` 时，你一旦手动换模型或改强度，本会话就不再自动切（重启后也让位）；要拿回控制权发 `/budget on`。
- **改插件源码要重载**：HMR 只重载 profile 配置与磁盘上已变动的插件文件；改完源码碰一下 profile 的 `cordis.patch.yml` 即可触发重新装配，不必重启应用。

## 插件页

作为组合包装载后，Web 左侧「插件」页会列出 **模型省钱路由**（`dsh-model-budget-router`），带图标和一句话简介，可以在这里启用/停用；停用等价于把它从 `dsh.profile.bundles` 里摘掉，参数仍留在 profile patch 里。

- 标题/简介来自 `locale/zh.json`、`locale/en.json`。
- 图标来自包里的 `icon.svg`。
- 启用状态看 `profiles/desktop/package.json` 的 `dsh.profile.bundles`。

## 分享 / 发布到社区

见 [PUBLISHING.md](PUBLISHING.md)：npm 发布 + dsh.pub 收录 + awesome 清单 PR 的完整步骤，以及市场索引条目的样例。发布所需字段（`engines.dsh`、`LICENSE`、`keywords`、`files`）都已备好。

## 安装 / 卸载

已经作为**组合包**安装，所以在 Web 的「插件」页里能直接看到它，并且可以开关（开关改的是 `package.json` 的 `dsh.profile.bundles`，不是删文件）：

```text
C:\Users\34146\.dsh\plugins\model-budget-router\      插件源码（含 cordis.patch.yml）
C:\Users\34146\.dsh\profiles\desktop\package.json     dependency: link:…；bundles: 含 dsh-model-budget-router
C:\Users\34146\.dsh\profiles\desktop\cordis.patch.yml 行 id: model-budget-router 的 config 覆盖
```

两份 YAML 的分工：组合包的 `cordis.patch.yml` 只负责「把行装进来」，profile 的 `cordis.patch.yml` 只放你的参数覆盖。改参数不用碰插件目录。

卸载：在「插件」页取消选中（或从 `dsh.profile.bundles` 里删掉 `dsh-model-budget-router`），再按需删依赖；这之后 profile patch 里那条覆盖会变成"找不到目标"的警告，顺手删掉即可。

## 测试

```shell
node --test test/policy.test.mjs test/plugin.test.mjs
```

30 个用例：打分/分档/强度映射，用假 ctx 驱动的完整 `agent/pre-step` → `agent/request` 流程（含不可用模型回退、工具报错升级、手动让位、子代理、带图任务），启动自检写盘，热替换后恢复档位，让位记录跨重启，以及两条关键回归——**prepend 覆盖**（入口的会话选择监听器不能把结果改回去）和**手动强度检测**（只改 `effort` 也要让位，插件自己的回声不能被误判）。

## 变更记录

- **1.5.1** 手动让位记录落到 `yields.json`，重启后继续让位；`/budget on` 收回并清盘；补 `locale/` 与 `icon.svg`，插件页显示中文标题和简介。
- **1.5.0** 改成组合包：出现在 Web「插件」页，可开关；手动选择检测扩展到 `reasoningEffort`（只改强度也会让位）；刚热替换恢复的那一轮跳过手动检测，避免误判。
- **1.4.0** 热替换/重载后，若当前轮已有决策，从 `decisions.jsonl` 恢复档位，避免同一轮后半程突然回到默认模型。
- **1.3.0** 启动自检把 `tiersUsable` 写进 `status.json`；`/budget` 增加 `实际生效` 与不可用档位提示；同轮重复决策去重；去掉档位上的 `provider` 字段（唯一 provider 由顶层 `provider` 决定，避免无意义的旋钮）。
- **1.2.0** 关键修复：`agent/request` 监听器改用 `prepend`。此前入口的模型选择监听器注册更早、位于 waterfall 外层，会把插件写好的强度覆盖回去——**插件在决策、请求却没变**。同时补了子代理让位、图片路由、禁止关闭思考三项保护。
- **1.1.0** 带图任务不落到纯文本模型；默认禁止 `off` 思考。
- **1.0.0** 首版。
