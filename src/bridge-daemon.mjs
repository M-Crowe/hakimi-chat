import { WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { 
  getCharacterState, 
  updateCharacterLocation, 
  syncCharacterStateForPersona,
  getUserAffinity, 
  modifyUserAffinity, 
  getSessionMemory, 
  saveSessionMemory,
  recordChatMessage,
  updateChatMessageImages,
  getRecentChatContext,
  getLastChatMessageId,
  hasHumanInterrupted,
  recordSlang,
  getTopSlangs,
  extractCandidateNgrams,
  trackGroupSlangFrequency,
  getTopGroupSlangs,
  recordTulpaEpisode,
  updateLatestTulpaEpisodeReply,
  searchTulpaEpisodes,
  getRecentTulpaEpisodes,
  pushInboxMessage,
  cleanStaleInboxMessages,
  getSessionState,
  saveSessionState,
  getAllSessionStates,
  deleteSessionState,
  clearSessionStates,
  initManagedGroups,
  getManagedGroups,
  getManagedGroup,
  saveManagedGroup,
  deleteManagedGroup,
  toggleGroupEnabled,
  allocateWechatGroupId,
  recordTokenUsage,
  estimateTokens,
  pruneOldRecords,
  checkpointDatabase
} from "./db.mjs";
import { getActivePersona, loadPersonaPrompt, buildSystemPrompt } from "./personas.mjs";
import { createWebServer } from "./web-server.mjs";

// 全局事件总线与控制台日志捕获（供 Web Dashboard 运维看板实时推流）
const eventBus = new EventEmitter();
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

function captureLog(level, ...args) {
  const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  const entry = { time: new Date().toLocaleTimeString(), level, text: line, message: line };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  eventBus.emit("broadcast", { type: "system_log", data: entry });
}

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
  origLog(...args);
  captureLog("info", ...args);
};
console.warn = (...args) => {
  origWarn(...args);
  captureLog("warn", ...args);
};
console.error = (...args) => {
  origError(...args);
  captureLog("error", ...args);
};

// 全局异常与 Promise Rejection 兜底保护，防止因个别群消息异常导致守护进程意外退出
process.on("uncaughtException", (err) => {
  console.error("💥 [Daemon UncaughtException]:", err?.stack || err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 [Daemon UnhandledRejection]:", reason?.stack || reason?.message || reason);
});
process.on("beforeExit", (code) => {
  try {
    checkpointDatabase("TRUNCATE");
  } catch {}
  console.log(`⚠️ [Daemon beforeExit] 事件循环排空，即将退出，code: ${code}`);
});
process.on("exit", (code) => {
  try {
    checkpointDatabase("TRUNCATE");
  } catch {}
  console.log(`🛑 [Daemon Exit] 守护进程退出，exitCode: ${code}`);
});
process.on("SIGINT", () => {
  console.log("🛑 [Daemon Signal] 收到 SIGINT 信号中断");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("🛑 [Daemon Signal] 收到 SIGTERM 信号终止");
  process.exit(0);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// 加载配置
const configPath = path.resolve(PROJECT_ROOT, "config.json");
const DEFAULT_CONFIG = {
  snowLuma: { wsUrl: "ws://127.0.0.1:3000/", botQqId: 123456789, adminQqIds: [987654321] },
  antigravity: { lsAddress: "http://127.0.0.1:6714", agentPreset: "tomoko", maxTurns: 30 },
  dsh: { enabled: true, home: "", defaultModel: "deepseek-flash", agentPreset: "tomoko" },
  daemon: { internalHttpPort: 34567, silentBufferLimit: 8, patrolMinMinutes: 3, patrolMaxMinutes: 8 },
  web: { port: 5120, cors: true },
  chatBehavior: {
    ambientTriggerThreshold: 10,
    ambientTriggerProbability: 0.1,
    interestCooldownSeconds: 60,
    activeWindowSeconds: 120,
    silentBufferSeconds: 8,
    recentContextCount: 15,
    topSlangsCount: 5,
    maxImages: 15,
    patrolMinMinutes: 3,
    patrolMaxMinutes: 8,
    maxTurns: 30
  }
};
let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

if (fs.existsSync(configPath)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config = {
      ...DEFAULT_CONFIG,
      ...loaded,
      daemon: { ...DEFAULT_CONFIG.daemon, ...(loaded.daemon || {}) },
      antigravity: { ...DEFAULT_CONFIG.antigravity, ...(loaded.antigravity || {}) },
      snowLuma: { ...DEFAULT_CONFIG.snowLuma, ...(loaded.snowLuma || {}) },
      web: { ...DEFAULT_CONFIG.web, ...(loaded.web || {}) },
      chatBehavior: { ...DEFAULT_CONFIG.chatBehavior, ...(loaded.chatBehavior || {}) }
    };
  } catch (e) {
    console.warn("[Config] 加载 config.json 失败，使用内置默认值");
  }
}

// 支持环境变量覆盖
if (process.env.HAKIMI_ADMIN_TOKEN) {
  config.web.adminToken = process.env.HAKIMI_ADMIN_TOKEN;
}
if (process.env.ONEBOT_WS_URL) {
  config.snowLuma.wsUrl = process.env.ONEBOT_WS_URL;
}

// 微信群双向路由映射表与 ID 生成器
export const WECHAT_GROUP_MAP = {
  "道馆馆": 999001
};
export const WECHAT_GROUP_NAMES = {
  999001: "道馆馆"
};

export function reloadWechatGroupMaps() {
  try {
    const groups = getManagedGroups();
    for (const g of groups) {
      if (g.platform === "wechat") {
        WECHAT_GROUP_MAP[g.group_name] = Number(g.group_id);
        WECHAT_GROUP_NAMES[Number(g.group_id)] = g.group_name;
      }
    }
  } catch {}
}

export async function syncWechatListenToDaemon(action, roomName) {
  if (!roomName) return false;
  try {
    const resp = await fetch("http://127.0.0.1:34568/listen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, room: roomName }),
      signal: AbortSignal.timeout(3000)
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log(`📡 [微信热注册监听同步成功]: ${action} "${roomName}"`, data);
      return true;
    }
  } catch (err) {
    console.warn(`⚠️ [微信热注册同步提示 (Python 守护服务可能未在运行)]: ${err.message}`);
  }
  return false;
}

function getWeChatGroupId(roomName) {
  for (const [k, v] of Object.entries(WECHAT_GROUP_MAP)) {
    if (roomName.includes(k) || k.includes(roomName)) return v;
  }
  const id = allocateWechatGroupId(roomName);
  WECHAT_GROUP_MAP[roomName] = id;
  WECHAT_GROUP_NAMES[id] = roomName;
  try {
    saveManagedGroup(id, roomName, true, "all", "wechat");
  } catch {}
  return id;
}

function getWeChatUserId(senderName) {
  let hash = 0;
  const s = String(senderName || "群友");
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return 980000 + (hash % 10000);
}

// 自动初始化托管群组白名单至 SQLite managed_groups
initManagedGroups(config.snowLuma?.allowedGroupIds || []);
reloadWechatGroupMaps();

function getSnowLumaHttpBase() {
  if (config.snowLuma?.httpUrl) {
    return config.snowLuma.httpUrl.replace(/\/+$/, "");
  }
  if (config.snowLuma?.wsUrl) {
    try {
      const u = new URL(config.snowLuma.wsUrl);
      const protocol = u.protocol === "wss:" ? "https:" : "http:";
      return `${protocol}//${u.host}`;
    } catch {}
  }
  return "http://127.0.0.1:3000";
}

// 缓存图片目录与群组隔离视觉缓存池 (Group-isolated Image Cache)
const IMAGES_DIR = path.resolve(PROJECT_ROOT, "data/images");
const MAX_CACHED_IMAGES = 15;
const MAX_IMAGES_PER_GROUP = 8;
const MAX_GLOBAL_IMAGES = 30;

if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// Map<GroupId, Array<{ path, name, mtimeMs, groupId }>>
const groupImagePool = new Map();
const groupActivityOrder = []; // LRU 追踪

/**
 * 安全删除本地文件，忽略 Windows 占用 (EBUSY) 与已被删除 (ENOENT)
 */
async function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "EBUSY" && e.code !== "EPERM") {
      console.warn(`[ImageCleanup] safeUnlink 忽略非致命异常 ${filePath}:`, e.message);
    }
  }
}

function safeUnlinkSync(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "EBUSY" && e.code !== "EPERM") {
      console.warn(`[ImageCleanup] safeUnlinkSync 忽略非致命异常 ${filePath}:`, e.message);
    }
  }
}

/**
 * 登记图片至对应群组缓存池，执行单群上限 (8张) 与全局上限 (30张 LRU 淘汰)
 */
async function registerGroupImage(groupId, imgItem) {
  if (!groupId) return;
  const gid = String(groupId);

  // 1. 刷新活跃群组顺序
  const orderIdx = groupActivityOrder.indexOf(gid);
  if (orderIdx !== -1) groupActivityOrder.splice(orderIdx, 1);
  groupActivityOrder.push(gid);

  if (!groupImagePool.has(gid)) {
    groupImagePool.set(gid, []);
  }
  const groupList = groupImagePool.get(gid);
  if (!groupList.some(i => i.path === imgItem.path)) {
    groupList.push(imgItem);
  }

  // 2. 单群上限检查 (默认 8 张)
  const maxPerGroup = config.chatBehavior?.maxImagesPerGroup ?? MAX_IMAGES_PER_GROUP;
  while (groupList.length > maxPerGroup) {
    const expired = groupList.shift();
    if (expired?.path) {
      await safeUnlink(expired.path);
    }
  }

  // 3. 全局总上限检查 (默认 30 张，LRU 淘汰最久未活跃群组)
  const maxGlobal = config.chatBehavior?.maxGlobalImages ?? MAX_GLOBAL_IMAGES;
  let totalImages = 0;
  for (const list of groupImagePool.values()) {
    totalImages += list.length;
  }

  while (totalImages > maxGlobal && groupActivityOrder.length > 0) {
    const oldestGid = groupActivityOrder[0];
    const oldestList = groupImagePool.get(oldestGid);
    if (oldestList && oldestList.length > 0) {
      const evicted = oldestList.shift();
      totalImages--;
      if (evicted?.path) {
        await safeUnlink(evicted.path);
      }
    }
    if (!oldestList || oldestList.length === 0) {
      groupImagePool.delete(oldestGid);
      groupActivityOrder.shift();
    }
  }
}

function cleanImagesFifo(maxKeep = (config.chatBehavior?.maxImages ?? MAX_CACHED_IMAGES), dir = IMAGES_DIR) {
  try {
    if (!fs.existsSync(dir)) return { deleted: 0, count: 0 };
    const files = fs.readdirSync(dir);
    const fileStats = [];
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const stat = fs.statSync(p);
        if (stat.isFile()) {
          fileStats.push({ name: f, path: p, mtimeMs: stat.mtimeMs });
        }
      } catch {}
    }
    // 按修改时间降序排序 (最新的在前面)
    fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let deleted = 0;
    if (fileStats.length > maxKeep) {
      const toDelete = fileStats.slice(maxKeep);
      for (const item of toDelete) {
        try {
          safeUnlinkSync(item.path);
          deleted++;
        } catch (err) {
          console.warn(`[ImageCleanup] 删除旧图片失败 ${item.name}: ${err.message}`);
        }
      }
    }
    const remaining = fileStats.length - deleted;
    return { deleted, count: remaining };
  } catch (err) {
    console.warn(`[ImageCleanup] FIFO 清理异常:`, err.message);
    return { deleted: 0, count: 0 };
  }
}
cleanImagesFifo(MAX_CACHED_IMAGES);

