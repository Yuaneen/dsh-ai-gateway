# dsh-ai-gateway-budget

> **AI Gateway + 预算治理** 的 MVP 骨架：把 DSH 里所有模型调用收口到一个准入网关，做 token/费用计量、会话/日/月预算、`alert / block / degrade` 策略，以及可审计的花费归属。

这是一个**可运行的插件骨架**（零运行时依赖、无构建步骤），不是一个已经发布的产品。设计目标是先把「网关的治理面」做对：所有流量都经过同一个决策点，预算和账本不依赖某个 UI 或某个 provider。

- 39 个单元/集成测试全部通过（`node --test`）
- 在隔离的 DSH `0.2.2-rc.1` web profile 中实际启动成功，`GET /ai-gateway/v1/status` 返回 200
- 无 TypeScript 构建、无 npm 运行时依赖；标准安装路径是 `dsh plugin --profile web add ./packages/dsh-ai-gateway`

---

## 1. 为什么是“网关”

DSH 的每个模型调用——主循环、子代理、会话标题、压缩摘要——都会经过 `llm/stream` waterfall。这是宿主里唯一一个能同时看到**请求前**和**用量后**的接缝：

```text
agent loop / subagent / title / compaction
                    │
                    ▼
        ┌───────────────────────────┐
        │  llm/stream waterfall     │
        │  ① admission（预算准入）   │
        │  ② forward（原样放行）     │
        │  ③ meter（usage 计量）     │
        └───────────┬───────────────┘
                    │ TokenUsage
                    ▼
        ┌───────────────────────────┐
        │  ledger + pricing         │
        │  session / day / month    │
        │  alert / block / degrade  │
        └───────────┬───────────────┘
                    │
      ┌─────────────┴─────────────┐
      ▼                           ▼
  /gateway 命令            HTTP 控制面
  （会话内）                /ai-gateway/v1/*
```

所以 MVP 的「网关」是 **DSH 模型调用的统一准入层**，而不是另起一个 LiteLLM 式的独立代理进程。对外 OpenAI 兼容入口放在 v0.3（见路线图），它复用同一套预算与账本。

为什么不用 `agent/request`：该接缝已标记 deprecated，且明确要求不能改 provider/model（只能改 controls）。`llm/stream` 才是覆盖全部调用、且能在 `next()` 之前拦截的地方。

---

## 2. MVP 范围（v0.1）

**做：**

- 所有 `llm/stream` 调用的准入检查与用量计量
- 三个预算作用域：`session` / `daily` / `monthly`（USD 记账）
- 三种超限策略：`alert` / `block` / `degrade`
- 峰谷计价（北京时间工作日 09:00–12:00、14:00–18:00，周末/节假日谷价）
- 未知模型不猜价格：按 0 计入并告警，可用 `pricing.prices` 补
- 花费归属：按模型、按会话、按日/月
- `/gateway` 命令：`status` / `usage` / `unblock <scope>`
- HTTP 控制面：只读 status/usage + 受控 unblock
- JSON 账本持久化（原子写 + 防抖）

**不做（明确留到后续版本）：**

- 外部 OpenAI 兼容入口（`POST /v1/chat/completions`）
- 多租户 / API key / 每 key 配额
- 客户端设置页与状态胶囊（当前用 `/gateway` 命令）
- 按任务复杂度自动选模型（当前只有显式 `degradation` 映射）
- 工具调用费用（web search / fetch 等）与图片视觉 token 的精细计价
- 完整的中国法定节假日表

---

## 3. 一次调用的时序

```text
onLlmStream(options, next)
  ├─ 已降级请求？ ── 是 ──▶ 只计量（防止再次准入造成循环）
  ├─ sessionId = options.sessionId ?? lastSessionId ?? "__global__"
  ├─ totals = ledger.totals(sessionId, now)
  ├─ decision = evaluateBudget(totals, budgets, overrides, model)
  │
  ├─ block   ──▶ blockedStream(原因 + /gateway unblock 提示)
  ├─ degrade ──▶ llm.stream({ ...options, model: 更便宜模型 })
  │              └─ 重新进入 waterfall，命中 rewritten 守卫，只计量
  ├─ warn    ──▶ 冷却窗口内记一条日志，然后正常放行
  └─ allow   ──▶ next()
                   └─ 遇到第一个 usage chunk：
                        price = priceForModel(route, now)
                        cost  = costOf(usage, price)
                        ledger.record(...)
```

关键点：

- **阻塞不是抛错**：返回一个正常的 assistant 文本流 + `finish { kind: 'error', failure.code: 'BUDGET_BLOCKED' }`，让 agent loop 正常结算这一步，而不是把它当成传输故障去重试。
- **降级不无限递归**：被降级的请求对象放进 `WeakSet`，重新进入 waterfall 时跳过准入、只计量。
- **计量按 usage chunk**：provider 没回 usage 的失败调用不计费，不编造估算值。

---

## 4. 预算决策矩阵

