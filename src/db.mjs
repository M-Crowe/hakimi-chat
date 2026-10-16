import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PERSONAS, getActivePersona } from "./personas.mjs";
import { calculateTokenCost } from "./pricing.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, "state.db"));

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

// 1. 初始化数据库表结构（对齐多重人设与独立时空身位）
db.exec(`
  CREATE TABLE IF NOT EXISTS character_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    persona TEXT DEFAULT 'tomoko',
    location TEXT NOT NULL DEFAULT '海外家中二楼房间',
    action TEXT NOT NULL DEFAULT '坐在地毯上抱着 Switch 玩单机，手边放着麦茶',
    detail TEXT NOT NULL DEFAULT '房间里只有游戏手柄按键的声音和屏幕光影',
    mood TEXT NOT NULL DEFAULT '放松、专注',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS persona_states (
    persona TEXT PRIMARY KEY,
    location TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    mood TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_affinity (
    user_id INTEGER PRIMARY KEY,
    affinity_points INTEGER DEFAULT 30,
    level_name TEXT DEFAULT '初识',
    last_reason TEXT DEFAULT '初始结识',
    last_interact DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_memories (
    session_key TEXT PRIMARY KEY,
    memory_text TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 滚动对话上下文表（无论是否 @ 均持久化，解决遗忘上下文痛点）
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_name TEXT DEFAULT '',
    message_text TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    is_bot INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_session_time 
  ON chat_messages (session_key, id DESC);

  -- 群聊流行黑话/网络用语学习表（轻量顺风车学习）
  CREATE TABLE IF NOT EXISTS slangs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT UNIQUE NOT NULL,
    meaning TEXT DEFAULT '',
    count INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_slangs_count 
  ON slangs (count DESC);

  -- 消息原子队列（单句单条原子出入队，杜绝文件并发竞态）
  CREATE TABLE IF NOT EXISTS inbox_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 会话活跃状态与上下文窗口持久化表（重启自愈，保证连续对话窗口与说话人不丢失）
  CREATE TABLE IF NOT EXISTS session_states (
    session_key TEXT PRIMARY KEY,
    active_until INTEGER DEFAULT 0,
    active_speaker INTEGER DEFAULT NULL,
    sleep_until INTEGER DEFAULT 0,
    last_interject_time INTEGER DEFAULT 0,
    message_counter INTEGER DEFAULT 0,
    cascade_id TEXT DEFAULT NULL,
    turn_count INTEGER DEFAULT 0,
    last_prompt TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 群组管理表（白名单、别名、独立启闭、触发策略）
  CREATE TABLE IF NOT EXISTS managed_groups (
    group_id INTEGER PRIMARY KEY,
    group_name TEXT NOT NULL DEFAULT '',
    enabled INTEGER DEFAULT 1,
    trigger_policy TEXT DEFAULT 'all', -- 'all' (允许自主插嘴) 或 'strict' (仅@或点名/直问)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Token 用量监测表（双轨 Token 估算 + 真实字符统计 + 思考Token + 吞吐速率 + 成本核算）
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    group_id INTEGER DEFAULT 0,
    persona TEXT NOT NULL DEFAULT 'tomoko',
    prompt_chars INTEGER DEFAULT 0,
    reply_chars INTEGER DEFAULT 0,
    estimated_prompt_tokens INTEGER DEFAULT 0,
    estimated_reply_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    throughput_tps REAL DEFAULT 0.0,
    cost_cny REAL DEFAULT 0.0,
    cost_usd REAL DEFAULT 0.0,
    model_name TEXT DEFAULT '',
    cached_tokens INTEGER DEFAULT 0,
    new_tokens INTEGER DEFAULT 0,
    cache_hit_rate REAL DEFAULT 0.0,
    total_tokens INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_token_usage_group ON token_usage (group_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_token_usage_persona ON token_usage (persona, created_at DESC);
`);

// 优雅平滑升级：补充 character_state 的 persona 字段与 chat_messages 的 images 字段，以及 token_usage 增强字段
try {
  db.exec("ALTER TABLE character_state ADD COLUMN persona TEXT DEFAULT 'tomoko';");
} catch {}
try {
  db.exec("ALTER TABLE chat_messages ADD COLUMN images TEXT DEFAULT '[]';");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER DEFAULT 0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN new_tokens INTEGER DEFAULT 0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN cache_hit_rate REAL DEFAULT 0.0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN reasoning_tokens INTEGER DEFAULT 0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN duration_ms INTEGER DEFAULT 0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN throughput_tps REAL DEFAULT 0.0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN cost_cny REAL DEFAULT 0.0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN cost_usd REAL DEFAULT 0.0;");
} catch {}
try {
  db.exec("ALTER TABLE token_usage ADD COLUMN model_name TEXT DEFAULT '';");
} catch {}