/**
 * 确保图片下载并缓存到本地，返回绝对路径 (正斜杠格式)
 */
async function ensureDownloadedImage(imgData, groupId = null) {
  if (!imgData) return null;
  try {
    let file = imgData.file || "";
    let url = imgData.url || "";

    // 1. 若无 URL 但有 file，尝试通过 OneBot get_image API 获取
    if (!url && file) {
      try {
        const resp = await fetch(`${getSnowLumaHttpBase()}/get_image`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.snowLuma.token || ""}`
          },
          body: JSON.stringify({ file })
        });
        const data = await resp.json();
        if (data?.data?.url) {
          url = data.data.url;
        }
      } catch (err) {
        console.warn(`[ImageDownload] 查询 get_image 失败: ${err.message}`);
      }
    }

    if (!url && !file) return null;

    // 规范化本地文件名，过滤非法字符 (防止 Windows 文件名异常抛错)
    let filename = file ? path.basename(file) : "";
    filename = filename.replace(/[/\\?%*:|"<>]/g, "_");
    if (!filename || filename.length < 5 || !/\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
      const hash = Buffer.from(url || file).toString("base64url").slice(0, 16);
      filename = `img_${Date.now()}_${hash}.jpg`;
    }

    const localFilePath = path.join(IMAGES_DIR, filename);
    const normalizedPath = localFilePath.replace(/\\/g, "/");

    // 若本地已存在且非空，更新 mtime 保持活跃并直接复用
    if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 0) {
      try {
        const now = new Date();
        fs.utimesSync(localFilePath, now, now);
      } catch {}
      if (groupId) {
        await registerGroupImage(groupId, { path: normalizedPath, name: filename, mtimeMs: Date.now(), groupId });
      }
      return normalizedPath;
    }

    // 从 URL 下载
    if (url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0) {
            fs.writeFileSync(localFilePath, buf);
            console.log(`🖼️ [图片下载完成] 大小: ${buf.length} 字节 -> ${normalizedPath}`);
            if (groupId) {
              await registerGroupImage(groupId, { path: normalizedPath, name: filename, mtimeMs: Date.now(), groupId });
            }
            return normalizedPath;
          }
        }
      } catch (err) {
        console.warn(`[ImageDownload] 下载图片失败:`, err.message);
      }
    }

    return null;
  } catch (err) {
    console.warn(`[ImageDownload] 处理图片异常:`, err.message);
    return null;
  }
}

const sessions = new Map(); // sessionKey -> { sessionKey, cascadeId, turnCount, lastInterjectTime, sleepUntil, activeUntil, activeSpeaker, messageCounter, lastPrompt }

// 开机启动预热：从 SQLite 恢复持久化会话状态，保证连续对话窗口与潜水硬锁重启不丢失
try {
  for (const s of getAllSessionStates()) {
    sessions.set(s.sessionKey, s);
  }
} catch (err) {
  console.warn("[Bridge Daemon] 预热会话状态警告:", err.message);
}

function getOrCreateSession(sessionKey) {
  if (!sessionKey) return null;
  if (!sessions.has(sessionKey)) {
    const fromDb = getSessionState(sessionKey);
    if (fromDb) {
      sessions.set(sessionKey, fromDb);
    } else {
      const defaultState = {
        sessionKey,
        cascadeId: null,
        turnCount: 0,
        lastInterjectTime: 0,
        activeUntil: 0,
        activeSpeaker: null,
        sleepUntil: 0,
        messageCounter: 0,
        lastPrompt: ""
      };
      sessions.set(sessionKey, defaultState);
      saveSessionState(sessionKey, defaultState);
    }
  }
  return sessions.get(sessionKey);
}

const batchBuffers = new Map(); // sessionKey -> { messages, timer, targetType, targetId, senderId, ... }
let ws = null;

// 1. 建立内部 HTTP 通信，供 MCP 回调发送 QQ 消息
const internalServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const data = JSON.parse(body || "{}");
      if (req.url === "/api/wechat/incoming") {
        const { room, sender, content } = data;
        if (!room || !content) {
          res.writeHead(400).end();
          return;
        }
        const groupId = getWeChatGroupId(room);
        const senderId = getWeChatUserId(sender);
        console.log(`📥 [微信群消息进站] 群: ${room}(ID:${groupId}) | 发送人: ${sender} | 内容: "${content}"`);
        
        // 确保群组在 managed_groups 白名单中
        try {
          saveManagedGroup(groupId, `微信:${room}`, true, "all");
        } catch {}

        const event = {
          post_type: "message",
          message_type: "group",
          group_id: groupId,
          user_id: senderId,
          sender: {
            card: sender,
            nickname: sender
          },
          raw_message: content,
          message: [{ type: "text", data: { text: content } }]
        };
        handleOneBotMessage(event).catch((err) => {
          console.error("❌ [微信消息处理异常]:", err);
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.url === "/api/system/logs" || req.url === "/api/wechat/log") {
        const { level = "info", text, message } = data;
        captureLog(level, text || message || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.url === "/send-message") {
        const sessionKey = data.sessionKey || (data.targetType && data.targetId ? `${data.targetType}:${data.targetId}` : null);
        const senderId = data.senderId != null ? Number(data.senderId) : (data.targetType === "private" ? Number(data.targetId) : undefined);
        const s = sessionKey ? sessions.get(sessionKey) : null;
        const now = Date.now();
        const durationMs = Number(data.duration_ms || data.durationMs) || (s?.lastPromptTime ? Math.max(20, now - s.lastPromptTime) : 0);
        if (s && s.lastPromptTime) {
          s.lastPromptTime = 0; // 及时消费重置，避免后续非请求消息复用陈旧耗时
        }
        const client = data.client || (data.isDsh ? "dsh" : "antigravity");
        const modelName = data.modelName || data.model_name || (client === "dsh" ? (config.dsh?.defaultModel || "deepseek-flash") : (config.antigravity?.modelName || "gemini-2.5-pro"));

        // 在发给 QQ 之前，执行【标签拦截器】过滤与入库
        const cleanedMessage = processOutboundMessage(sessionKey, senderId, data.message, { durationMs, modelName, client });
        let delivered = false;
        const isSilent = /ACTION:\s*DIVE/i.test(data.message || "") || 
                         /\[SILENT\]/i.test(data.message || "") ||
                         /\[action:\s*(?:SILENCE|WAIT|DIVE)/i.test(data.message || "");
        if (cleanedMessage.trim()) {
          delivered = await sendQQMessage(data.targetType, data.targetId, cleanedMessage, { sessionKey });

          if (sessionKey) {
            const s = getOrCreateSession(sessionKey);
            s.activeUntil = Date.now() + 120 * 1000;
            if (senderId) {
              s.activeSpeaker = Number(senderId);
            }
            saveSessionState(sessionKey, s);
            console.log(`💬 [持续对话窗口激活] ${sessionKey} | 目标说话人: ${s.activeSpeaker} | 持续至 120 秒后 (已持久化落盘)`);
          }
        } else if (isSilent) {
          // 角色决策潜水或保持沉默，视为成功处理 (0 扰民，不推流 QQ)
          delivered = true;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: delivered, silent: isSilent && !cleanedMessage.trim() }));
        return;
      }
    } catch (e) {
      console.error("[Internal HTTP Error]:", e.message);
    }
    res.writeHead(400).end();
  });
});

internalServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`💥 [Bridge Daemon 端口冲突] 内部通信网关端口 ${config.daemon.internalHttpPort} 已被占用！请先结束占用端口的旧进程后重启。`);
    process.exit(1);
  } else {
    console.error("💥 [Bridge Daemon InternalServer Error]:", err.message);
  }
});

function recordOutboundTokenUsage(sessionKey, rawMessage, meta = {}) {
  try {
    const activePreset = config.antigravity?.agentPreset || "tomoko";
    let gid = 0;
    if (sessionKey && sessionKey.startsWith("group:")) {
      gid = Number(sessionKey.replace("group:", "")) || 0;
    }
    const session = sessionKey ? sessions.get(sessionKey) : null;
    const promptText = session?.lastPrompt || "";
    const modelName = meta.modelName || config.antigravity?.modelName || "gemini-2.5-pro";
    const durationMs = meta.durationMs || 0;
    const reasoningTokens = meta.reasoningTokens || 0;

    const client = meta.client || (modelName && modelName.toLowerCase().includes("deepseek") ? "dsh" : "antigravity");

    const tokenRecord = recordTokenUsage({
      sessionKey: sessionKey || "",
      groupId: gid,
      persona: activePreset,
      client,
      promptText,
      replyText: rawMessage || "",
      reasoningTokens,
      durationMs,
      modelName,
      throughputTps: meta.throughputTps,
      costCny: meta.costCny,
      costUsd: meta.costUsd,
      customPricing: config.pricing
    });
    eventBus.emit("broadcast", {
      type: "token_usage",
      data: tokenRecord
    });
  } catch (err) {
    // 忽略异常，确保核心管线稳定
  }
}

/**
 * 【标签拦截与业务驱动核心】：从模型生成的文本中剥离内联标签并入库 SQLite
 */
function processOutboundMessage(sessionKey, senderId, rawMessage, meta = {}) {
  let text = rawMessage || "";

  // 0. 计算思考推理 Token (Reasoning Tokens)（在剥离标签前提取）
  let reasoningTokens = meta.reasoningTokens !== undefined ? meta.reasoningTokens : 0;
  if (!reasoningTokens && text) {
    const thinkMatches = [
      ...text.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi),
      ...text.matchAll(/<thought>([\s\S]*?)(?:<\/thought>|$)/gi),
      ...text.matchAll(/<thinking>([\s\S]*?)(?:<\/thinking>|$)/gi)
    ];
    if (thinkMatches.length > 0) {
      const reasoningContent = thinkMatches.map(m => m[1] || "").join("\n");
      reasoningTokens = estimateTokens(reasoningContent);
    }
  }
  const fullMeta = { ...meta, reasoningTokens };

  // 1. 优先从全文（含思考标签内部）全局解析轻量社交行动标签：[action:REPLY] 或 [action:SILENCE|理由] 或 [action:WAIT]
  const actionTagRegex = /[\[【]action:\s*([a-zA-Z0-9_-]+)(?:\s*\|\s*([^\]】]*))?[\]】]/i;
  const actionTagMatch = actionTagRegex.exec(text);
  let inlineAction = null;
  let inlineActionReason = "";
  if (actionTagMatch) {
    inlineAction = actionTagMatch[1].toUpperCase();
    inlineActionReason = (actionTagMatch[2] || "").trim();
    console.log(`🧠 [轻量社交行动] Action: ${inlineAction}${inlineActionReason ? ` (理由: ${inlineActionReason})` : ""}`);
    eventBus.emit("broadcast", {
      type: "social_decision",
      data: {
        sessionKey,
        senderId,
        action: inlineAction,
        reason: inlineActionReason,
        rawDecision: actionTagMatch[0]
      }
    });
  }

  // 2. 提取并持久化跨会话切片记忆：<MEMORY_SNAPSHOT>...</MEMORY_SNAPSHOT>
  const memRegex = /<MEMORY_SNAPSHOT>([\s\S]*?)<\/MEMORY_SNAPSHOT>/i;
  const memMatch = memRegex.exec(text);
  if (memMatch && memMatch[1]) {
    const snapshot = memMatch[1].trim().slice(0, 200);
    if (sessionKey) {
      saveSessionMemory(sessionKey, snapshot);
      console.log(`💾 [记忆切片归档] ${sessionKey} 记忆已落盘: "${snapshot}"`);
    }
  }

  // 3. 全局拦截好感度标签：[af:+2|理由] 或 [af:-2|冒犯]（单次变动严格限制在 [-2, +2]）
  const afRegex = /[\[【]af:\s*([+-]?\d+)\s*(?:\|\s*([^\]】]*))?[\]】]/gi;
  let afMatch;
  while ((afMatch = afRegex.exec(text)) !== null) {
    const rawDelta = parseInt(afMatch[1], 10);
    const reason = (afMatch[2] || "").trim();
    if (senderId && Number(senderId) > 0 && !isNaN(rawDelta)) {
      const delta = Math.max(-2, Math.min(2, rawDelta));
      const result = modifyUserAffinity(Number(senderId), delta, reason);
      console.log(`❤️ [好感度变动] 用户(${senderId}) 好感 ${delta > 0 ? "+" + delta : delta}${rawDelta !== delta ? ` (原始 ${rawDelta > 0 ? "+" + rawDelta : rawDelta} 被限制在 [-2, +2])` : ""} -> ${result.newPoints} (${result.newLevel}) [原因: ${result.reason}]`);
      eventBus.emit("broadcast", {
        type: "affinity_change",
        data: { userId: Number(senderId), delta, ...result }
      });
    }
  }

  // 4. 全局拦截时空转移标签：[state:地点|活动|现场细节]
  const stateRegex = /[\[【]state:\s*([^\|\]】]+?)\s*(?:\|\s*([^\|\]】]+?)\s*)?(?:\|\s*([^\]】]+?)\s*)?[\]】]/gi;
  let stateMatch;
  while ((stateMatch = stateRegex.exec(text)) !== null) {
    const location = (stateMatch[1] || "").trim();
    const action = (stateMatch[2] || "").trim();
    const detail = (stateMatch[3] || "").trim();
    updateCharacterLocation(location, action, detail);
    const persona = getActivePersona(config.antigravity?.agentPreset);
    console.log(`📍 [时空转移] ${persona.displayName}移动至: 【${location}】| 活动: 【${action}】| 细节: 【${detail}】`);
    eventBus.emit("broadcast", {
      type: "state_change",
      data: getCharacterState()
    });
  }

  // 5. 全局拦截群聊流行黑话标签：[slang:词|含义]
  const slangRegex = /[\[【]slang:\s*([^\|\]】]+?)\s*(?:\|\s*([^\]】]*?)\s*)?[\]】]/gi;
  let slangMatch;
  while ((slangMatch = slangRegex.exec(text)) !== null) {
    const word = (slangMatch[1] || "").trim();
    const meaning = (slangMatch[2] || "").trim();
    recordSlang(word, meaning);
    console.log(`📚 [黑话顺风车学习] 发现新用语: "${word}" | 含义: "${meaning}"`);
  }

  // 6. 安全剥离思考标签：<think>...</think>, <thought>...</thought>, <thinking>...</thinking>（支持未闭合截断保护）
  text = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
             .replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, "")
             .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, "");

  text = text.replace(/<MEMORY_SNAPSHOT>[\s\S]*?<\/MEMORY_SNAPSHOT>/gi, "");
  text = text.replace(actionTagRegex, "");

  // 6.1 拦截第一层社交决策槽：<social_decision>...</social_decision>
  let decisionAction = null;
  let diveMinutes = 0;
  const decisionRegex = /<social_decision>([\s\S]*?)<\/social_decision>/i;
  const decisionMatch = decisionRegex.exec(text);
  if (decisionMatch) {
    const decContent = decisionMatch[1];
    if (/ACTION:\s*DIVE/i.test(decContent)) {
      decisionAction = "DIVE";
      const minMatch = /dive_minutes:\s*(\d+)/i.exec(decContent);
      diveMinutes = minMatch ? parseInt(minMatch[1], 10) : (Math.floor(Math.random() * 4) + 3); // 3~6 分钟
    } else if (/ACTION:\s*INTERJECT/i.test(decContent)) {
      decisionAction = "INTERJECT";
    } else if (/ACTION:\s*REPLY/i.test(decContent)) {
      decisionAction = "REPLY";
    }
    console.log(`🧠 [社交动力学决策] Action: ${decisionAction || "REPLY"}${decisionAction === "DIVE" ? ` (潜水锁定 ${diveMinutes} 分钟)` : ""}`);

    eventBus.emit("broadcast", {
      type: "social_decision",
      data: {
        sessionKey,
        senderId,
        action: decisionAction || "REPLY",
        diveMinutes,
        rawDecision: decContent.trim()
      }
    });
  }

  // 标签优先级映射与统一决策收敛
  if (inlineAction === "SILENCE" || inlineAction === "WAIT") {
    decisionAction = "SILENCE";
  } else if (inlineAction === "REPLY") {
    if (!decisionAction) decisionAction = "REPLY";
  } else if (inlineAction === "DIVE") {
    decisionAction = "DIVE";
  }

  // 7. 提取第二层纯净声音槽：<reply>...</reply>（兼容 <char_reply> 与旧版 <tomoko_reply>）
  const replyRegex = /<(?:reply|char_reply|tomoko_reply)>([\s\S]*?)<\/(?:reply|char_reply|tomoko_reply)>/i;
  const replyMatch = replyRegex.exec(text);
  if (replyMatch && replyMatch[1] !== undefined) {
    text = replyMatch[1];
  } else {
    // 若没有独立回复标签，先剥离 social_decision 部分，防止心理活动泄露
    text = text.replace(/<social_decision>[\s\S]*?<\/social_decision>/gi, "");
  }

  // 8. 安全剥离 XML/HTML 标签，避免误吞类似 a < b, 1 < 2 等数学比较符号（不使用 (>|$) 模式）
  text = text.replace(/<\/?[a-zA-Z][a-zA-Z0-9_:-]*(?:\s+[^>]*)?>/g, "");

  // 9. 判断是否潜水或已读放空 (DIVE, SILENCE, WAIT 或 [SILENT])
  const isSilentTurn = decisionAction === "DIVE" || decisionAction === "SILENCE" || inlineAction === "SILENCE" || inlineAction === "WAIT" || /\[SILENT\]/i.test(text);
  if (isSilentTurn) {
    const sleepMins = decisionAction === "DIVE" ? (diveMinutes || (Math.floor(Math.random() * 4) + 3)) : 0;
    if (sessionKey && sleepMins > 0) {
      const session = getOrCreateSession(sessionKey);
      session.sleepUntil = Date.now() + sleepMins * 60000;
      session.activeUntil = 0; // 潜水时清空活跃窗口
      saveSessionState(sessionKey, session);
    }
    const persona = getActivePersona(config.antigravity?.agentPreset);
    console.log(`😴 [${persona.displayName}${decisionAction === "SILENCE" || inlineAction === "SILENCE" ? "选择静默不发言" : "进入潜水放空"}]${sleepMins > 0 ? ` 本地锁定至: ${new Date(Date.now() + sleepMins * 60000).toLocaleTimeString()} (${sleepMins}分钟) | 期间群内闲聊 0 Token 静默拦截` : " (0 扰民，不推流 QQ)"}`);

    // 记录潜水/沉默交互 Token
    recordOutboundTokenUsage(sessionKey, rawMessage, fullMeta);
    return ""; // 返回空字符串，QQ 群不发送任何消息
  }

  // 10. 清理回复中可能残留的内联标签，防止泄漏到 QQ
  text = text.replace(afRegex, "")
             .replace(stateRegex, "")
             .replace(slangRegex, "")
             .replace(/[\[【]action:\s*[^\]】]+[\]】]/gi, "");

  // 11. 记录 Token 与字符用量双轨统计
  recordOutboundTokenUsage(sessionKey, rawMessage, fullMeta);

  // 12. 若是管理员对话，更新 Tulpa 情境记忆中的回复切片
  if (sessionKey && senderId && (config.snowLuma.adminQqIds || []).includes(Number(senderId))) {
    try {
      updateLatestTulpaEpisodeReply(sessionKey, text.trim());
    } catch {}
  }

  return text.trim();
}

// 2. 连接 SnowLuma OneBot WebSocket
function connectSnowLuma() {
  const token = config.snowLuma.token || "";
  let targetWsUrl = config.snowLuma.wsUrl;
  
  // 如果配置了 Token 且 URL 中尚未包含 access_token，则自动附加到 query 参数
  if (token && !targetWsUrl.includes("access_token=")) {
    const separator = targetWsUrl.includes("?") ? "&" : "?";
    targetWsUrl = `${targetWsUrl}${separator}access_token=${encodeURIComponent(token)}`;
  }

  console.log(`[SnowLuma] 正在尝试连接: ${config.snowLuma.wsUrl} (带 Token 鉴权) ...`);
  
  const options = {};
  if (token) {
    options.headers = {
      Authorization: `Bearer ${token}`
    };
  }

  ws = new WebSocket(targetWsUrl, options);

  ws.on("open", () => {
    console.log("✅ [SnowLuma] WebSocket 连接成功！认证通过！");
    eventBus.emit("broadcast", {
      type: "snowluma_status",
      data: { connected: true, botQqId: config.snowLuma.botQqId, wsUrl: config.snowLuma.wsUrl }
    });
  });

  ws.on("message", (raw) => {
    try {
      const event = JSON.parse(raw);
      if (event.post_type === "message") {
        handleOneBotMessage(event).catch((err) => {
          console.error("❌ [SnowLuma 消息处理未捕获异常]:", err?.stack || err?.message || err);
        });
      }
    } catch (err) {
      console.error("[SnowLuma] 解析消息异常:", err.message);
    }
  });

  ws.on("close", (code, reason) => {
    console.warn(`⚠️ [SnowLuma] 连接断开 (Code: ${code}, 原因: ${reason || "无"}), 5 秒后重试...`);
    eventBus.emit("broadcast", {
      type: "snowluma_status",
      data: { connected: false, botQqId: config.snowLuma.botQqId, wsUrl: config.snowLuma.wsUrl }
    });
    setTimeout(connectSnowLuma, 5000);
  });

  ws.on("error", (err) => {
    console.error("[SnowLuma] 连接错误:", err.message);
  });
}

// 单条底层发送器（支持 HTTP 重试 + WebSocket 兜底）
async function sendSingleMessage(targetType, targetId, text) {
  // 微信群静默隔离发送拦截
  const wechatRoomName = WECHAT_GROUP_NAMES[targetId];
  if (wechatRoomName) {
    try {
      const wxRes = await fetch("http://127.0.0.1:34568/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: wechatRoomName, message: text })
      });
      const wxData = await wxRes.json();
      if (wxData.success) {
        console.log(`📤 [微信消息已静默送达群] 目标: ${wechatRoomName} | 内容: "${text}"`);
        return true;
      } else {
        console.warn(`⚠️ [微信发送未通过]:`, wxData);
        return false;
      }
    } catch (err) {
      console.warn(`⚠️ [微信网关通信异常]:`, err.message);
      return false;
    }
  }

  const isGroup = targetType === "group";
  const action = isGroup ? "send_group_msg" : "send_private_msg";
  const url = `${getSnowLumaHttpBase()}/${action}`;
  const payload = {
    [isGroup ? "group_id" : "user_id"]: targetId,
    message: text
  };

  let sentSuccess = false;

  // 1. 尝试 HTTP 发信（带 1 次重试机制）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.snowLuma.token || ""}`
        },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (result.status === "ok") {
        console.log(`📤 [QQ 消息已送达群] MessageId: ${result.data?.message_id} | 内容: "${text}"`);
        sentSuccess = true;
        break;
      } else {
        console.warn(`⚠️ [HTTP 发信未通过 (第${attempt}次)]:`, result);
      }
    } catch (err) {
      console.warn(`⚠️ [HTTP 发信网络异常 (第${attempt}次)]:`, err.message);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 600));
  }

  // 2. 若 HTTP 发信失败，无缝降级走 WebSocket 长连接兜底送达
  if (!sentSuccess) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        console.log(`🚀 [WebSocket 降级兜底发送] 内容: "${text}"`);
        ws.send(JSON.stringify({ action, params: payload }));
        sentSuccess = true;
      } catch (wsErr) {
        console.error(`❌ [WebSocket 兜底异常]:`, wsErr.message);
      }
    } else {
      console.error(`❌ [WebSocket 无法连接，消息可能丢失]: "${text}"`);
    }
  }

  // 3. 记入 SQLite 滚动记忆胶卷并广播
  if (sentSuccess) {
    const sessionKey = `${targetType}:${targetId}`;
    const persona = getActivePersona(config.antigravity?.agentPreset);
    recordChatMessage(sessionKey, config.snowLuma.botQqId, persona.displayName, text, true, persona.displayName);
    eventBus.emit("broadcast", {
      type: "message_out",
      data: {
        time: new Date().toLocaleTimeString(),
        sessionKey,
        session_key: sessionKey,
        targetType,
        targetId,
        message: text,
        message_text: text,
        text,
        senderId: config.snowLuma.botQqId,
        sender_id: config.snowLuma.botQqId,
        senderName: persona.displayName,
        sender_name: persona.displayName,
        isBot: true,
        is_bot: 1
      }
    });
  }

  return sentSuccess;
}