| 条件 | `alert` | `block` | `degrade` |
|---|---|---|---|
| 所有 scope 均低于 `warnRatio` | allow | allow | allow |
| 最高 scope ≥ `warnRatio`，未到 cap | warn | warn | `degradeAt: warn` 且存在映射 → degrade；否则 warn |
| 任一 scope ≥ cap | warn（`over: true`） | block | 存在映射 → degrade；否则 block |
| 用户执行 `unblock <scope>` | 记录 watermark | 在 watermark 之前不再 block | 同 block |

`unblock` 的语义是**按当前花费打一个水位线**：花费继续增长并越过水位线后会重新拦截，避免“解一次就永久失效”。

`degradation` 只允许同 provider 的模型映射（例如 `deepseek-v4-pro → deepseek-v4-flash`）。跨 provider 的上下文窗口、工具 schema、视觉能力都可能不同，MVP 不做。

---

## 5. 配置

完整示例见 [`cordis.patch.yml`](./cordis.patch.yml)；所有字段在 `src/config.js` 中校验，非法值直接让插件加载失败（fail loud，不静默关掉预算）。

```yaml
- insert:
    - id: ai-gateway
      name: dsh-ai-gateway-budget
      config:
        budgets:
          session: 2      # USD；null/省略 = 不限
          daily: 10
          monthly: 100
        warnRatio: 0.8
        overLimit: block  # alert | block | degrade
        degradation:
          deepseek-v4-pro: deepseek-v4-flash
        degradeAt: warn   # warn | hard
        currency: { code: CNY, rate: 7.2, decimals: 3 }
        pricing:
          prices: {}      # USD / 1M tokens，覆盖内置快照
          peak:
            enabled: true
            timeZone: Asia/Shanghai
            offPeakMultiplier: 0.5
        gateway:
          http: true
          basePath: /ai-gateway
          token: ''       # 非空时所有控制面请求需 Bearer
        persistence:
          enabled: true
          file: $DSH_HOME/ai-gateway/ledger.json
          flushMs: 500
```

字段表：

| 字段 | 默认 | 说明 |
|---|---|---|
| `budgets.session/daily/monthly` | `2 / 10 / 100` USD | `null` 为不限；`0` 被拒绝（不是合法的 cap） |
| `warnRatio` | `0.8` | 首次预警比例 |
| `overLimit` | `block` | 超限动作 |
| `degradation` | `{}` | 模型 → 更便宜的同 provider 模型 |
| `degradeAt` | `warn` | 仅 `degrade` 生效：warn 阶段还是 hard 阶段开始降级 |
| `pricing.prices` | `{}` | 覆盖内置价格表，key 支持 `model` 或 `provider/model` |
| `pricing.defaultPrice` | 见源码 | 未定价模型的兜底；`priced: false` 时按 0 计入 |
| `pricing.peak.windows` | 工作日两段 | 可自定义星期/时段 |
| `pricing.peak.holidays` | `[]` | `YYYY-MM-DD`，全天谷价 |
| `gateway.http` | `true` | 是否注册控制面 |
| `gateway.token` | `''` | 空 = 仅回环可读；非空 = Bearer 校验 |
| `persistence.file` | `$DSH_HOME/ai-gateway/ledger.json` | 支持 `~` / `$DSH_HOME` |

---

## 6. 控制面

### `/gateway` 命令

```text
/gateway                 # 会话/今日/本月花费 + 当前策略
/gateway usage           # 按模型归属（Top 10）
/gateway unblock session # 解除当前水位线之前的 session block
/gateway help
```

### HTTP API

挂载在 `gateway.basePath`（默认 `/ai-gateway`），只注册一个 prefix 路由：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/status?session=<id>` | 预算/花费/策略/覆盖水位 |
| `GET` | `/v1/usage?session=<id>` | 花费 + 按模型归属 |
| `POST` | `/v1/unblock` | body `{ scope, sessionId? }` |

安全默认值：

- `gateway.token` 为空时，只允许回环地址（`127.0.0.1` / `::1` / IPv4-mapped）访问；
- 配置 token 后，所有请求必须带 `Authorization: Bearer <token>`；
- 写操作只有 `unblock`，且同样是幂等水位线语义。

实测（隔离 profile，`--port 0`）：

```text
GET  /ai-gateway/v1/status  -> 200 {"ok":true,...}
GET  /ai-gateway/v1/usage   -> 200 {"ok":true,"data":{"models":[]...}}
POST /ai-gateway/v1/unblock -> 200 {"ok":true,"scope":"session"...}
```

---

## 7. 计价与归属

- DSH 的 `TokenUsage` 四个桶是**互斥**的：`inputTokens`（未缓存输入）、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`。每个桶只计一次价。
- 内置价格表是 USD / 1M tokens 的**峰时快照**（与 `dsh-budget` 同源，2026-11 口径），谷时乘以 `offPeakMultiplier`（默认 0.5）。上生产前请对照官方价目页，用 `pricing.prices` 覆盖。
- 内置表覆盖 `deepseek-chat`、`deepseek-reasoner`、`deepseek-flash`、`deepseek-v4-flash*`、`deepseek-v4-pro`。其余模型走 `defaultPrice`；默认 `priced: false`，计 0 并在日志里告警一次。
- 归属精度：
  - `llm/stream` 的 `usage` 是权威来源；
  - 带 `sessionId` 的调用记到该会话；
  - 不带 `sessionId` 的辅助调用（标题/压缩）回退到最近活跃会话，再回退到 `__global__`；
  - 重试的每次尝试各自计量（provider 实际计费）。