// 初始化各已知人设的专属时空状态基准
for (const [key, p] of Object.entries(PERSONAS)) {
  db.prepare(`
    INSERT OR IGNORE INTO persona_states (persona, location, action, detail, mood)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, p.defaultLocation, p.defaultAction, p.defaultDetail || "现场平稳", p.defaultMood || "自然");
}

// 确保初始行存在
db.exec(`
  INSERT OR IGNORE INTO character_state (id, persona, location, action, detail, mood) 
  VALUES (1, 'tomoko', '海外家中二楼房间', '坐在地毯上抱着 Switch 玩单机，手边放着麦茶', '房间里只有游戏手柄按键的声音和屏幕光影', '放松、专注');
`);

// 启动自愈：清理超过 5 分钟的过期积压消息
try {
  cleanStaleInboxMessages(300);
} catch {}

/**
 * 获取角色当前所处位置、正在做的事情、现场细节和心情
 * 可指定 personaKey 查询人设专属位置，未指定时返回当前生效的 character_state
 */
export function getCharacterState(personaKey = null) {
  if (personaKey) {
    const key = String(personaKey).toLowerCase().trim();
    const query = db.prepare("SELECT persona, location, action, detail, mood, updated_at FROM persona_states WHERE persona = ?");
    let row = query.get(key);
    if (!row) {
      const p = getActivePersona(key);
      db.prepare(`
        INSERT OR IGNORE INTO persona_states (persona, location, action, detail, mood)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, p.defaultLocation, p.defaultAction, p.defaultDetail || "现场平稳", p.defaultMood || "自然");
      row = query.get(key);
    }
    return row || {
      persona: key,
      location: "海外家中二楼房间",
      action: "打主机游戏中",
      detail: "一个人在房间",
      mood: "放松"
    };
  }

  const query = db.prepare("SELECT persona, location, action, detail, mood, updated_at FROM character_state WHERE id = 1");
  const row = query.get();
  return row || {
    persona: "tomoko",
    location: "海外家中二楼房间",
    action: "打主机游戏中",
    detail: "一个人在房间",
    mood: "放松"
  };
}

/**
 * 将当前生效的 character_state (id = 1) 切换为指定人设的时空身位
 */
