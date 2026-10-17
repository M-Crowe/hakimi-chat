# DeepSeek Harness (DSH) 伴聊大脑集成与 Token 计费审计指南

本文档介绍如何将 **DeepSeek Harness (DSH)** 作为哈基米聊天系统的伴聊大脑客户端，实现与 Antigravity 客户端对等复用、长轮询消息消费、原生 MCP 发信与 DeepSeek 模型物理 Token 阶梯计费审计。

---

## 🏗️ 架构拓扑与复用设计

```
                           ┌───────────────────────────────┐
                           │      SnowLuma (OneBot 11)     │
                           └───────────────▲───────────────┘
                                           │ WS: 3000
┌──────────────────────────────────────────▼──────────────────────────────────────────┐
│                   哈基米聊天系统守护进程 (Bridge Daemon : 34567 / 5120)                │
│   • SQLite WAL 原子消息队列 (inbox_queue)                                           │
│   • 社交动力学决策 & 标签拦截器 (好感度 [af:±x]、时空 [state:...]、黑话 [slang:...])   │
│   • 双引擎用量监测与审计 (Antigravity & DSH)                                        │
└───────────────────▲───────────────────────────────────────▲─────────────────────────┘
                    │                                       │
     (对等复用 1: Antigravity 伴聊)            (对等复用 2: DSH 伴聊)
                    │                                       │
    ┌───────────────┴───────────────┐       ┌───────────────┴───────────────┐
    │       Antigravity IDE         │       │     DeepSeek Harness (DSH)    │
    │  • MCP: agy-tomoko-mcp        │       │  • MCP: agy-tomoko-mcp        │
    │  • wait-for-qq-message.mjs    │       │  • wait-for-qq-message.mjs    │
    │  • Gemini / Claude 模型       │       │  • DeepSeek-V3 / R1 / Flash   │
    │  • Google KV Cache 命中监测   │       │  • DeepSeek 官方 KV Cache 计费│
    └───────────────────────────────┘       └───────────────────────────────┘
```

---

## 🚀 方式一：一键自动配置 (推荐)

在项目根目录下直接运行：

```bash
npm run setup:dsh
# 或者指定自定义 profile / DSH 目录
node scripts/setup-dsh.mjs web
```

脚本会自动完成：
1. 检测 `~/.dsh` 根目录（或由环境变量 `DSH_HOME` 指定）；
2. 自动在 `~/.dsh/profiles/web/cordis.patch.yml`（及 `desktop`）中注册 `agy-tomoko-mcp` 服务；
3. 将专属伴聊 Skill 规范同步至 `~/.dsh/skills/tomoko-bridge/SKILL.md`；
4. 自动备份旧配置（`cordis.patch.yml.bak-<timestamp>`），保证幂等与安全；
5. 更新 `config.json` 中的 `dsh` 配置节。

---

## 🛠️ 方式二：手动配置说明

若你的 DSH 安装在非标准目录，或希望手动维护配置，可按以下步骤操作：

### 1. 注册 MCP 服务 (`cordis.patch.yml`)
打开 DSH 配置文件（例如 `~/.dsh/profiles/web/cordis.patch.yml`），在最外层 YAML 列表中添加：

```yaml
- insert:
    - id: agy-tomoko-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agy-tomoko-mcp
        transport: stdio
        command: 'node'
        args:
          - 'D:/dsh/agy/chat/src/mcp-server.mjs' # 替换为实际项目绝对路径
        toolCallTimeoutMs: 725000
```

### 2. 配置 DSH 伴聊 Skill
在 `~/.dsh/skills/tomoko-bridge/` 目录下创建 `SKILL.md`，内容包含让 DSH 在会话中执行 `node scripts/wait-for-qq-message.mjs` 以及调用 `qq_send_message` 的指令指引。

---

## 📡 运行时操作流程

### 1. 启动哈基米网关守护进程
确保守护进程在后台运行：
```powershell
node src/bridge-daemon.mjs
```

### 2. 在 DSH 会话中消费消息
在 DSH 客户端会话中输入：
> "启动哈基米伴聊大脑，监听 QQ 消息并进入伴聊响应循环"

DSH 会按规范执行：
1. 运行长轮询脚本监听新消息：
   ```powershell
   node scripts/wait-for-qq-message.mjs
   ```
2. 当有新消息返回 `NEW_QQ_MESSAGE:{...}` 时，分析语境生成潜意识决策 `<social_decision>` 与回复文本 `<reply>`；
3. 调用 MCP 工具 `qq_send_message` 发送回复，网关自动完成标签拦截与好感度/时空身位入库。

---

## 💰 DeepSeek Token 阶梯计费与物理用量审计

哈基米聊天系统针对 DeepSeek 模型与 DSH 客户端提供了全套专属计费与审计能力：

### 1. 内置 DeepSeek 价目表
| 模型系列 | 模型别名 | 未命中输入 (¥/1M) | KV Cache 命中 (¥/1M) | 输出 (¥/1M) | 特性 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DeepSeek V3** | `deepseek-v3`, `deepseek-chat` | ¥1.00 | ¥0.10 | ¥2.00 | 1 折极低前缀缓存单价 |
| **DeepSeek R1** | `deepseek-r1`, `deepseek-reasoner` | ¥4.00 | ¥1.00 | ¥16.00 | 包含深度思考推理 Token |
| **DeepSeek V4.1 Flash** | `deepseek-flash`, `deepseek-v4-flash` | ¥1.00 | ¥0.02 | ¥4.00 | 原生 DSH 默认极速模型，0.02元超低缓存 |
| **DeepSeek V4 Pro** | `deepseek-pro`, `deepseek-v4-pro` | ¥4.50 | ¥0.15 | ¥13.50 | 高性能复杂推理 |

### 2. 北京时间峰谷分时定价支持
支持 DeepSeek 官方峰谷分时策略（周末与工作日非高峰时段享受额外半价优惠）。

### 3. Web 看板双端实时切换
访问 Web 管理平台 `http://127.0.0.1:5120`（导航至「Token 用量」）：
- **大脑客户端切换器**：可一键在 **🤖 Antigravity** 与 **🧠 DSH (DeepSeek)** 之间切换；
- **真实会话 ProjCache 审计**：实时提取 DSH `session_projcache`，展示每个会话的物理总用量、KV Cache 提示词命中率（通常达 90%+）、未命中输入、生成输出与预估人民币账单；
- **双端对齐走势图**：直观展示每日物理交互趋势与免重复计算的 Token 节省量。