function splitIntoBubbles(message, maxBubbles = 3) {
  if (!message || !message.trim()) return [];
  // 1. 先按显式换行切分
  let lines = message
    .split(/\r?\n+|\\n/)
    .map(s => s.trim())
    .filter(Boolean);

  // 2. 若换行只有 1 段，但包含多个以标点结尾的完整句子，尝试按句子标点切分为 1~3 个气泡
  if (lines.length === 1 && lines[0].length > 15) {
    const sentenceParts = lines[0]
      .match(/[^。！？!\?]+[。！？!\?]+|[^。！？!\?]+$/g)
      ?.map(s => s.trim())
      .filter(Boolean);
    if (sentenceParts && sentenceParts.length > 1 && sentenceParts.length <= maxBubbles) {
      lines = sentenceParts;
    } else if (sentenceParts && sentenceParts.length > maxBubbles) {
      lines = [
        sentenceParts[0],
        sentenceParts[1],
        sentenceParts.slice(2).join("")
      ];
    }
  }

  // 3. 严格限制最多 3 批气泡，超出部分合并进第 3 批
  if (lines.length <= maxBubbles) {
    return lines;
  }
  return [
    lines[0],
    lines[1],
    lines.slice(2).join("\n")
  ];
}

// 多条仿生消息发送总调度（按真实换行或句子标点切分为 1~3 个气泡，带打字间隔与在途打断检查）
async function sendQQMessage(targetType, targetId, message, options = {}) {
  if (!message || !message.trim()) return false;

  const segments = splitIntoBubbles(message, 3);
  if (segments.length === 0) return false;

  const sessionKey = options.sessionKey || `${targetType}:${targetId}`;
  let lastCheckedId = getLastChatMessageId(sessionKey);
  const sendFn = options.sendFn || sendSingleMessage;

  let allSuccess = true;
  for (let i = 0; i < segments.length; i++) {
    // 气泡 2 或 3 发送前，检查 SQLite chat_messages 是否有新真人插话 (in-flight interruption)
    if (i > 0 && options.allowInterruption !== false) {
      const interrupted = hasHumanInterrupted(sessionKey, lastCheckedId);
      if (interrupted) {
        console.log(`⚡ [气泡打断/In-flight Cancellation] 会话: ${sessionKey} 检测到用户(${interrupted.sender_name || interrupted.sender_id})插话 ("${interrupted.message_text}")，中断取消剩余 ${segments.length - i} 条待发气泡`);
        break;
      }
    }

    // 更新基准检查点：已确认到当前时刻无打断，基准水位推进至当前最新 ID
    lastCheckedId = getLastChatMessageId(sessionKey);

    const seg = segments[i];
    const ok = await sendFn(targetType, targetId, seg);
    if (!ok) allSuccess = false;

    // 如果还有下一句，模拟真实人类打字间隔（默认 800ms ~ 1800ms，测试可传入 options.typingDelayMs）
    if (i < segments.length - 1) {
      const delay = options.typingDelayMs ?? (Math.floor(Math.random() * 1000) + 800);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return allSuccess;
}

/**
 * 核心指向性语义判定引擎
 * 仅在上下文适格（私聊、或当前活跃窗口内且同发言人）时才匹配代词“你...吗”，防止群友互聊被抢话
 */
function isDirectedAtAi(text, isContextEligible = false) {
  if (!text) return false;
  const lower = String(text).toLowerCase().trim();
  const persona = getActivePersona(config.antigravity?.agentPreset);

  const baseAiMention = /deepseek|claude|chatgpt|gpt|ai|机器人|人工智障/.test(lower);
  const personaMention = persona.mentionRegex.test(lower);
  const aiMention = baseAiMention || personaMention;

  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|菜|不如|厉害|赢|输/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;

  // 常见打招呼/问候直接针对机器人（如："你好"、"在吗"、"早安"、"晚安"、"嗨"）
  if (/^(你好|在吗|早安|晚安|嗨|哈喽|hello|hi)[啊呀嘛吧~～\?!！\s]*$/i.test(lower)) return true;
  // 追问/催促：真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死/.test(lower)) return true;

  // 仅在适格上下文（私聊、或在活跃会话窗口同发言人接话）中，才检查“你...吗”
  if (isContextEligible) {
    if (/(你|您).{0,12}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|好不好|怎么样|在不在|多大|喜欢|玩什么|推荐|在干嘛|在做什么)/.test(lower)) return true;
    if (/^(你|您)(好|早|安|是不是|行不行|能不能|会不会|觉得|喜欢|玩)/.test(lower)) return true;
  }

  return false;
}

const UNFINISHED_REGEX = /(?:我跟你说|跟你讲|你知道吗|等一下|等下|等等|稍等|等会|等会儿|其实|但是|不过|而且|还有|另外|然后|因为|就是说|比如|所以|结果|：|:|[，,、]|(?:\.{2,}|…+))[啊呀哦吧呢哈呐]*(?:一?下[子儿]?)?[\s，,。\.\?!？！~～…]*$/;

async function dispatchBatch(sessionKey, options = {}) {
  try {
    const batch = batchBuffers.get(sessionKey);
    if (!batch || batch.messages.length === 0) {
      if (batch) {
        if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
        if (batch.maxWaitTimer) clearTimeout(batch.maxWaitTimer);
        if (batch.timer) clearTimeout(batch.timer);
      }
      batchBuffers.delete(sessionKey);
      return;
    }

    // 检查半句话未完结等待 (Unfinished Turn Waiting)
    const latestMsg = batch.messages[batch.messages.length - 1];
    const latestText = (latestMsg?.text || "").trim();
    const isUnfinished = UNFINISHED_REGEX.test(latestText);

    if (isUnfinished && !options.force && !batch.extendedForUnfinished) {
      const waitMs = config.chatBehavior?.unfinishedWaitMs ?? 2500;
      batch.extendedForUnfinished = true;
      console.log(`⏳ [半句话等待] 会话: ${sessionKey} 最新消息疑似未说完 ("${latestText}")，本地延长防抖等待 ${waitMs}ms，避免抢答浪费 Token`);
      if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
      batch.debounceTimer = setTimeout(() => {
        dispatchBatch(sessionKey, { force: true }).catch(err => {
          console.error(`❌ [dispatchBatch Unfinished Timer 异常] 会话: ${sessionKey}:`, err?.stack || err?.message || err);
        });
      }, waitMs);
      return;
    }

    if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
    if (batch.maxWaitTimer) clearTimeout(batch.maxWaitTimer);
    if (batch.timer) clearTimeout(batch.timer);
    batchBuffers.delete(sessionKey);

    const session = getOrCreateSession(sessionKey);
    const senderId = batch.primarySenderId || batch.senderId;
    const targetId = batch.targetId;
    const isGroup = batch.targetType === "group";

    // 若为群聊，校验群是否已被禁用或移出白名单
    if (isGroup) {
      const mg = getManagedGroup(targetId);
      if (!mg || !mg.enabled) {
        console.log(`⏹️ [取消批处理] 群 ${targetId} 已被禁用或移除，丢弃待发送批处理`);
        return;
      }
    }

    const persona = getActivePersona(config.antigravity?.agentPreset);

    // 1. 合并批处理短句与图片（带发言人明确标注，防止群友发言混淆与好感度误扣）
    const isPatrol = Boolean(batch.isPatrolWake || Number(senderId) === 0);
    const speakerLabel = isGroup ? "群友" : "用户";
    const aggregatedText = batch.messages
      .map(m => `[${speakerLabel}(${m.senderId ?? senderId})]: ${m.text}`)
      .join("\n");
    const aggregatedImages = (batch.images || []).slice(0, 3); // 最多保留 3 张

    // 2. 提取好感度与时空信息
    // 定时巡逻看群使用中立初始基准，绝不查询或影响管理员及任何特定用户的好感度
    const aff = isPatrol 
      ? { user_id: 0, affinity_points: 30, level_name: "初识", last_reason: "日常看群巡逻" }
      : getUserAffinity(senderId);
    const charState = getCharacterState();

    console.log(`🤖 [${persona.displayName} 滑动窗口聚合完成，推入 Antigravity] 会话: ${sessionKey} | 合并条数: ${batch.messages.length} | 图片数: ${aggregatedImages.length} | 说话人(${senderId}):\n${aggregatedText}\n | 好感度: [${aff.affinity_points}(${aff.level_name})]`);

    // 3. 构建三层动态架构提示词 (底层协议 + 人设范式 + 好感矩阵/时空身位)
    const systemPrompt = buildSystemPrompt(persona.name, aff.affinity_points, {
      location: charState.location,
      action: charState.action,
      detail: charState.detail,
      mood: charState.mood
    });

    let prompt = `${systemPrompt}\n\n` +
      `[实时交互与目标元数据：\n` +
      `• 当前会话目标：targetType="${batch.targetType}", targetId=${targetId}, sessionKey="${sessionKey}", senderId=${senderId}\n` +
      `]\n`;

    // 4. 从 SQLite 提取最近滚动真实上下文
    const recentCount = config.chatBehavior?.recentContextCount ?? 15;
    const recentHistory = getRecentChatContext(sessionKey, recentCount);
    if (recentHistory) {
      prompt += `[群聊最近滚动真实上下文（背景参考，即使刚才未 @ 你也一直在发生）：\n${recentHistory}\n]\n`;
    }

    // 5. 注入本群流行黑话参考 (结合本地纯算法 group_slangs 与全局 slangs，优先高频出现词)
    const slangsCount = config.chatBehavior?.topSlangsCount ?? 5;
    let slangs = isGroup ? getTopGroupSlangs(targetId, slangsCount, 2) : [];
    if (!slangs || slangs.length === 0) {
      slangs = isGroup ? getTopGroupSlangs(targetId, slangsCount, 1) : [];
    }
    if (!slangs || slangs.length === 0) {
      slangs = getTopSlangs(slangsCount);
    }
    if (slangs && slangs.length > 0) {
      prompt += `[本群流行网络用语参考（自然使用，无需生搬硬套）：\n` +
        slangs.map(s => `• ${s.word}${s.meaning ? ": " + s.meaning : ""}`).join("\n") +
        `\n]\n`;
    }

    // 6. 场景提示
    if (batch.isContinuousChat && !batch.isDirectMention) {
      prompt += `\n[特别场景提示：当前处于你们正在进行的连续闲聊对话中（前序你刚回复过对方），对方无需每句都带 @ 或名字。请自然、连贯地接话。]`;
    } else if (batch.isAutonomousInterject) {
      prompt += `\n[特别场景提示：当前说话人并没有 @ 或点名你，但群友聊到了你感兴趣的话题或群里正热闹。请作为普通群友自然探头接一句吐槽、好奇或共鸣（例如「诶？！真的假的」「草」「这个我也玩过…！」），1~12字口语短句，切勿长篇大论。]`;
    }

    // 6.1 多模态图片感知指引（若存在群友发送的图片）
    if (aggregatedImages.length > 0) {
      prompt += `\n[🖼️ 群友附带发送了图片附件（系统已自动下载至本地，你具备原生视觉看图能力）]：\n` +
        aggregatedImages.map((img, idx) => `• 图片 ${idx + 1} 绝对路径: ${img.path}`).join("\n") +
        `\n【重要多模态看图步骤】：\n` +
        `你必须首先调用 view_file(AbsolutePath="${aggregatedImages[0].path}") 查看图片画面！仔细观察图片内容（画面细节、文字、表情包梗、角色、游戏截图等），随后在社交决策与回复中针对该图片给出符合你性格设定的自然吐槽或互动！\n`;
    }

    // 7. 注入双层显式解耦协议（二代仿真模式·社交动力学核心决策规范）
    prompt += `\n\n[核心执行规范与决策操作指引（绝对严格执行）]：\n` +
      `1. 【多模态看图与联网查证优先】：若群友发了图片，第一步必须调用 view_file 查看真实画面；若涉及你不确定的现实事实、科技/数码参数、突发新闻、游戏版本或热点梗，必须调用 search_web 工具查清真相后再基于事实接话，切勿凭空瞎猜或胡乱反驳！\n` +
      `2. 【严禁单纯在对话框打字（必须实际调用发信工具）】：单纯在聊天窗口输出文本或标签绝对不会送达 QQ 群！你在完成思考后，必须调用 call_mcp_tool(ServerName="agy-tomoko-mcp", ToolName="qq_send_message", Arguments={targetType:"${batch.targetType}", targetId:${targetId}, senderId:${senderId}, sessionKey:"${sessionKey}", message:"..."}) 或运行 node scripts/send-qq.mjs 真正把消息发出！\n` +
      `3. 【群聊心法：反 AI 味与拒绝有求必应】：\n` +
      `   • 你是混在群里的真人群友，绝非客服、非搜索引擎、非任务队列。不要逐条点评，严禁做“看到大家在聊……”式的总结；别人要求推荐或帮忙时，可以反问、装傻、吐槽或已读乱回，少用“一绝”“超好用”“非常推荐”等推销词。\n` +
      `   • 严禁使用 Markdown 排版：禁止在消息中使用 **粗体**、# 标题、代码块，QQ 显示会异常混乱。\n` +
      `   • 严禁汇报：调用发信工具后，严禁在对话框自言自语输出“已发送”“我已在群里回复”等汇报总结。\n` +
      `4. 【发信后必须重新挂起监听】：执行发信后，必须紧接着运行 node scripts/wait-for-qq-message.mjs 挂入后台等待新消息。\n\n` +
      `[双层标签槽规范（填入 message 参数传递给发信工具）]：\n` +
      `槽 1 <social_decision>（你的潜意识社交分析，群友完全不可见）：\n` +
      `• 简短分析：群友正在聊什么、当前话题与我的关联度、我当前的身位状态（${charState.location} / ${charState.action}）、对方意图与群内氛围。\n` +
      `• ACTION（必须严格三选一）：\n` +
      `  - ACTION: REPLY （当有人 @我、点名找我、或正处于与我的连续闲聊对话中时）\n` +
      `  - ACTION: INTERJECT （群友没叫我，但聊到了我感兴趣的话题、排队复读好玩的梗、发了有趣的图、或我忍不住探头吐槽搭话）\n` +
      `  - ACTION: DIVE （无意义单字如"1"、无关碎嘴、话题已翻篇、或我想专注自己的事情，决定已读不回继续潜水）\n` +
      `• 顺风车标签（好感度调整铁律：仅当对方明显讨好/冒犯你，或触发核心喜好/雷点时才附带，单次变动幅度严格限制在 [-2, +2]，日常普通对话严禁附带）：友好共鸣/深度契合核心喜好 [af:+1~+2|理由]；挑刺/冒犯/轻浮骚扰 [af:-1~-2|理由]；日常普通对话绝对不带。发现新鲜梗附带 [slang:黑话词|推测含义]；时空转移附带 [state:地点|活动|现场细节]。\n\n` +
      `槽 2 <reply>（真正发到群里的纯净声音）：\n` +
      `• 若第一槽决策为 DIVE：本槽必须直接输出 [SILENT]，系统将零 Token 睡眠静默拦截，绝不打扰群友。\n` +
      `• 若第一槽决策为 REPLY 或 INTERJECT：本槽输出契合你人设的口语短句（1~15字，去AI味，中文不要敲空格断句）。想分条连发时可直接换行（最多2~3行小短句，系统会自动带打字间隔分条发出）。在末尾可附带 <MEMORY_SNAPSHOT>记忆摘要</MEMORY_SNAPSHOT>。\n\n` +
      (isPatrol 
        ? `【定时看群感知】：你刚忙完手头的事顺便看了一眼群消息，群友并没有特意叫你。你可以根据上面最近滚动上下文自主决定：是继续潜水沉默（DIVE），还是随手接一句/跟一句复读/吐槽冒泡（INTERJECT）。`
        : `来自${speakerLabel}(${senderId})的最新发言：\n${aggregatedText}`);

    // 7.5 查询 Tulpa 情境记忆片段（0 API 成本，仅在尾部追加 Few-shot 范例，严格保护 97% KV Cache 前缀命中率）
    try {
      const querySample = batch.messages.map(m => m.text).join(" ");
      const matchedEpisodes = searchTulpaEpisodes(querySample, 2);
      if (matchedEpisodes && matchedEpisodes.length > 0) {
        prompt += `\n\n[历史真实高光对话参考（Tulpa 经验情境，仅供语气与交互参考，切勿机械复读）：\n` +
          matchedEpisodes.map((ep, idx) => `• 范例 ${idx + 1}：\n  问：${ep.user_message}\n  答：${ep.reply_message || "（自然互动）"}`).join("\n") +
          `\n]`;
      }
    } catch (epErr) {
      // 容错兜底
    }

    // 8. 写入 Antigravity 本地收件箱（SQLite inbox_queue 原子队列）
    const inboxPayload = {
      id: Date.now(),
      targetType: batch.targetType,
      targetId,
      sessionKey,
      senderId: isPatrol ? 0 : senderId,
      userText: isPatrol ? "[日常看群]" : aggregatedText,
      images: aggregatedImages,
      charState,
      aff,
      fullPrompt: prompt
    };
    if (session) {
      session.lastPrompt = prompt;
      session.lastPromptTime = Date.now();
      session.turnCount = (session.turnCount || 0) + 1;
      saveSessionState(sessionKey, session);
    }
    pushInboxMessage(inboxPayload);

    // 3.4 消息已进入 SQLite inbox_queue 原子队列，等待 Antigravity 伴聊大脑 (IDE Companion Skill) 消费响应
    console.log(`📥 [InboxQueue] 聚合消息已推入队列 (${sessionKey}) | 当前会话轮次: ${session?.turnCount || 1} | 等待 IDE 伴聊大脑响应`);
  } catch (err) {
    console.error(`❌ [dispatchBatch 聚合发送异常] 会话: ${sessionKey}:`, err?.stack || err?.message || err);
  }
}

// 3. 消息主调度循环
async function handleOneBotMessage(event) {
  try {
    const isGroup = event.message_type === "group";
    const targetId = isGroup ? event.group_id : event.user_id;
  const sessionKey = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;
  const senderId = event.user_id;
  const rawText = (event.raw_message || "").trim();
  const isAdmin = (config.snowLuma.adminQqIds || []).includes(senderId);

  // 3.0 群聊白名单过滤与动态响应控制（基于 SQLite managed_groups）
  let managedGroupConfig = null;
  if (isGroup) {
    managedGroupConfig = getManagedGroup(event.group_id);
    if (!managedGroupConfig) {
      return; // 未加入托管白名单或已被管理员移除，直接忽略
    }
    if (!managedGroupConfig.enabled) {
      return; // 该群动态开关已关闭，直接忽略
    }
  }

  // 3.1 提取消息内容与判定是否 @ 机器人（完美兼容数组格式与 CQ 码字符串，支持图片与表情）
  let isAtBot = false;
  let userText = "";
  const detectedImages = [];

  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (seg.type === "at" && String(seg.data?.qq) === String(config.snowLuma.botQqId)) {
        isAtBot = true;
      } else if (seg.type === "text") {
        userText += seg.data?.text || "";
      } else if (seg.type === "image") {
        userText += " [图片] ";
        detectedImages.push({
          file: seg.data?.file || "",
          url: seg.data?.url || ""
        });
      } else if (seg.type === "face") {
        userText += ` [表情:${seg.data?.id || ""}] `;
      }
    }
  } else {
    isAtBot = rawText.includes(`[CQ:at,qq=${config.snowLuma.botQqId}]`);

    // 解析 CQ 码中的图片
    const cqImageRegex = /\[CQ:image,([^\]]+)\]/g;
    let imgMatch;
    while ((imgMatch = cqImageRegex.exec(rawText)) !== null) {
      const paramsStr = imgMatch[1];
      const fileMatch = /file=([^,\]]+)/.exec(paramsStr);
      const urlMatch = /url=([^,\]]+)/.exec(paramsStr);
      let imgUrl = urlMatch ? urlMatch[1].replace(/&amp;/g, "&") : "";
      detectedImages.push({
        file: fileMatch ? fileMatch[1] : "",
        url: imgUrl
      });
    }

    userText = rawText
      .replace(new RegExp(`\\[CQ:at,qq=${config.snowLuma.botQqId}\\]`, "g"), "")
      .replace(/\[CQ:image,[^\]]+\]/g, " [图片] ")
      .replace(/\[CQ:face,id=(\d+)\]/g, " [表情:$1] ")
      .replace(/\[CQ:[^\]]+\]/g, "");
  }

  userText = userText.trim();
  const effectiveCommandText = userText || (detectedImages.length > 0 ? "[图片]" : rawText);

  const persona = getActivePersona(config.antigravity?.agentPreset);
  const cleanSenderName = (event.sender?.card || event.sender?.nickname || "").trim();
  const safeSenderName = cleanSenderName || (senderId ? `群友(${senderId})` : "群友");

  // 3.1.0 尽早实时记入 SQLite 滚动胶卷（确保文字消息瞬时入库，不被图片网络下载耗时阻塞）
  const insertedMsgId = recordChatMessage(sessionKey, senderId, safeSenderName, effectiveCommandText, false, persona.displayName, []);

  // 本地纯算法群聊流行黑话词频统计 (0 Token 消耗)
  if (isGroup && userText) {
    try {
      trackGroupSlangFrequency(targetId, userText);
    } catch {}
  }

  // 管理员真实对话切片记录 (Tulpa Episodic Memory)
  if (isAdmin && effectiveCommandText && !effectiveCommandText.startsWith("/")) {
    try {
      recordTulpaEpisode({
        sessionKey,
        userId: senderId,
        userName: safeSenderName,
        userMessage: effectiveCommandText,
        replyMessage: ""
      });
    } catch {}
  }

  // 异步并发下载图片至本地 (按群组隔离缓存，Promise.allSettled 并发 + 6000ms 超时保护)
  const imageGroupId = isGroup ? targetId : `private:${targetId}`;
  let downloadedImages = [];
  if (detectedImages.length > 0) {
    const IMAGE_DOWNLOAD_TIMEOUT_MS = 6000;
    const downloadTasks = detectedImages.map(async (img) => {
      let timer;
      try {
        const downloadPromise = ensureDownloadedImage(img, imageGroupId);
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Image download timeout")), IMAGE_DOWNLOAD_TIMEOUT_MS);
        });
        const localPath = await Promise.race([downloadPromise, timeoutPromise]);
        if (localPath) {
          const fname = path.basename(localPath);
          return {
            path: localPath,
            file: fname,
            url: `/images/${fname}`
          };
        }
      } catch (err) {
        console.warn(`[Image] 并发下载图片异常: ${err.message}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return null;
    });

    const results = await Promise.allSettled(downloadTasks);
    downloadedImages = results
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => r.value);

    // 图片并发下载完成后，若成功获取到图片，回填更新到已入库记录中
    if (downloadedImages.length > 0 && insertedMsgId) {
      updateChatMessageImages(insertedMsgId, downloadedImages);
    }
  }

  
  // 3.1.1 角色感兴趣的话题关键词列表（命中时高概率探头插嘴）
  const interestKeywords = persona.interestKeywords || [];

  // 会话状态维护（基于 SQLite 持久化自愈）
  const session = getOrCreateSession(sessionKey);
  const now = Date.now();

  // 1. 显式提及判定（@机器人、喊人设名字、或者私聊）
  const isDirectMention = isAtBot || persona.mentionRegex.test(effectiveCommandText) || !isGroup;

  // 🌟 3.1.2 潜水硬锁检查：如果处于潜水锁定中
  if (session.sleepUntil && now < session.sleepUntil) {
    if (isDirectMention) {
      console.log(`⚡ [强唤醒打断潜水] 用户(${senderId}) 强行打断潜水锁定！`);
      session.sleepUntil = 0; // 解除潜水锁定
      saveSessionState(sessionKey, session);
    } else {
      // 本地静默拦截，0 Token 消耗！
      return;
    }
  }

  // 🌟 3.1.3 全局探头计数器（累积指定条数群消息，按概率触发路过吃瓜评估，受群触发策略约束）
  const allowAutonomous = !isGroup || managedGroupConfig?.trigger_policy !== "strict";
  const ambientThreshold = config.chatBehavior?.ambientTriggerThreshold ?? 10;
  const ambientProbability = config.chatBehavior?.ambientTriggerProbability ?? 0.10;
  session.messageCounter = (session.messageCounter || 0) + 1;
  let isAmbientCandidate = false;
  if (isGroup && allowAutonomous && session.messageCounter >= ambientThreshold) {
    session.messageCounter = 0;
    saveSessionState(sessionKey, session);
    if (Math.random() < ambientProbability) {
      isAmbientCandidate = true;
      console.log(`👀 [全局探头机制] 群聊累计满${ambientThreshold}条，触发 ${(ambientProbability * 100).toFixed(0)}% 吃瓜围观评估！`);
    }
  }

  // 2. 持续对话与上下文适格判定（私聊或处于活跃窗口内且同说话人）
  const isInActiveWindow = Boolean(session.activeUntil && now < session.activeUntil);
  const isContinuousSpeaker = Boolean(session.activeSpeaker && String(session.activeSpeaker) === String(senderId));
  const isContextEligible = !isGroup || (isInActiveWindow && isContinuousSpeaker);

  // 3. 指向性语义判定
  const isDirected = isDirectedAtAi(effectiveCommandText, isContextEligible);
  const isContinuousChat = isInActiveWindow && (isContinuousSpeaker || isDirected);

  // 4. 自主探头插嘴决策引擎（兴趣词，冷却受配置约束，严格受 trigger_policy 约束）
  let isInterestCandidate = false;
  const cdSeconds = config.chatBehavior?.interestCooldownSeconds ?? 60;
  if (isGroup && allowAutonomous && !isDirectMention && !isContinuousChat && !isDirected) {
    const lowerText = effectiveCommandText.toLowerCase();
    const hitKeyword = interestKeywords.some(kw => lowerText.includes(kw));
    const cdPassed = (now - (session.lastInterjectTime || 0)) > cdSeconds * 1000;
    if (cdPassed && hitKeyword) {
      isInterestCandidate = true;
      session.lastInterjectTime = now;
      console.log(`✨ [自主插嘴候选] 命中${persona.displayName}兴趣词，准备聚合评估！`);
    }
  }

  const shouldTriggerAI = isDirectMention || isContinuousChat || isDirected || isInterestCandidate || isAmbientCandidate;

  let triggerReason = "否 (已存入 SQLite 滚动记忆)";
  if (shouldTriggerAI) {
    if (isDirectMention) triggerReason = "直接提及(@或点名)";
    else if (isContinuousChat) triggerReason = `持续会话接话(活跃期剩余${Math.round((session.activeUntil - now)/1000)}s)`;
    else if (isDirected) triggerReason = "语义明确指向(isDirectedAtAi)";
    else if (isInterestCandidate) triggerReason = `命中${persona.displayName}兴趣词探头`;
    else if (isAmbientCandidate) triggerReason = `全局满${ambientThreshold}条${(ambientProbability * 100).toFixed(0)}%吃瓜探头`;

    // 刷新活跃期：延续配置秒数
    const activeWindowSeconds = config.chatBehavior?.activeWindowSeconds ?? 120;
    session.activeUntil = now + activeWindowSeconds * 1000;
    session.activeSpeaker = senderId;
    saveSessionState(sessionKey, session);
  }

  const imgInfo = downloadedImages.length > 0 ? ` [含 ${downloadedImages.length} 张图片]` : "";
  console.log(`📨 [收到${isGroup ? "群聊" : "私聊"}] 来自(${senderId}): "${effectiveCommandText}"${imgInfo} | 触发AI: ${triggerReason}`);

  // 实时推流到 Web 管理看板
  eventBus.emit("broadcast", {
    type: "message_in",
    data: {
      time: new Date().toLocaleTimeString(),
      sessionKey,
      session_key: sessionKey,
      groupId: isGroup ? event.group_id : null,
      group_id: isGroup ? event.group_id : null,
      senderId,
      sender_id: senderId,
      senderName: safeSenderName,
      sender_name: safeSenderName,
      text: effectiveCommandText,
      message_text: effectiveCommandText,
      message: effectiveCommandText,
      images: downloadedImages,
      isAtBot,
      is_bot: 0,
      isBot: false,
      triggerReason,
      shouldTriggerAI
    }
  });

  // 3.2 本地指令拦截（极速秒回，0 Token 消耗）
  const cleanCmd = effectiveCommandText.trim().replace(/^[\/／#！!]/, "");
  const isCommand = effectiveCommandText.startsWith("/") || 
    /^(好感度|好感度查询|我的好感度|affinity|where|人在哪|你人在哪|你现在在哪|在干嘛|你在干嘛|status|qqstatus|状态|系统状态)$/i.test(cleanCmd) ||
    effectiveCommandText.startsWith("/moveto");

  if (isCommand) {
    await handleSlashCommands(sessionKey, isGroup ? "group" : "private", targetId, effectiveCommandText, isAdmin, senderId);
    return;
  }

  // 3.3 群聊缓冲与隔离判定
  const debounceMs = config.chatBehavior?.debounceMs ?? 2500;
  const maxWaitMs = (config.chatBehavior?.silentBufferSeconds ?? config.daemon?.silentBufferLimit ?? 8) * 1000;

  const triggerDispatch = (options = {}) => {
    const b = batchBuffers.get(sessionKey);
    if (b) {
      if (b.debounceTimer) clearTimeout(b.debounceTimer);
      if (b.maxWaitTimer && options.force) clearTimeout(b.maxWaitTimer);
      if (b.timer && options.force) clearTimeout(b.timer);
    }
    dispatchBatch(sessionKey, options).catch((err) => {
      console.error(`❌ [dispatchBatch Timer 异常] 会话: ${sessionKey}:`, err?.stack || err?.message || err);
    });
  };

  if (batchBuffers.has(sessionKey)) {
    const existingBatch = batchBuffers.get(sessionKey);
    const primarySender = existingBatch.primarySenderId || existingBatch.senderId;
    const isSameUser = String(senderId) === String(primarySender);

    if (existingBatch.isPatrolWake) {
      // 当前是定时看群巡逻缓冲
      if (shouldTriggerAI) {
        // 收到真实用户触发消息，取消定时看群批次，由当前用户接管
        console.log(`🎯 [巡逻让位] 会话: ${sessionKey} 收到真实用户(${senderId})触发消息，取消定时看群批次`);
        if (existingBatch.debounceTimer) clearTimeout(existingBatch.debounceTimer);
        if (existingBatch.maxWaitTimer) clearTimeout(existingBatch.maxWaitTimer);
        if (existingBatch.timer) clearTimeout(existingBatch.timer);
        batchBuffers.delete(sessionKey);
        // 继续向下建立当前真实用户的批处理
      } else {
        // 仅是其他群友普通发言，已在 3.1.0 记入 SQLite，不混入巡逻批次，也不重置定时器
        return;
      }
    } else if (!isSameUser) {
      // 正在缓冲另一位用户的批处理：
      if (isDirectMention) {
        // 其他群友直接提及(@)机器人，立即提交前序用户的批处理，并为当前用户开启独立批处理
        console.log(`🔀 [批处理分离] 群友(${senderId}) 直接提及机器人，提前提交前序用户(${primarySender})的缓冲批次`);
        if (existingBatch.debounceTimer) clearTimeout(existingBatch.debounceTimer);
        if (existingBatch.maxWaitTimer) clearTimeout(existingBatch.maxWaitTimer);
        if (existingBatch.timer) clearTimeout(existingBatch.timer);
        await dispatchBatch(sessionKey, { force: true });
        // 此时前序批次已 dispatch 并从 batchBuffers 删除，继续向下为当前用户开启新批次
      } else {
        // 其他群友普通路过发言，严禁追加进当前用户的批处理缓冲，严禁重置防抖计时器
        console.log(`🔇 [群聊防抖隔离] 群友(${senderId}) 在用户(${primarySender})缓冲期间发言，已记入 SQLite，不混入批次`);
        return;
      }
    }
  }

  // 群聊判定：未决定触发 AI 且当前会话无正在缓冲中的批处理时，消息已在 3.1.0 写入 SQLite，在此静默结束
  if (isGroup && !shouldTriggerAI && !batchBuffers.has(sessionKey)) {
    return;
  }

  // 🌟 3.4 进入自适应滑动窗口防抖缓冲 (debounce 2.5s + maxWait 8s)
  if (!batchBuffers.has(sessionKey)) {
    const maxWaitTimer = setTimeout(() => triggerDispatch({ force: true }), maxWaitMs);

    batchBuffers.set(sessionKey, {
      messages: [],
      images: [],
      targetType: isGroup ? "group" : "private",
      targetId,
      senderId,
      primarySenderId: senderId,
      triggerReason,
      isDirectMention,
      isContinuousChat,
      isAutonomousInterject: isInterestCandidate || isAmbientCandidate,
      debounceTimer: null,
      maxWaitTimer,
      timer: maxWaitTimer
    });
  }

  const batch = batchBuffers.get(sessionKey);
  batch.messages.push({ senderId, text: effectiveCommandText });
  batch.extendedForUnfinished = false; // 用户持续输入新句子，重置未完结等待标记
  for (const di of downloadedImages) {
    if (!batch.images.some(i => i.path === di.path)) {
      batch.images.push(di);
    }
  }

  // 同用户持续打字刷屏，重置 2.5s 防抖计时器；maxWait 计时器不重置，8s 封顶强制截断发送
  if (batch.debounceTimer) clearTimeout(batch.debounceTimer);
  batch.debounceTimer = setTimeout(triggerDispatch, debounceMs);

  console.log(`📦 [自适应滑动窗口缓冲中] ${sessionKey} 已收集用户(${batch.primarySenderId}) ${batch.messages.length} 条碎片短句，${batch.images.length} 张图片 (静默防抖: ${debounceMs}ms / 封顶: ${maxWaitMs}ms)...`);
  } catch (err) {
    console.error(`❌ [handleOneBotMessage 异常]:`, err?.stack || err?.message || err);
  }
}

// 4. 本地指令（免额度秒回）
async function handleSlashCommands(sessionKey, targetType, targetId, text, isAdmin, senderId) {
  const persona = getActivePersona(config.antigravity?.agentPreset);

  // 管理员强制转移位置
  if (text.startsWith("/moveto")) {
    if (!isAdmin) {
      await sendQQMessage(targetType, targetId, "那个…请不要随便替我安排行程啦…");
      return;
    }
    const parts = text.split(/\s+/).slice(1);
    const loc = parts[0] || persona.defaultLocation;
    const act = parts.slice(1).join(" ") || persona.defaultAction;
    updateCharacterLocation(loc, act, "现场平稳", "自然", persona.name);
    await sendQQMessage(targetType, targetId, `📍 ${persona.displayName}的时空位置已更新！\n地点: 【${loc}】\n活动: 【${act}】`);
    return;
  }

  const clean = text.trim().replace(/^[\/／#！!]/, "").toLowerCase();

  // 群友查询当前位置与正在做的事
  if (clean === "where" || clean === "人在哪" || clean === "你人在哪" || clean === "你现在在哪" || clean === "在干嘛" || clean === "你在干嘛") {
    const s = getCharacterState(persona.name);
    await sendQQMessage(targetType, targetId, `📍 我现在在【${s.location}】呢…\n正在【${s.action}】\n细节: ${s.detail}`);
    return;
  }

  // 群友查询自己的好感度
  if (clean === "affinity" || clean === "好感度" || clean === "好感度查询" || clean === "我的好感度") {
    const aff = getUserAffinity(senderId);
    await sendQQMessage(targetType, targetId, `🌸 ${persona.displayName}对你的好感档案：\n• 当前好感度: ${aff.affinity_points} / 100\n• 关系阶段: 【${aff.level_name}】\n• 最近印象: ${aff.last_reason}`);
    return;
  }

  // 系统状态仪表盘
  if (clean === "status" || clean === "qqstatus" || clean === "状态" || clean === "系统状态") {
    const s = sessions.get(sessionKey) || { cascadeId: null, turnCount: 0 };
    const char = getCharacterState();
    const sleeping = Boolean(s.sleepUntil && Date.now() < s.sleepUntil);
    const active = Boolean(s.activeUntil && Date.now() < s.activeUntil);
    const maxTurns = config.chatBehavior?.maxTurns ?? config.antigravity?.maxTurns ?? 30;

    await sendQQMessage(targetType, targetId, 
      `📊 状态仪表盘：\n` +
      `• 当前人格: ${persona.displayName} (${persona.name})\n` +
      `• 当前会话: ${s.cascadeId ? s.cascadeId.slice(0, 8) + "..." : "空闲"}\n` +
      `• 轮次进度: ${s.turnCount || 0}/${maxTurns}\n` +
      `• 所在位置: ${char.location}\n` +
      `• 当前行为: ${char.action}\n` +
      `• 会话状态: ${sleeping ? "潜水中" : (active ? "活跃对话中" : "待机")}`);
    return;
  }

  // 重置会话切片
  if (clean === "reset" || clean === "qqnew" || text === "/reset" || text === "/qqnew") {
    const s = {
      sessionKey,
      cascadeId: null,
      turnCount: 0,
      lastInterjectTime: 0,
      activeUntil: 0,
      activeSpeaker: null,
      sleepUntil: 0,
      messageCounter: 0,
      lastPrompt: ""
    };
    sessions.set(sessionKey, s);
    saveSessionState(sessionKey, s);
    await sendQQMessage(targetType, targetId, "🔄 已手动切断当前会话切片，下次聊天开启全新上下文。");
    return;
  }
}

// 5. Antigravity 配额探测与智能防爆守护
let lastQuotaStatus = null;
let lastQuotaCheckTime = 0;
const QUOTA_CACHE_TTL = 30000;

async function checkAntigravityQuota(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && lastQuotaStatus && (now - lastQuotaCheckTime < QUOTA_CACHE_TTL)) {
    return lastQuotaStatus;
  }
  try {
    const { AgyConnectRpcClient } = await import("./connect-rpc-client.mjs");
    const client = new AgyConnectRpcClient();
    const status = await client.getCombinedQuotaHealth(forceRefresh);
    lastQuotaStatus = status;
    lastQuotaCheckTime = now;

    if (status.isThrottled || status.isExhausted) {
      console.warn(`⚠️ [配额防爆预警] Antigravity 配额余量紧张 (${status.lowestRemainingPercent ?? 0}%)！${status.throttleReason || '已自动启动防爆熔断限流'}，暂停非必要定时看群巡逻！`);
      eventBus.emit("broadcast", {
        type: "quota_warning",
        data: status
      });
    }
    return status;
  } catch (err) {
    const isRateLimited = /resource_exhausted|rate_limit|too_many_requests|429/i.test(err.message || "");
    const errStatus = {
      success: false,
      error: err.message,
      groups: [],
      lowestRemainingPercent: isRateLimited ? 0 : undefined,
      isExhausted: isRateLimited,
      isThrottled: isRateLimited,
      isRateLimited,
      throttleReason: isRateLimited ? `配额或速率熔断: ${err.message}` : null
    };
    if (isRateLimited) {
      console.warn(`⚠️ [配额防爆预警] 检测到语言服务速率熔断 (${err.message})，暂停非必要定时看群巡逻！`);
      eventBus.emit("broadcast", {
        type: "quota_warning",
        data: errStatus
      });
    }
    return errStatus;
  }
}

// 6. 仿生定时随机看群引擎（在设定时间区间内随机抽样看群，是否发言完全由角色自主决定）
function startPatrolScheduler() {
  const minMins = config.chatBehavior?.patrolMinMinutes ?? config.daemon?.patrolMinMinutes ?? 3;
  const maxMins = config.chatBehavior?.patrolMaxMinutes ?? config.daemon?.patrolMaxMinutes ?? 8;
  const randomMinutes = Math.random() * (maxMins - minMins) + minMins;
  const nextDelayMs = Math.round(randomMinutes * 60 * 1000);

  console.log(`⏱️ [定时看群引擎] 下次随机看群定于 ${randomMinutes.toFixed(1)} 分钟后 (${new Date(Date.now() + nextDelayMs).toLocaleTimeString()})`);

  setTimeout(async () => {
    try {
      // 检查 Antigravity 配额防爆状态，余量不足 10% 时智能跳过巡逻
      const quota = await checkAntigravityQuota();
      if (quota && (quota.isThrottled || quota.isExhausted)) {
        console.log(`🛡️ [防爆保护拦截] 当前配额余量紧张 (${quota.lowestRemainingPercent || 0}% < 10%)，已智能跳过定时看群巡逻与非必要自动化打扰。`);
        return;
      }

      // 从 SQLite 读取启用的托管群组，且排除了 strict 触发模式的群
      const managed = getManagedGroups().filter(g => g.enabled && g.trigger_policy !== "strict");
      const allowedGroups = managed.map(g => g.group_id);
      const now = Date.now();

      for (const groupId of allowedGroups) {
        const sessionKey = `group:${groupId}`;
        const session = getOrCreateSession(sessionKey);

        // 如果正处于连续活跃对话窗口中，群友聊得正热，无需插入定时探头
        if (session.activeUntil && now < session.activeUntil) {
          continue;
        }

        // 如果正在硬性潜水锁定中且时间未到，尊重角色的前序潜水决策
        if (session.sleepUntil && now < session.sleepUntil) {
          console.log(`⏱️ [定时看群] 群 ${groupId} 当前处于硬锁潜水期，跳过此次探头`);
          continue;
        }

        // 避免在 8 秒缓冲聚合还没发完时重复触发
        if (batchBuffers.has(sessionKey)) {
          continue;
        }

        console.log(`👀 [定时看群引擎触发] 角色随机扫了一眼群 ${groupId} 的最新动态，进入自主决策...`);

        // 打包一次看群心跳批次（使用系统专用 sender ID 0，避免误伤或读取管理员好感度）
        const systemSenderId = 0;
        batchBuffers.set(sessionKey, {
          messages: [{ senderId: systemSenderId, text: "[日常看群]" }],
          targetType: "group",
          targetId: groupId,
          senderId: systemSenderId,
          primarySenderId: systemSenderId,
          triggerReason: "定时随机看群",
          isDirectMention: false,
          isContinuousChat: false,
          isAutonomousInterject: true,
          isPatrolWake: true,
          timer: setTimeout(() => {
            dispatchBatch(sessionKey).catch((err) => {
              console.error(`❌ [dispatchBatch Patrol Timer 异常] 会话: ${sessionKey}:`, err?.stack || err?.message || err);
            });
          }, 1000)
        });
      }
    } catch (e) {
      console.error("[Patrol Engine Error]:", e.message);
    } finally {
      // 安排下一次循环
      startPatrolScheduler();
    }
  }, nextDelayMs);
}

const daemonApi = {
  getSnowLumaStatus: () => ({
    connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
    wsUrl: config.snowLuma?.wsUrl,
    botQqId: config.snowLuma?.botQqId
  }),
  getQuotaStatus: async (force = false) => await checkAntigravityQuota(force),
  isQuotaThrottled: () => Boolean(lastQuotaStatus?.isThrottled || lastQuotaStatus?.isExhausted),
  getActiveSessions: () => {
    const result = [];
    for (const [key, s] of sessions.entries()) {
      result.push({
        sessionKey: key,
        cascadeId: s.cascadeId,
        turnCount: s.turnCount,
        isSleeping: Boolean(s.sleepUntil && Date.now() < s.sleepUntil),
        sleepRemainingSec: s.sleepUntil ? Math.max(0, Math.round((s.sleepUntil - Date.now()) / 1000)) : 0,
        isActive: Boolean(s.activeUntil && Date.now() < s.activeUntil),
        activeRemainingSec: s.activeUntil ? Math.max(0, Math.round((s.activeUntil - Date.now()) / 1000)) : 0,
        activeSpeaker: s.activeSpeaker
      });
    }
    return result;
  },
  sendQQMessage: async (targetType, targetId, message) => {
    return await sendQQMessage(targetType, targetId, message);
  },
  deleteGroup: (groupId) => {
    const gid = Number(groupId);
    deleteManagedGroup(gid);
    // 从 config.snowLuma.allowedGroupIds 中同步移除并持久化
    if (config.snowLuma?.allowedGroupIds) {
      config.snowLuma.allowedGroupIds = config.snowLuma.allowedGroupIds.filter(id => Number(id) !== gid);
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      } catch {}
    }
    // 清除该群挂起的批处理缓冲与定时器
    const key = `group:${gid}`;
    const batch = batchBuffers.get(key);
    if (batch?.debounceTimer) clearTimeout(batch.debounceTimer);
    if (batch?.maxWaitTimer) clearTimeout(batch.maxWaitTimer);
    if (batch?.timer) clearTimeout(batch.timer);
    batchBuffers.delete(key);
    sessions.delete(key);
    deleteSessionState(key);
    return true;
  },
  toggleGroup: (groupId, enabled) => {
    const gid = Number(groupId);
    const row = toggleGroupEnabled(gid, enabled);
    if (!enabled) {
      const key = `group:${gid}`;
      const batch = batchBuffers.get(key);
      if (batch?.debounceTimer) clearTimeout(batch.debounceTimer);
      if (batch?.maxWaitTimer) clearTimeout(batch.maxWaitTimer);
      if (batch?.timer) clearTimeout(batch.timer);
      batchBuffers.delete(key);
    }
    return row;
  },
  resetSession: (sessionKey) => {
    const b = batchBuffers.get(sessionKey);
    if (b?.debounceTimer) clearTimeout(b.debounceTimer);
    if (b?.maxWaitTimer) clearTimeout(b.maxWaitTimer);
    if (b?.timer) clearTimeout(b.timer);
    batchBuffers.delete(sessionKey);
    const defaultState = {
      sessionKey,
      cascadeId: null,
      turnCount: 0,
      lastInterjectTime: 0,
      activeUntil: 0,
      activeSpeaker: null,
      sleepUntil: 0,
      messageCounter: 0,
      lastPrompt: ""
    };
    sessions.set(sessionKey, defaultState);
    saveSessionState(sessionKey, defaultState);
  },
  resetAllSessions: () => {
    for (const [key, b] of batchBuffers.entries()) {
      if (b?.debounceTimer) clearTimeout(b.debounceTimer);
      if (b?.maxWaitTimer) clearTimeout(b.maxWaitTimer);
      if (b?.timer) clearTimeout(b.timer);
    }
    batchBuffers.clear();
    sessions.clear();
    clearSessionStates();
  },
  switchPersona: (presetName) => {
    const p = getActivePersona(presetName);
    if (config.antigravity) {
      config.antigravity.agentPreset = p.name;
    }
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch {}

    // 切断所有群已有级联会话，迫使各群下次发言时使用新人设启动全新会话
    for (const [k, s] of sessions.entries()) {
      s.cascadeId = null;
      s.turnCount = 0;
      saveSessionState(k, s);
    }

    // 将全局时空身位同步切换为新人设的专属时空身位
    syncCharacterStateForPersona(p.name);

    const newState = getCharacterState(p.name);
    eventBus.emit("broadcast", { type: "state_change", data: newState });
    eventBus.emit("broadcast", { type: "persona_switch", data: { activePreset: p.name, persona: p } });

    console.log(`🎭 [人设热切换] 当前人设已切换为: ${p.displayName} (${p.name})，时空位置迁移至【${newState.location}】`);
    return true;
  },
  reloadConfig: () => {
    if (fs.existsSync(configPath)) {
      try {
        const newCfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        Object.assign(config, newCfg);
        if (newCfg.chatBehavior) {
          config.chatBehavior = { ...DEFAULT_CONFIG.chatBehavior, ...newCfg.chatBehavior };
        }
        initManagedGroups(config.snowLuma?.allowedGroupIds || []);
        console.log("🔄 [配置重载] config.json 已重新加载");
      } catch (err) {
        console.warn("⚠️ [配置重载] 失败:", err.message);
      }
    }
  },
  getConfig: () => config,
  updateConfig: (patch) => {
    if (patch.chatBehavior) {
      config.chatBehavior = { ...(config.chatBehavior || DEFAULT_CONFIG.chatBehavior), ...patch.chatBehavior };
    }
    if (patch.daemon) {
      config.daemon = { ...(config.daemon || DEFAULT_CONFIG.daemon), ...patch.daemon };
    }
    if (patch.antigravity) {
      config.antigravity = { ...(config.antigravity || DEFAULT_CONFIG.antigravity), ...patch.antigravity };
    }
    if (patch.pricing) {
      config.pricing = { ...(config.pricing || {}), ...patch.pricing };
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log("💾 [配置保存] 配置已更新至 config.json");
    eventBus.emit("broadcast", { type: "config_updated", data: config });
    return config;
  },
  getLogBuffer: () => logBuffer,
  captureLog: (level, ...args) => captureLog(level, ...args),
  cleanImages: (maxKeep = (config.chatBehavior?.maxImages ?? 15)) => cleanImagesFifo(maxKeep),
  reloadWechatGroupMaps: () => reloadWechatGroupMaps(),
  syncWechatGroup: async (action, roomName) => await syncWechatListenToDaemon(action, roomName),
  broadcastEvent: (type, data) => eventBus.emit("broadcast", { type, data })
};

let webServerInstance = null;

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) {
  // 确保开机时角色时空位置与活跃人设严格对齐
  const activePreset = config.antigravity?.agentPreset || "tomoko";
  syncCharacterStateForPersona(activePreset);

  // 启动自愈：清理超过 5 分钟的过期历史积压消息，防止堆积阻塞
  const staleCount = cleanStaleInboxMessages(300);
  if (staleCount > 0) {
    console.log(`🧹 [InboxQueue 启动自愈] 成功清理 ${staleCount} 条超过 5 分钟的过期积压消息`);
  }

  // 周期性自愈维护：每 60 秒检查并清理积压超过 5 分钟的陈旧消息
  const cleanupInterval = setInterval(() => {
    try {
      cleanStaleInboxMessages(300);
    } catch {}
  }, 60000);
  if (cleanupInterval.unref) cleanupInterval.unref();

  // 清理遗留废弃的 inbox.json 文件，系统已全面收敛至 SQLite inbox_queue 原子队列
  const inboxPath = path.resolve(PROJECT_ROOT, "data/inbox.json");
  if (fs.existsSync(inboxPath)) {
    try { fs.unlinkSync(inboxPath); } catch {}
  }

  // 启动自愈与自动归档：每日定期清理超过 30 天的历史流水日志 (保留好感度与核心记忆)
  try {
    pruneOldRecords(30);
    checkpointDatabase("TRUNCATE");
  } catch {}
  const dailyPruneInterval = setInterval(() => {
    try {
      pruneOldRecords(30);
      checkpointDatabase("TRUNCATE");
    } catch {}
  }, 24 * 60 * 60 * 1000);
  if (dailyPruneInterval.unref) dailyPruneInterval.unref();

  // 定期 WAL Checkpoint 维护：每小时截断一次 WAL 文件，确保轻量紧凑
  const hourlyCheckpointInterval = setInterval(() => {
    try {
      checkpointDatabase("TRUNCATE");
    } catch {}
  }, 60 * 60 * 1000);
  if (hourlyCheckpointInterval.unref) hourlyCheckpointInterval.unref();

  internalServer.listen(config.daemon.internalHttpPort, "127.0.0.1", () => {
    console.log(`[Bridge Daemon] 内部通信网关已就绪，端口: 127.0.0.1:${config.daemon.internalHttpPort}`);
  });

  const isWechatOnly = process.argv.includes("--wechat-only") || process.env.HAKIMI_MODE === "wechat";
  if (isWechatOnly) {
    console.log("[Bridge Daemon] 📱 正在以【纯微信伴聊模式】运行，已跳过 QQ 连接，微信网关与 Web 看板全面就绪。");
  } else {
    connectSnowLuma();
  }
  startPatrolScheduler();

  // 启动统一 Web 管理端 (Port 5120)
  webServerInstance = createWebServer({ config, eventBus, daemonApi });
  webServerInstance.start().catch(err => {
    console.error("❌ [Web 管理平台启动失败]:", err.message);
  });

  console.log(`💡 [IDE 伴聊模式] 标准 Antigravity Companion Skill 架构已就绪`);
  console.log(`   • Web 控制台: http://127.0.0.1:${config.web?.port || 5120}`);
  console.log(`   • 内部 IPC 网关: http://127.0.0.1:${config.daemon.internalHttpPort}`);
  console.log(`   • 伴聊响应指令: 在 Antigravity 对话框中发送 "一键启动哈基米聊天系统" 即可进入循环`);
}

export {
  internalServer,
  processOutboundMessage,
  isDirectedAtAi,
  sendQQMessage,
  sendSingleMessage,
  handleSlashCommands,
  config,
  sessions,
  batchBuffers,
  eventBus,
  daemonApi,
  cleanImagesFifo,
  createWebServer,
  checkAntigravityQuota,
  recordOutboundTokenUsage,
  handleOneBotMessage,
  dispatchBatch,
  UNFINISHED_REGEX,
  splitIntoBubbles
};
