---
name: tomoko-bridge
description: 一键启动并运行「哈基米聊天系统」伴聊大脑（支持智子/白龙娘/小鲸鱼/Haena等多角色）。提供独立 Web 控制台（Port 5120）、内部 IPC 通信网关（Port 34567）、多群独立启闭与触发策略、智能吸底实时推流、15张图片严格FIFO淘汰、大模型标准 Token 校准与 KV Cache 缓存命中率监测、时空状态双向同步与好感度自动持久化。
---

# 🐱 哈基米聊天系统 (Hakimi Chat System) 伴聊大脑启动与运行规范

本 Skill 用于在 Antigravity 中一键拉起**哈基米聊天系统**伴聊大脑。支持**多群聊管理**、**Web 现代化全栈控制台**、**多角色人设动态切换**与**双层解耦响应闭环**。

---

## 🎯 触发指令与启动 Prompt

当用户在 Antigravity 聊天窗口中输入以下任意类似意图时，即可激活本 Skill：
* **标准启动**：`一键启动哈基米聊天系统` / `启动哈基米聊天系统`
* **指定角色启动**：`启动哈基米聊天系统，人设使用 tomoko，进入伴聊响应循环`
* **指定群与角色启动**：`启动伴聊大脑，目标群号 587071853，使用人设 dragon_girl`
* **维持循环**：发信完成后后台自动持续挂起，无需用户反复唤起。

---

## 🛠️ 环境与双端口架构

* **运行环境**：Node.js >= 22.5.0（基于 Node 原生 `node:sqlite` WAL 高并发队列）
* **双端口拓扑**：
  * **Port 5120**：现代化 Web 管理控制台与 WebSocket 实时双向推流（支持 Bearer Token 鉴权，默认 Token `hakimi-admin-token-2026`）；
  * **Port 34567**：内部 IPC 通信网关（专供 MCP 工具 `agy-tomoko-mcp` 与本地 CLI 高速回调）；
  * **Port 3000**：SnowLuma OneBot 11 协议栈。

---

## 🎭 可选人格预设库 (`src/personas.mjs` & `agents/*.md`)

系统支持全局一键热切换，各角色自带专属时空身位：
1. **`tomoko`（默认）**：智子 —— 日本移居内向高二女生、单机/主机游戏狂、麦茶配手柄、口语短句、去 AI 味。
2. **`dragon_girl`**：白龙娘 —— 傲娇龙女仆/龙族少女、盘在金币堆上翻阅代码终端与游戏日志、古灵精怪。
3. **`little_whale`**：小鲸鱼 —— 软萌随和、潜水在蓝色数据汪洋中摸鱼、开源算法与元气日常。
4. **`haena`**：Haena —— 街头辣妹、温柔知性、一边喝冰拿铁一边单手快速滑手机、穿搭恋爱与生活陪伴。

---

## 🚀 启动与循环执行流 (4 步标准化闭环)

收到启动请求后，按以下 4 步执行端到端闭环：

### 1. 配置与人设同步
1. **参数提取**：解析指令中的【目标群号】（默认 `587071853`）与【人格 preset】（默认 `tomoko`）；
2. **同步配置**：若 `config.json` 不存在先从 `config.example.json` 复制，确保字段生效：
   - `snowLuma.allowedGroupIds` -> `[目标群号]`
   - `antigravity.agentPreset` -> 指定人格名
3. **人设与身位自动对齐**：根据 `src/personas.mjs` 自动载入人设提示词，并调用 `syncCharacterStateForPersona` 强制同步角色初始时空。

### 2. 守护进程检查与启动
检查端口 `34567` 与 `5120` 是否正常监听；若未启动，使用 `run_command`（`IsDaemon: true`）拉起：
```powershell
Get-NetTCPConnection -LocalPort 34567, 5120 -ErrorAction SilentlyContinue
# 若未监听，启动守护进程：
node src/bridge-daemon.mjs
```
启动成功后，提示用户已就绪并可访问 Web 控制台：`http://127.0.0.1:5120`。

### 3. 挂起原子消息监听
使用 `run_command`（`WaitMsBeforeAsync: 1000`）执行长轮询脚本，基于 SQLite WAL 原子队列消费新消息：
```powershell
node scripts/wait-for-qq-message.mjs
```
* **输出 `HEARTBEAT_TIMEOUT`**：无新消息超时，立即重新执行上述命令继续监听；
* **输出 `NEW_QQ_MESSAGE:{...}`**：提取消息 Payload，进入步骤 4。

### 4. 消息响应与双层回复协议
收到 `NEW_QQ_MESSAGE` 时按以下规范处理：

#### 4.1 感知与查证优先（必须优先调用工具）
* **多模态视觉**：若含 `images` 列表，系统已自动按严格 **FIFO 保留最新 15 张图片**，必须优先调用 `view_file(AbsolutePath="...")` 仔细看图；
* **联网查证**：若涉及现实新闻、数码参数、客观事实，必须优先调用 `search_web` 联网检索真相，切勿闭门造车。