---

## 8. 持久化

`src/store.js` 把账本序列化为 JSON：

- 进程内 Map → `serialize()` → 原子写（`tmp` + `rename`，`0600`）；
- 写入防抖 `persistence.flushMs`，插件 dispose 时强制 flush；
- 启动时 `restore()` 逐桶校验，损坏的桶忽略，不阻塞启动；
- 未启用持久化时退化为纯内存（重启归零），与 `dsh-budget` 的 degraded 行为一致。

---

## 9. 与现有插件的关系

| 插件 | 它强在哪 | 本骨架的差异 |
|---|---|---|
| `dsh-budget` | 成熟的 alert/block/degrade + 碳排/延迟/设置页 | 已冻结；本骨架把「网关准入 + 指令控制面 + HTTP 控制面」作为核心，不绑定客户端 UI |
| `dsh-cost-meter` | 展示最全、更新最勤、订阅额度 | 以展示/提醒为主，不硬拦；本骨架默认 `block` |
| `dsh-router-core` | 真正的 OpenAI/Anthropic/Gemini 四协议网关 | 有路由与账号池，但没有预算/费用；本骨架是治理面，v0.3 再补对外入口 |
| `dsh-usage-guard` | 日 token/费用上限 + 出网前拦截 | 仅日维度；本骨架三作用域 + 降级 + 归属 |

换句话说：**v0.1 先把“谁能花、花到哪、超了怎么办”做对；v0.3 再把“外部请求怎么进来”接上**。

---

## 10. 安装与开发

```bash
# 本地包安装到 web profile（会插入 bundle patch）
dsh plugin --profile web add ./packages/dsh-ai-gateway

# 重启 dsh web 后
/gateway
curl http://127.0.0.1:3080/ai-gateway/v1/status
```

开发：

```bash
cd packages/dsh-ai-gateway
node --test test/*.test.js   # 39 tests
npm run check                # node --check 全部源码
```

目录：

```text
packages/dsh-ai-gateway/
├── package.json          # dsh.bundle.patch + engines
├── cordis.patch.yml      # 默认配置 / profile 插入行
├── src/
│   ├── index.js          # cordis 接线（llm/stream, commands, webServer）
│   ├── gateway.js        # 准入、计量、控制面核心（可脱离 cordis 测试）
│   ├── config.js         # 默认值 + 严格校验
│   ├── pricing.js        # 价格表、峰谷、金额格式化
│   ├── policy.js         # 纯预算决策引擎
│   ├── ledger.js         # 会话/日/月/模型账本
│   ├── store.js          # 原子 JSON 持久化
│   └── stream.js         # 阻塞流 + usage 旁路计量
└── test/                 # 39 个测试（含假 ctx 的端到端接线）
```

---

## 11. 路线图

**v0.2 — 可日常使用**

- 客户端状态胶囊 + 设置页（沿用官方 `slots` / settings 接缝）
- 按 provider 的预算上限
- 用 `storage-domain` 替代手写 JSON
- 审计事件（block/degrade/unblock）写入会话日志或独立账本

**v0.3 — 对外 AI Gateway**

- `POST /v1/chat/completions`、`/v1/messages`（OpenAI/Anthropic 兼容）
- API key → 租户/配额映射，流式翻译，tool calls
- 复用同一 `Ledger` 与 `evaluateBudget`，按 key 加一层 `tenant` scope

**v0.4 — 优化**

- 在 `agent/pre-step` 用 `agent.model.select()` 做真正的按任务分级路由（而不是只在 `llm/stream` 里事后改模型）
- 前缀缓存友好：稳定 system/tools 前缀，减少 cache miss
- 峰谷调度：高峰只拦“可延后”的任务，谷时自动续跑

---

## 12. 已知限制（务必读）

1. **降级发生在请求头记录之后**：会话日志的 `request/header` 仍记录原模型，账本按实际下发的便宜模型计。两者可能不一致。缓解：只做同 family 映射，记录审计日志；v0.4 把路由前移到 `agent/pre-step`。
2. **工具调用费用未计**：DeepSeek 的 web search/fetch、文件解析等按次计费，不在 `TokenUsage` 里。
3. **`unblock` 是水位线，不是永久开关**：花费继续增长会重新拦截。
4. **辅助调用归属**：没有 `sessionId` 的调用可能落到最近活跃会话，严格审计场景应改为 `__global__`。
5. **HTTP 默认只读且仅回环**：把 `dsh web` 暴露到 LAN 前务必设置 `gateway.token`。
6. **价格表是快照**：内置数字仅作起点，生产前用官方价目覆盖。
7. **进程内聚合 + JSON 持久化**：多进程/多实例部署时账本不共享；v0.3 的多租户入口需要外部存储。

---

## License

MIT