export function syncCharacterStateForPersona(personaKey = "tomoko") {
  const key = String(personaKey || "tomoko").toLowerCase().trim();
  const state = getCharacterState(key);

  const stmt = db.prepare(`
    INSERT INTO character_state (id, persona, location, action, detail, mood, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      persona = excluded.persona,
      location = excluded.location,
      action = excluded.action,
      detail = excluded.detail,
      mood = excluded.mood,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(key, state.location, state.action, state.detail, state.mood);
  return getCharacterState();
}

/**
 * 更新角色位置与当前行为（支持 [state:地点|活动|细节] 标签自动驱动，或管理员指令）
 */
export function updateCharacterLocation(location, action, detail = "", mood = "自然", personaKey = null) {
  let activeKey = personaKey;
  if (!activeKey) {
    const cur = db.prepare("SELECT persona FROM character_state WHERE id = 1").get();
    activeKey = cur?.persona || "tomoko";
  }
  activeKey = String(activeKey).toLowerCase().trim();
  const personaDef = getActivePersona(activeKey);

  if (location === "home") {
    location = personaDef.defaultLocation || "海外家中二楼房间";
    action = action || personaDef.defaultAction || "吃饱回家休息中";
    detail = detail || personaDef.defaultDetail || "回到自己熟悉温暖的房间";
  }

  // 1. 同步更新 character_state (id = 1)
  const stmt = db.prepare(`
    INSERT INTO character_state (id, persona, location, action, detail, mood, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      persona = excluded.persona,
      location = excluded.location,
      action = excluded.action,
      detail = excluded.detail,
      mood = excluded.mood,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(activeKey, location, action, detail, mood);

  // 2. 同步更新 persona_states 专属记忆
  db.prepare(`
    INSERT INTO persona_states (persona, location, action, detail, mood, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(persona) DO UPDATE SET
      location = excluded.location,
      action = excluded.action,
      detail = excluded.detail,
      mood = excluded.mood,
      updated_at = CURRENT_TIMESTAMP
  `).run(activeKey, location, action, detail, mood);
}


/**
 * 好感度计算与等级映射（严格对齐 Tomoko 设定：-100 ~ 100，默认 30）
 * 1. 嫌恶 (< 0)
 * 2. 戒备 (0 ~ 29)
 * 3. 初识 (30 ~ 49)
 * 4. 朋友 (50 ~ 69)
 * 5. 挚友 (70 ~ 89)
 * 6. 特别 (90 ~ 100)
 */
export function getAffinityLevelName(points) {
  if (points < 0) return "嫌恶";
  if (points <= 29) return "戒备";
  if (points <= 49) return "初识";
  if (points <= 69) return "朋友";
  if (points <= 89) return "挚友";
  return "特别";
}

/**
 * 好感度系统：读取用户好感度与称谓
 */
export function getUserAffinity(userId) {
  const query = db.prepare("SELECT user_id, affinity_points, level_name, last_reason FROM user_affinity WHERE user_id = ?");
  let row = query.get(userId);
  if (!row) {
    db.prepare("INSERT INTO user_affinity (user_id, affinity_points, level_name, last_reason) VALUES (?, 30, '初识', '初始结识')").run(userId);
    row = { user_id: userId, affinity_points: 30, level_name: "初识", last_reason: "初始结识" };
  }
  return row;
}

/**
 * 好感度系统：根据 [af:+3|理由] 动态加减分
 */
export function modifyUserAffinity(userId, delta, reason = "") {
  const current = getUserAffinity(userId);
  let newPoints = (current.affinity_points ?? 30) + delta;
  // 范围约束在 -100 ~ 100
  if (newPoints > 100) newPoints = 100;
  if (newPoints < -100) newPoints = -100;

  const newLevel = getAffinityLevelName(newPoints);
  const effectiveReason = (reason && reason.trim()) ? reason.trim() : (current.last_reason || "互动更新");

  const stmt = db.prepare(`
    UPDATE user_affinity 
    SET affinity_points = ?, level_name = ?, last_reason = ?, last_interact = CURRENT_TIMESTAMP 
    WHERE user_id = ?
  `);
  stmt.run(newPoints, newLevel, effectiveReason, userId);
  return { newPoints, newLevel, reason: effectiveReason };
}

/**
 * 跨会话记忆快照读取
 */
export function getSessionMemory(sessionKey) {
  const query = db.prepare("SELECT memory_text FROM session_memories WHERE session_key = ?");
  const row = query.get(sessionKey);
  return row ? row.memory_text : "";
}

/**
 * 跨会话记忆快照保存
 */
export function saveSessionMemory(sessionKey, memoryText) {
  const stmt = db.prepare(`
    INSERT INTO session_memories (session_key, memory_text, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_key) DO UPDATE SET memory_text = excluded.memory_text, updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(sessionKey, memoryText);
}

/**
 * 将待处理的消息原子压入接收队列
 */
export function pushInboxMessage(payloadObj, createdAt = null) {
  const payloadStr = typeof payloadObj === "string" ? payloadObj : JSON.stringify(payloadObj);
  if (createdAt) {
    const stmt = db.prepare("INSERT INTO inbox_queue (payload, created_at) VALUES (?, ?)");
    stmt.run(payloadStr, createdAt);
  } else {
    const stmt = db.prepare("INSERT INTO inbox_queue (payload) VALUES (?)");
    stmt.run(payloadStr);
  }
}

/**
 * 单条原子出队：使用 DELETE ... RETURNING 一步完成获取与删除，避免并发读写竞态
 */
export function popInboxMessage() {
  const stmt = db.prepare(`
    DELETE FROM inbox_queue 
    WHERE id = (SELECT id FROM inbox_queue ORDER BY id ASC LIMIT 1) 
    RETURNING payload
  `);
  const row = stmt.get();
  if (!row || !row.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return row.payload;
  }
}

/**
 * 清理 inbox_queue 中超时的过期陈旧消息 (默认 TTL 5 分钟 / 300 秒)
 * 在守护进程启动及日常维护时调用，防止历史陈旧消息堆积堵塞或在重启时重放
 */
export function cleanStaleInboxMessages(ttlSeconds = 300) {
  try {
    const ttl = Math.max(0, parseInt(ttlSeconds, 10) || 300);
    const stmt = db.prepare(`
      DELETE FROM inbox_queue 
      WHERE created_at < datetime('now', '-' || ? || ' seconds')
    `);
    const result = stmt.run(ttl);
    return result.changes;
  } catch (err) {
    console.error("[InboxQueue TTL] 清理陈旧消息异常:", err.message);
    return 0;
  }
}

/**
 * 获取单个会话的持久化状态
 */
export function getSessionState(sessionKey) {
  if (!sessionKey) return null;
  const stmt = db.prepare("SELECT * FROM session_states WHERE session_key = ?");
  const row = stmt.get(sessionKey);
  if (!row) return null;
  return {
    sessionKey: row.session_key,
    activeUntil: Number(row.active_until) || 0,
    activeSpeaker: row.active_speaker != null ? Number(row.active_speaker) : null,
    sleepUntil: Number(row.sleep_until) || 0,
    lastInterjectTime: Number(row.last_interject_time) || 0,
    messageCounter: Number(row.message_counter) || 0,
    cascadeId: row.cascade_id || null,
    turnCount: Number(row.turn_count) || 0,
    lastPrompt: row.last_prompt || ""
  };
}

/**
 * 保存或更新单个会话的持久化状态 (原子 Upsert)
 */
export function saveSessionState(sessionKey, state = {}) {
  if (!sessionKey) return;
  const stmt = db.prepare(`
    INSERT INTO session_states (
      session_key, active_until, active_speaker, sleep_until, 
      last_interject_time, message_counter, cascade_id, turn_count, last_prompt, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_key) DO UPDATE SET
      active_until = excluded.active_until,
      active_speaker = excluded.active_speaker,
      sleep_until = excluded.sleep_until,
      last_interject_time = excluded.last_interject_time,
      message_counter = excluded.message_counter,
      cascade_id = excluded.cascade_id,
      turn_count = excluded.turn_count,
      last_prompt = excluded.last_prompt,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(
    sessionKey,
    Number(state.activeUntil) || 0,
    state.activeSpeaker != null ? Number(state.activeSpeaker) : null,
    Number(state.sleepUntil) || 0,
    Number(state.lastInterjectTime) || 0,
    Number(state.messageCounter) || 0,
    state.cascadeId || null,
    Number(state.turnCount) || 0,
    state.lastPrompt || ""
  );
}

/**
 * 获取所有已持久化的会话状态列表
 */
export function getAllSessionStates() {
  const stmt = db.prepare("SELECT * FROM session_states");
  const rows = stmt.all();
  return rows.map(row => ({
    sessionKey: row.session_key,
    activeUntil: Number(row.active_until) || 0,
    activeSpeaker: row.active_speaker != null ? Number(row.active_speaker) : null,
    sleepUntil: Number(row.sleep_until) || 0,
    lastInterjectTime: Number(row.last_interject_time) || 0,
    messageCounter: Number(row.message_counter) || 0,
    cascadeId: row.cascade_id || null,
    turnCount: Number(row.turn_count) || 0,
    lastPrompt: row.last_prompt || ""
  }));
}

/**
 * 删除单个会话状态
 */
export function deleteSessionState(sessionKey) {
  if (!sessionKey) return;
  const stmt = db.prepare("DELETE FROM session_states WHERE session_key = ?");
  stmt.run(sessionKey);
}

/**
 * 清空所有会话状态
 */
export function clearSessionStates() {
  db.exec("DELETE FROM session_states;");
}

/**
 * 记录单条群消息（无论群友发言还是机器人回复）
 * 包含单条超长自动截断保护（防小作文刷屏烧额度）与空值防御
 */
export function recordChatMessage(sessionKey, senderId, senderName, text, isBot = false, botName = "智子", images = []) {
  if (!text || !text.trim()) return;
  // 单条文本安全截断上限为 150 字
  const safeText = text.trim().slice(0, 150);
  const cleanId = (senderId && String(senderId) !== "undefined" && String(senderId) !== "null") ? Number(senderId) : 0;
  const defaultSpeaker = isBot ? (botName || "Bot") : (cleanId ? `群友(${cleanId})` : "群友");
  let finalSpeaker = (senderName && String(senderName) !== "undefined" && String(senderName).trim()) ? String(senderName).trim() : defaultSpeaker;
  const imagesJson = Array.isArray(images) && images.length ? JSON.stringify(images) : "[]";

  const stmt = db.prepare(`
    INSERT INTO chat_messages (session_key, sender_id, sender_name, message_text, is_bot, images)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(sessionKey, cleanId, finalSpeaker, safeText, isBot ? 1 : 0, imagesJson);

  // 维持单群最多 200 条轻量历史，多余的自然清除
  db.prepare(`
    DELETE FROM chat_messages 
    WHERE session_key = ? AND id NOT IN (
      SELECT id FROM chat_messages WHERE session_key = ? ORDER BY id DESC LIMIT 200
    )
  `).run(sessionKey, sessionKey);
}


/**
 * 获取最近滑动窗口上下文（核心省额度剪枝算法）
 * 1. 取出最近 limit 条（默认 15 条）；
 * 2. 按时间升序重排；
 * 3. 同人连续短句自动合并（省去重复昵称/元数据 60% Token 开销）；
 * 4. 组装成紧凑清晰的上下文块返回。
 */
export function getRecentChatContext(sessionKey, limit = 15) {
  const query = db.prepare(`
    SELECT sender_id, sender_name, message_text, is_bot, created_at 
    FROM chat_messages 
    WHERE session_key = ? 
    ORDER BY id DESC 
    LIMIT ?
  `);
  const rawRows = query.all(sessionKey, limit);
  if (!rawRows || rawRows.length === 0) return "";

  // 反转为时间从前到后
  const rows = rawRows.reverse();

  // 同人连续发言智能合并压缩
  const merged = [];
  for (const row of rows) {
    const speaker = row.is_bot ? (row.sender_name || "Bot") : (row.sender_name || `群友(${row.sender_id})`);
    const last = merged[merged.length - 1];

    if (last && last.speaker === speaker) {
      // 同一人连续发言，用逗号连接合并为一条，大幅减少格式 Token
      last.text += `，${row.message_text}`;
    } else {
      merged.push({ speaker, text: row.message_text });
    }
  }

  // 格式化输出为紧凑文本
  return merged.map(m => `${m.speaker}: ${m.text}`).join("\n");
}

/**
 * 记录或更新群聊黑话（顺风车学习）
 */
export function recordSlang(word, meaning = "") {
  if (!word || !word.trim()) return;
  const cleanWord = word.trim().slice(0, 30);
  const cleanMeaning = (meaning || "").trim().slice(0, 100);

  const stmt = db.prepare(`
    INSERT INTO slangs (word, meaning, count, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(word) DO UPDATE SET
      count = count + 1,
      meaning = CASE WHEN ? != '' THEN ? ELSE meaning END,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(cleanWord, cleanMeaning, cleanMeaning, cleanMeaning);
}

/**
 * 获取本群最常出现的 Top N 流行黑话
 */
export function getTopSlangs(limit = 5) {
  const query = db.prepare(`
    SELECT word, meaning, count 
    FROM slangs 
    ORDER BY count DESC 
    LIMIT ?
  `);
  return query.all(limit);
}

// -------------------------------------------------------------
// 群组管理中心 (Group Management)
// -------------------------------------------------------------

/**
 * 确保默认群组写入 managed_groups（幂等写入，补全缺失群号）
 */
export function initManagedGroups(defaultGroupIds = []) {
  if (Array.isArray(defaultGroupIds)) {
    const stmt = db.prepare("INSERT OR IGNORE INTO managed_groups (group_id, group_name, enabled, trigger_policy) VALUES (?, ?, 1, 'all')");
    for (const gid of defaultGroupIds) {
      if (gid) {
        stmt.run(Number(gid), `群聊 ${gid}`);
      }
    }
  }
}

/**
 * 获取所有被管理的群组列表，含发言量与最后活跃时间
 */
export function getManagedGroups() {
  const rows = db.prepare(`
    SELECT g.group_id, g.group_name, g.enabled, g.trigger_policy, g.created_at, g.updated_at,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.session_key = 'group:' || g.group_id) as message_count,
           (SELECT MAX(created_at) FROM chat_messages m WHERE m.session_key = 'group:' || g.group_id) as last_active
    FROM managed_groups g
    ORDER BY g.group_id ASC
  `).all();
  return rows.map(r => ({
    ...r,
    enabled: Boolean(r.enabled)
  }));
}

/**
 * 获取指定群组配置
 */
export function getManagedGroup(groupId) {
  const row = db.prepare("SELECT group_id, group_name, enabled, trigger_policy FROM managed_groups WHERE group_id = ?").get(Number(groupId));
  if (!row) return null;
  return { ...row, enabled: Boolean(row.enabled) };
}

/**
 * 保存或更新群组配置
 */
export function saveManagedGroup(groupId, groupName = "", enabled = true, triggerPolicy = "all") {
  const gid = Number(groupId);
  const existing = getManagedGroup(gid);
  const name = String((groupName !== undefined && groupName !== "") ? groupName : (existing?.group_name || `群聊 ${gid}`));
  const en = enabled ? 1 : 0;
  const policy = triggerPolicy === "strict" ? "strict" : "all";

  const stmt = db.prepare(`
    INSERT INTO managed_groups (group_id, group_name, enabled, trigger_policy, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = excluded.group_name,
      enabled = excluded.enabled,
      trigger_policy = excluded.trigger_policy,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(gid, name, en, policy);
  return getManagedGroup(gid);
}

/**
 * 删除群组白名单
 */
export function deleteManagedGroup(groupId) {
  db.prepare("DELETE FROM managed_groups WHERE group_id = ?").run(Number(groupId));
  return true;
}

/**
 * 单独切换群响应开关
 */
export function toggleGroupEnabled(groupId, enabled) {
  const en = enabled ? 1 : 0;
  db.prepare("UPDATE managed_groups SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE group_id = ?").run(en, Number(groupId));
  return getManagedGroup(groupId);
}

// -------------------------------------------------------------
// Token 消耗与用量监测 (Token Monitoring)
// -------------------------------------------------------------

/**
 * 轻量化中英文双语 Token 估算器（校准现代 LLM 的 Byte-level BPE：汉字 ~1.65，英文单词 ~1.3，符号 ~0.5）
 */
export function estimateTokens(text = "") {
  if (!text) return 0;
  const str = String(text);
  const cjkChars = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const nonCjkText = str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, " ");
  const words = (nonCjkText.match(/[a-zA-Z0-9]+/g) || []).length;
  const symbols = (nonCjkText.match(/[^a-zA-Z0-9\s]/g) || []).length;
  return Math.ceil(cjkChars * 1.65 + words * 1.3 + symbols * 0.5);
}

let defaultPricingConfig = null;
function getGlobalPricingConfig() {
  if (defaultPricingConfig !== null) return defaultPricingConfig;
  try {
    const cfgPath = path.resolve(PROJECT_ROOT, "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      defaultPricingConfig = cfg.pricing || {};
      return defaultPricingConfig;
    }
  } catch {}
  defaultPricingConfig = {};
  return defaultPricingConfig;
}

/**
 * 记录单次交互的 Token 与字符消耗（支持前缀 KV Cache 命中率分析与思考/速率/成本增强）
 */
export function recordTokenUsage({
  sessionKey = "",
  groupId = 0,
  persona = "tomoko",
  promptText = "",
  replyText = "",
  promptChars = 0,
  replyChars = 0,
  estimatedPromptTokens = 0,
  estimatedReplyTokens = 0,
  reasoningTokens = 0,
  durationMs = 0,
  throughputTps = null,
  costCny = null,
  costUsd = null,
  modelName = "",
  cachedTokens = null,
  newTokens = null,
  cacheHitRate = null,
  customPricing = null
}) {
  let rReasoning = Math.max(0, parseInt(reasoningTokens, 10) || 0);

  // 若未传入 reasoningTokens，自动从 replyText 中提取 <think> / <thought> / <thinking> 深度思考内容
  const hasThinkingTags = Boolean(replyText && /<(?:think|thought|thinking)>[\s\S]*?(?:<\/(?:think|thought|thinking)>|$)/i.test(replyText));
  if (!rReasoning && hasThinkingTags) {
    const thinkMatches = [
      ...replyText.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi),
      ...replyText.matchAll(/<thought>([\s\S]*?)(?:<\/thought>|$)/gi),
      ...replyText.matchAll(/<thinking>([\s\S]*?)(?:<\/thinking>|$)/gi)
    ];
    if (thinkMatches.length > 0) {
      const reasoningContent = thinkMatches.map(m => m[1] || "").join("\n");
      rReasoning = estimateTokens(reasoningContent);
    }
  }

  const pChars = promptChars || (promptText ? promptText.length : 0);
  const rChars = replyChars || (replyText ? replyText.length : 0);
  const pTokens = estimatedPromptTokens || estimateTokens(promptText);

  // 对齐规范：estimated_reply_tokens 代表模型总输出 Token (可见回复 + 思考推理 Token)
  let rTokens = estimatedReplyTokens;
  if (!rTokens) {
    const baseTokens = estimateTokens(replyText);
    if (rReasoning > 0 && !hasThinkingTags) {
      rTokens = baseTokens + rReasoning;
    } else {
      rTokens = baseTokens;
    }
  }
  const totalTokens = pTokens + rTokens;

  let gid = groupId;
  if (!gid && sessionKey.startsWith("group:")) {
    gid = Number(sessionKey.replace("group:", "")) || 0;
  }

  let calculatedCachedTokens = cachedTokens;
  let calculatedNewTokens = newTokens;

  if (calculatedCachedTokens === null || calculatedCachedTokens === undefined) {
    if (promptText && promptText.length > 0) {
      // 前缀缓存模型：系统提示词/人设卡与历史滚动上下文可被 KV Cache 命中复用
      // 检测结构化切分点（最新发言之前的系统规范、时空背景与历史皆为前缀缓存）
      const splitRegex = /(?:^|\n)(?:来自)?群友[(（:：]|(?:^|\n)【定时看群感知】|(?:^|\n)User:/i;
      const match = promptText.match(splitRegex);
      if (match && match.index > 0) {
        const prefixText = promptText.slice(0, match.index);
        calculatedCachedTokens = estimateTokens(prefixText);
      } else if (match && match.index === 0) {
        calculatedCachedTokens = 0;
      } else if (pTokens > 15) {
        // 若无显式标签切分，常规对话中前缀人设与历史约占 prompt 的 65%~75%
        calculatedCachedTokens = Math.floor(pTokens * 0.7);
      } else {
        // 短句或极简测试输入
        calculatedCachedTokens = Math.floor(pTokens * 0.5);
      }
    } else {
      calculatedCachedTokens = 0;
    }
  }

  // 保证 cachedTokens 介于 0 到 pTokens 之间
  calculatedCachedTokens = Math.min(pTokens, Math.max(0, calculatedCachedTokens));
  if (calculatedNewTokens === null || calculatedNewTokens === undefined) {
    calculatedNewTokens = (pTokens - calculatedCachedTokens) + rTokens;
  }

  const finalHitRate = (cacheHitRate !== null && cacheHitRate !== undefined)
    ? Number(cacheHitRate)
    : (pTokens > 0 ? Number((calculatedCachedTokens / pTokens).toFixed(4)) : 0.0);

  const dMs = Math.max(0, parseInt(durationMs, 10) || 0);
  const tps = (throughputTps !== null && throughputTps !== undefined)
    ? Number(throughputTps)
    : (dMs > 0 ? Number((rTokens / (dMs / 1000)).toFixed(1)) : 0.0);

  let cCny = costCny !== null && costCny !== undefined ? Number(costCny) : null;
  let cUsd = costUsd !== null && costUsd !== undefined ? Number(costUsd) : null;
  let mName = modelName ? String(modelName).trim() : "";

  const effectivePricing = customPricing || getGlobalPricingConfig();
  const costObj = calculateTokenCost({
    modelName: mName || "gemini-2.5-pro",
    promptTokens: pTokens,
    replyTokens: rTokens,
    cachedTokens: calculatedCachedTokens,
    customPricing: effectivePricing
  });
  if (cCny === null) cCny = costObj.costCny;
  if (cUsd === null) cUsd = costObj.costUsd;
  mName = costObj.modelName;

  const stmt = db.prepare(`
    INSERT INTO token_usage (
      session_key, group_id, persona,
      prompt_chars, reply_chars,
      estimated_prompt_tokens, estimated_reply_tokens,
      reasoning_tokens, duration_ms, throughput_tps,
      cost_cny, cost_usd, model_name,
      cached_tokens, new_tokens, cache_hit_rate,
      total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    sessionKey, gid, persona,
    pChars, rChars,
    pTokens, rTokens,
    rReasoning, dMs, tps,
    cCny, cUsd, mName,
    calculatedCachedTokens, calculatedNewTokens, finalHitRate,
    totalTokens
  );

  return {
    sessionKey,
    groupId: gid,
    persona,
    promptChars: pChars,
    replyChars: rChars,
    promptTokens: pTokens,
    replyTokens: rTokens,
    reasoningTokens: rReasoning,
    durationMs: dMs,
    throughputTps: tps,
    costCny: cCny,
    costUsd: cUsd,
    modelName: mName,
    cachedTokens: calculatedCachedTokens,
    newTokens: calculatedNewTokens,
    cacheHitRate: finalHitRate,
    totalTokens
  };
}

/**
 * 获取 Token 监测统计汇总（支持按天数、群组、人设聚合筛选，包含缓存命中率、推理Token、吞吐与成本估算）
 */
export function getTokenUsageStats({ days = 7, groupId = null, persona = null } = {}) {
  const daysNum = Math.max(1, parseInt(days, 10) || 7);
  const sinceClause = `datetime('now', '-${daysNum} days')`;

  const whereClauses = [`created_at >= ${sinceClause}`];
  const params = [];
  if (groupId) {
    whereClauses.push("group_id = ?");
    params.push(Number(groupId));
  }
  if (persona) {
    whereClauses.push("persona = ?");
    params.push(persona);
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const summaryRow = db.prepare(`
    SELECT 
      COUNT(*) as total_turns,
      COALESCE(SUM(prompt_chars), 0) as total_prompt_chars,
      COALESCE(SUM(reply_chars), 0) as total_reply_chars,
      COALESCE(SUM(estimated_prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(estimated_reply_tokens), 0) as total_reply_tokens,
      COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
      COALESCE(SUM(duration_ms), 0) as total_duration_ms,
      ROUND(COALESCE(AVG(CASE WHEN throughput_tps > 0 THEN throughput_tps END), 0.0), 1) as avg_throughput_tps,
      ROUND(COALESCE(SUM(cost_cny), 0.0), 4) as total_cost_cny,
      ROUND(COALESCE(SUM(cost_usd), 0.0), 4) as total_cost_usd,
      COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
      COALESCE(SUM(new_tokens), 0) as total_new_tokens,
      COALESCE(AVG(cache_hit_rate), 0.0) as avg_cache_hit_rate,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM token_usage
    ${whereSql}
  `).get(...params) || {
    total_turns: 0,
    total_prompt_chars: 0,
    total_reply_chars: 0,
    total_prompt_tokens: 0,
    total_reply_tokens: 0,
    total_reasoning_tokens: 0,
    total_duration_ms: 0,
    avg_throughput_tps: 0.0,
    total_cost_cny: 0.0,
    total_cost_usd: 0.0,
    total_cached_tokens: 0,
    total_new_tokens: 0,
    avg_cache_hit_rate: 0.0,
    total_tokens: 0
  };

  const totalPromptTokens = summaryRow.total_prompt_tokens || 0;
  const totalCachedTokens = summaryRow.total_cached_tokens || 0;
  const overallHitRate = totalPromptTokens > 0
    ? Number((totalCachedTokens / totalPromptTokens).toFixed(4))
    : Number((summaryRow.avg_cache_hit_rate || 0).toFixed(4));

  const summary = {
    ...summaryRow,
    total_cached_tokens: totalCachedTokens,
    total_cached_saved: totalCachedTokens, // 上下文缓存节省量
    avg_cache_hit_rate: overallHitRate,
    avg_cache_hit_percent: Number((overallHitRate * 100).toFixed(1))
  };

  const trend = db.prepare(`
    SELECT 
      strftime('%Y-%m-%d', created_at) as date,
      COUNT(*) as turns,
      SUM(total_tokens) as tokens,
      SUM(estimated_prompt_tokens) as prompt_tokens,
      SUM(estimated_reply_tokens) as reply_tokens,
      COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
      ROUND(COALESCE(AVG(CASE WHEN throughput_tps > 0 THEN throughput_tps END), 0.0), 1) as avg_throughput_tps,
      ROUND(COALESCE(SUM(cost_cny), 0.0), 4) as cost_cny,
      ROUND(COALESCE(SUM(cost_usd), 0.0), 4) as cost_usd,
      COALESCE(SUM(cached_tokens), 0) as cached_tokens,
      COALESCE(SUM(new_tokens), 0) as new_tokens,
      ROUND(AVG(cache_hit_rate), 4) as avg_hit_rate
    FROM token_usage
    ${whereSql}
    GROUP BY strftime('%Y-%m-%d', created_at)
    ORDER BY date ASC
  `).all(...params);

  const byGroup = db.prepare(`
    SELECT 
      group_id,
      COUNT(*) as turns,
      SUM(total_tokens) as tokens,
      COALESCE(SUM(cached_tokens), 0) as cached_tokens
    FROM token_usage
    ${whereSql}
    GROUP BY group_id
    ORDER BY tokens DESC
  `).all(...params);

  const byPersona = db.prepare(`
    SELECT 
      persona,
      COUNT(*) as turns,
      SUM(total_tokens) as tokens,
      COALESCE(SUM(cached_tokens), 0) as cached_tokens
    FROM token_usage
    ${whereSql}
    GROUP BY persona
    ORDER BY tokens DESC
  `).all(...params);

  const peakHours = db.prepare(`
    SELECT 
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      COUNT(*) as turns,
      SUM(total_tokens) as tokens
    FROM token_usage
    ${whereSql}
    GROUP BY strftime('%H', created_at)
    ORDER BY hour ASC
  `).all(...params);

  return {
    summary,
    trend,
    byGroup,
    byPersona,
    peakHours
  };
}

/**
 * 获取最近 Token 流水记录（包含缓存、思考Token、吞吐与成本）
 */
export function getRecentTokenLogs(limit = 50) {
  return db.prepare(`
    SELECT id, session_key, group_id, persona, prompt_chars, reply_chars,
           estimated_prompt_tokens, estimated_reply_tokens,
           reasoning_tokens, duration_ms, throughput_tps,
           cost_cny, cost_usd, model_name,
           cached_tokens, new_tokens, cache_hit_rate,
           total_tokens, created_at
    FROM token_usage
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}


// -------------------------------------------------------------
// 好感度与记忆资产库 (Affinity & Memory Vault)
// -------------------------------------------------------------

/**
 * 获取所有用户好感度排行榜（带搜索与排序，附加最新昵称与头像关联）
 */
export function getAllUserAffinities(limit = 100, offset = 0, search = "", sortBy = "points_desc") {
  const whereParts = [];
  const params = [];
  if (search && search.trim()) {
    whereParts.push("(a.user_id LIKE ? OR a.level_name LIKE ? OR a.last_reason LIKE ?)");
    const s = `%${search.trim()}%`;
    params.push(s, s, s);
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let order = "a.affinity_points DESC, a.last_interact DESC";
  if (sortBy === "points_asc") order = "a.affinity_points ASC";
  if (sortBy === "interact_desc") order = "a.last_interact DESC";

  const rows = db.prepare(`
    SELECT a.user_id, a.affinity_points, a.level_name, a.last_reason, a.last_interact,
           (SELECT m.sender_name FROM chat_messages m WHERE m.sender_id = a.user_id AND m.sender_name NOT LIKE '%undefined%' ORDER BY m.id DESC LIMIT 1) as sender_name
    FROM user_affinity a
    ${whereSql}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const countRow = db.prepare(`SELECT COUNT(*) as count FROM user_affinity a ${whereSql}`).get(...params);

  return { rows, total: countRow?.count || 0 };
}

/**
 * 管理员直接设置用户好感度
 */
export function setUserAffinity(userId, points, reason = "") {
  const pts = Math.max(-100, Math.min(100, Number(points) || 0));
  const levelName = getAffinityLevelName(pts);
  const effReason = reason && reason.trim() ? reason.trim() : "管理员手动调整";

  db.prepare(`
    INSERT INTO user_affinity (user_id, affinity_points, level_name, last_reason, last_interact)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      affinity_points = excluded.affinity_points,
      level_name = excluded.level_name,
      last_reason = excluded.last_reason,
      last_interact = CURRENT_TIMESTAMP
  `).run(Number(userId), pts, levelName, effReason);

  return getUserAffinity(Number(userId));
}

/**
 * 删除用户好感度记录
 */
export function deleteUserAffinity(userId) {
  db.prepare("DELETE FROM user_affinity WHERE user_id = ?").run(Number(userId));
  return true;
}

/**
 * 清理测试用垃圾好感度记录（保留在群聊有真实发言的群友以及配置的管理员）
 */
export function cleanTestAffinities(adminQqIds = []) {
  // 找出所有在真实受管群聊 chat_messages 中有发言记录的真实有效 QQ 用户，以及配置中的管理员 QQ
  const chatUsers = db.prepare("SELECT DISTINCT sender_id FROM chat_messages WHERE sender_id > 10000").all().map(r => r.sender_id);
  const keepSet = new Set([...chatUsers, ...adminQqIds.map(Number)]);

  const allRows = db.prepare("SELECT user_id FROM user_affinity").all();
  let deletedCount = 0;
  const deleteStmt = db.prepare("DELETE FROM user_affinity WHERE user_id = ?");

  for (const row of allRows) {
    const uid = Number(row.user_id);
    // 垃圾测试 ID (包括小于 10000 的数字、已知假数据 10001/99887766/120129 等，或者不在发言与管理员白名单的用户)
    const isTestDummy = uid < 10000 || [10001, 99887766, 120129].includes(uid);
    if (isTestDummy || !keepSet.has(uid)) {
      deleteStmt.run(uid);
      deletedCount++;
    }
  }

  // 同时也清除 chat_messages 中测试遗留的假会话与测试短句
  try {
    db.prepare("DELETE FROM chat_messages WHERE session_key LIKE 'group:test_%' OR session_key LIKE 'test:%' OR session_key = 'group:123' OR sender_id < 10000").run();
  } catch {}

  return {
    deletedCount,
    remaining: db.prepare("SELECT COUNT(*) as count FROM user_affinity").get()?.count || 0
  };
}

/**
 * 清空所有用户好感度档案（谨慎操作）
 */
export function clearAllAffinities() {
  db.prepare("DELETE FROM user_affinity").run();
  return true;
}


/**
 * 获取所有会话长期记忆快照
 */
export function getAllSessionMemories() {
  return db.prepare("SELECT session_key, memory_text, updated_at FROM session_memories ORDER BY updated_at DESC").all();
}

/**
 * 删除指定会话的长期记忆
 */
export function deleteSessionMemory(sessionKey) {
  db.prepare("DELETE FROM session_memories WHERE session_key = ?").run(sessionKey);
  return true;
}

/**
 * 获取黑话词典列表
 */
export function getAllSlangs(search = "") {
  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    return db.prepare("SELECT id, word, meaning, count, updated_at FROM slangs WHERE word LIKE ? OR meaning LIKE ? ORDER BY count DESC").all(s, s);
  }
  return db.prepare("SELECT id, word, meaning, count, updated_at FROM slangs ORDER BY count DESC").all();
}

/**
 * 创建新黑话
 */
export function createSlang(word, meaning = "") {
  if (!word || !word.trim()) return null;
  const stmt = db.prepare(`
    INSERT INTO slangs (word, meaning, count, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(word) DO UPDATE SET
      count = count + 1,
      meaning = CASE WHEN excluded.meaning != '' THEN excluded.meaning ELSE slangs.meaning END,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, word, meaning, count, updated_at
  `);
  return stmt.get(word.trim(), meaning.trim());
}

/**
 * 更新黑话
 */
export function updateSlang(id, word, meaning, count) {
  db.prepare(`
    UPDATE slangs 
    SET word = ?, meaning = ?, count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(word.trim(), (meaning || "").trim(), Number(count) || 1, Number(id));
  return db.prepare("SELECT id, word, meaning, count, updated_at FROM slangs WHERE id = ?").get(Number(id));
}

/**
 * 删除黑话
 */
export function deleteSlang(id) {
  db.prepare("DELETE FROM slangs WHERE id = ?").run(Number(id));
  return true;
}

// -------------------------------------------------------------
// 实时消息与对话胶卷
// -------------------------------------------------------------

/**
 * 获取最近消息流水（标准化字段命名，兼容 camelCase 与 snake_case，防止 undefined）
 */
export function getRecentChatMessages(limit = 100, sessionKey = null) {
  let rawRows;
  if (sessionKey) {
    const key = String(sessionKey).trim();
    const altKey = key.startsWith("group:") ? key.slice(6) : `group:${key}`;
    rawRows = db.prepare(`
      SELECT id, session_key, sender_id, sender_name, message_text, images, is_bot, created_at
      FROM chat_messages
      WHERE session_key = ? OR session_key = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(key, altKey, limit);
  } else {
    rawRows = db.prepare(`
      SELECT id, session_key, sender_id, sender_name, message_text, images, is_bot, created_at
      FROM chat_messages
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  }

  return rawRows.reverse().map(r => {
    let cleanSenderName = r.sender_name || (r.is_bot ? "Bot" : `群友(${r.sender_id || ""})`);
    if (cleanSenderName.includes("undefined")) {
      cleanSenderName = r.sender_id ? `群友(${r.sender_id})` : "群友";
    }
    let parsedImages = [];
    try {
      if (r.images) {
        parsedImages = typeof r.images === "string" ? JSON.parse(r.images) : r.images;
      }
    } catch {}

    const cleanSenderId = (r.sender_id && String(r.sender_id) !== "undefined" && String(r.sender_id) !== "null") ? Number(r.sender_id) : 0;

    return {
      id: r.id,
      session_key: r.session_key,
      sessionKey: r.session_key,
      sender_id: cleanSenderId,
      senderId: cleanSenderId,
      sender_name: cleanSenderName,
      senderName: cleanSenderName,
      message_text: r.message_text,
      text: r.message_text,
      message: r.message_text,
      images: Array.isArray(parsedImages) ? parsedImages : [],
      is_bot: r.is_bot,
      isBot: Boolean(r.is_bot),
      created_at: r.created_at,
      time: r.created_at
    };
  });
}


/**
 * 清除指定会话或全部历史
 */
export function clearChatMessages(sessionKey = null) {
  if (sessionKey) {
    db.prepare("DELETE FROM chat_messages WHERE session_key = ?").run(sessionKey);
  } else {
    db.prepare("DELETE FROM chat_messages").run();
  }
  return true;
}