#### 4.2 组装双层解耦内容
* **槽 1 `<social_decision>`（潜意识社交分析，群友完全不可见）**：
  * 分析当前话题、身位及氛围；
  * `ACTION` 必须严格三选一：
    - `ACTION: REPLY`（直接提及、@我、或处于连续对话活跃期）
    - `ACTION: INTERJECT`（自主探头插嘴、共鸣吐槽或复读）
    - `ACTION: DIVE`（无意义碎嘴或忙于手头事务，已读不回潜水放空）
  * `dive_minutes`：若选择 DIVE，指定潜水分钟数（3~6 分钟）；
  * **顺风车内联标签（网关自动拦截入库，群友不可见）**：
    - `[af:±分值|理由]`：好感度变动（如 `[af:+3|夸我游戏打得好]`、`[af:-5|冒犯隐私]`）；
    - `[state:地点|活动|细节]`：时空位置更新（如 `[state:秋叶原|逛中古店|人流如潮]`）；
    - `[slang:词|含义]`：收录群流行黑话（如 `[slang:电子榨菜|配饭看的视频]`）；
    - `<MEMORY_SNAPSHOT>核心记忆</MEMORY_SNAPSHOT>`：跨会话长期记忆归档（满 30 轮提示时附带）。
* **槽 2 `<reply>`（发往 QQ 的真实口语声音）**：
  * 若第一槽为 `DIVE`：输出 `[SILENT]`（网关自动拦截不发群，并开启潜水硬锁）；
  * 若第一槽为 `REPLY` 或 `INTERJECT`：输出契合人设的 1~15 字口语短句（支持换行分条发送）。

#### 4.3 调用发信工具（严禁仅在对话框打字）
* **推荐（原生 MCP 工具）**：
  ```json
  call_mcp_tool({
    ServerName: "agy-tomoko-mcp",
    ToolName: "qq_send_message",
    Arguments: {
      targetType: "<targetType>",
      targetId: <targetId>,
      senderId: <senderId>,
      sessionKey: "<sessionKey>",
      message: "<social_decision>...</social_decision><reply>...</reply>"
    }
  })
  ```
* **备选（CLI 脚本）**：
  ```powershell
  node scripts/send-qq.mjs <targetType> <targetId> "<message>" <senderId>
  ```

#### 4.4 维持响应闭环
发信完成后，**立即再次运行** `node scripts/wait-for-qq-message.mjs` 进入后台等待下一轮消息。

---

## 🌐 Web 统一管理控制台 (Port 5120)

系统拉起时同步启动 Web 控制台，地址：**`http://127.0.0.1:5120`**（默认 Token: `hakimi-admin-token-2026`）。

### 六大功能面板：
1. **🏠 群组管理中心**：
   * 群白名单增删改查、自定义群别名；
   * 独立启停开关（随时启闭某个群的 AI 接管，停用时即时销毁缓冲计时器）；
   * 触发模式策略（`all` 自由探头 vs `strict` 仅响应@与指向性提问）。
2. **🎭 人格与时空控制台**：
   * 4 大预设人设一键热切换，各群 Cascade 自动重置并迁移至专属身位；
   * Markdown 人设卡在线编辑，保存即落盘热重载；
   * 实时时空身位可视化，表单支持「填入当前」与「预设」一键微调 `/moveto`。
3. **⚡ 实时消息看板与推流**：
   * WebSocket 毫秒级双向推流，各群消息实时滚动；
   * **智能自动吸底**：初始与切群自动底置；向上滚动浏览时自动暂停吸底，右下角弹出呼吸动效胶囊 `↓ 收到新消息 (点击回底)`；图片异步加载完成后自动回弹贴底；
   * **潜意识决策透明呈现**：实时展示 `<social_decision>` 内容与潜水倒计时；
   * **管理员应急对讲机**：网页端支持以机器人身份向指定群直接代发消息。
4. **💖 好感度与记忆资产库**：
   * 群友互动好感度排行榜（头像渲染、分值色阶、关系阶段徽章）；
   * 跨会话长期记忆快照（`<MEMORY_SNAPSHOT>`）列表检索与清理；
   * 流行网络黑话（`slangs`）词典收录库在线管理；
   * 提供「清理测试数据」按钮一键清除历史脏数据。
5. **📊 Token 消耗与用量监测**：
   * **大模型标准校准**：中文字符分词权重升级为标准 `1.65 Token/字`，英文使用 `[a-zA-Z0-9]+` 词素精准分词；
   * **KV Cache 命中率模型**：系统提示词与滚动历史自动切分并标记为 `cached_tokens`，记录 `cache_hit_rate`（缓存命中率 %）；
   * 提供平均缓存命中率、节省 Token 绝对值 KPI 卡片及趋势图表。
6. **🛠️ 系统状态与运维看板**：
   * SnowLuma WebSocket 在线状态、Node 内存开销、会话切片监控；
   * **图片缓存实时监控**：显示当前缓存数（`x / 15` 张），提供一键清理缓存按钮；
   * 实时滚动日志流与守护进程一键热重启。

---

## 💬 本地免额度指令 (群友/管理员发送)

以下指令直接在本地网关秒级拦截响应，**0 Token 消耗**：
* `/where` / `人在哪` / `在干嘛`：查询角色当前物理位置与活动细节；
* `/affinity` / `好感度` / `我的好感度`：查询当前说话人好感档案、分值与阶段；
* `/moveto <地点> <活动>`：（仅管理员）手动重置角色时空身位；
* `/status` / `系统状态`：查看当前人格、Cascade 会话进度、轮次与潜水状态；
* `/reset` / `/qqnew`：切断当前会话切片，下次聊天开启全新上下文。
