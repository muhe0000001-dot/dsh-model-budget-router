# 发布到社区

把这个插件分享出去，有两条路，可以都走。发布所需的字段都已在 `package.json` 里备好（`engines.dsh` 已验证能匹配 `0.2.1-rc.5`）。

## 前置：公开一个 GitHub 仓库

dsh.pub 和 `dsh plugin add github:...` 都要求**组合包在仓库根目录**，也就是仓库根下直接能看到 `package.json`、`cordis.patch.yml`、`lib/`。**不要**把整个文件夹拖进去变成 `<repo>/model-budget-router/package.json`。

### 路线 0：不用装 git（网页上传）

1. GitHub 右上角 **New repository** → 名字填 `dsh-model-budget-router` → Public → 不勾 README/LICENSE/gitignore → Create
2. 进入空仓库，点 **Add file → Upload files**
3. 打开资源管理器进 `C:\Users\34146\.dsh\plugins\model-budget-router\`，**全选里面的文件**（`lib`、`locale`、`test`、`package.json`、`cordis.patch.yml`、`README.md`、`PUBLISHING.md`、`LICENSE`、`icon.svg`、`.gitignore`）拖进上传区
4. 提交信息写 `feat: model budget router v1.6.0` → Commit

拖文件夹本身会多套一层目录，导致校验失败——拖的是「文件夹里的内容」。

### 路线 1：有 git（命令行）

```bash
cd C:/Users/34146/.dsh/plugins/model-budget-router
git init
git add -A
git commit -m "feat: model budget router v1.6.0"
git branch -M main
git remote add origin https://github.com/<you>/dsh-model-budget-router.git
git push -u origin main
git tag v1.6.0 && git push origin v1.6.0
```

### 路线 2：GitHub Desktop

把 `C:\Users\34146\.dsh\plugins\model-budget-router` 添加为本地仓库 → Publish repository（取消勾选 keep private）→ 即可。

## 路线 A：发布到 npm

```bash
npm login                       # 需要你的 npm 账号
npm publish --access public     # 非 scope 包默认 public，可省略
```

发布后，任何人都能装：

```bash
dsh plugin --profile web add dsh-model-budget-router
```

（`dsh plugin` 是 pnpm 转发器，GitHub 直装也行：`dsh plugin add github:<you>/dsh-model-budget-router`）

## 路线 B：收录进社区目录

### dsh.pub（最省事，无需注册）

打开 <https://dsh.pub/zh/submit/>，粘贴你的公开仓库地址。它会：

1. 把默认分支固定到一个精确 commit
2. 校验组合包契约（元数据 / patch / 运行入口 / README / LICENSE）
3. 校验通过后自动创建并合并 Pull Request，收录进目录

### awesome-dsh-plugin 清单

给 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 提 PR，在 README 的分类表里加一行你的插件（名称、一句话、仓库链接）。

### 供 DSH 内置市场读取的索引条目

如果你的仓库会被某个市场索引收录，条目按「格式 1」是这种形状：

```json
{
  "name": "dsh-model-budget-router",
  "title": { "en": "Model Budget Router", "zh": "模型省钱路由" },
  "description": {
    "en": "Route each turn to a cheap/standard/strong tier by task complexity; zero extra model calls, evidence-based escalation.",
    "zh": "按任务复杂度在 cheap/standard/strong 三档间切换模型与推理强度；评估零额外调用，失败才升级。"
  },
  "author": "<你的名字>",
  "icon": "./icon.svg",
  "versions": [
    {
      "version": "1.6.0",
      "publishTimestamp": 1762185600,
      "source": { "type": "npm" }
    }
  ]
}
```

## 注意

- 默认 `provider` 是 `deepseek-account`（官方账号登录路由）。走 API key 的用户要用 `provider: deepseek-official` 并在 `tiers` 里填自己的模型，README 里写清楚即可。
- 插件会把决策和让位记录写到 `$DSH_HOME/storages/model-budget/`，**不含任何提示词原文或密钥**，可放心分享。
