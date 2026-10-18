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

export let db = null;
let currentDbPath = null;
export let fts5Supported = true;

export function getDatabasePath() {
  return currentDbPath || process.env.SQLITE_PATH || path.join(DATA_DIR, "state.db");
}

/**
 * 遇到并发写锁 (SQLITE_BUSY / database is locked) 时自动重试，提升多进程与高并发稳定性
 */
export function runWithRetry(fn, retries = 10, delayMs = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      return fn();
    } catch (err) {
      if (err.message && (err.message.includes("locked") || err.message.includes("busy")) && i < retries - 1) {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * (i + 1));
        } catch {}
        continue;
      }
      throw err;
    }
  }
}

/**
 * 触发 SQLite WAL Checkpoint (TRUNCATE)，将 WAL 日志写回主库并截断 WAL 文件，消除文件膨胀
 */
export function checkpointDatabase(mode = "TRUNCATE") {
  if (!db) return null;
  try {
    return runWithRetry(() => {
      const validModes = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"];
      const targetMode = validModes.includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : "TRUNCATE";
      const row = db.prepare(`PRAGMA wal_checkpoint(${targetMode});`).get();
      return row || { busy: 0, log: 0, checkpointed: 0 };
    });
  } catch (err) {
    console.warn(`[SQLite Checkpoint] 执行 PRAGMA wal_checkpoint(${mode}) 异常:`, err.message);
    return null;
  }
}

/**
 * 执行数据库建表与平滑升级迁移
 */
export function runSchemaMigrations(targetDb) {
  if (!targetDb) return;

  targetDb.exec(`
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

    -- 群组管理表（白名单、别名、独立启闭、触发策略、平台类型）
    CREATE TABLE IF NOT EXISTS managed_groups (
      group_id INTEGER PRIMARY KEY,
      group_name TEXT NOT NULL DEFAULT '',
      enabled INTEGER DEFAULT 1,
      trigger_policy TEXT DEFAULT 'all', -- 'all' (允许自主插嘴) 或 'strict' (仅@或点名/直问)
      platform TEXT DEFAULT 'qq',        -- 'qq' 或 'wechat'
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

  // 优雅平滑升级：补充字段
  try {
    targetDb.exec("ALTER TABLE character_state ADD COLUMN persona TEXT DEFAULT 'tomoko';");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE chat_messages ADD COLUMN images TEXT DEFAULT '[]';");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER DEFAULT 0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN new_tokens INTEGER DEFAULT 0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN cache_hit_rate REAL DEFAULT 0.0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN reasoning_tokens INTEGER DEFAULT 0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN duration_ms INTEGER DEFAULT 0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN throughput_tps REAL DEFAULT 0.0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN cost_cny REAL DEFAULT 0.0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN cost_usd REAL DEFAULT 0.0;");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN model_name TEXT DEFAULT '';");
  } catch {}
  try {
    targetDb.exec("ALTER TABLE token_usage ADD COLUMN client TEXT DEFAULT 'antigravity';");
  } catch {}

  // 初始化各已知人设的专属时空状态基准
  for (const [key, p] of Object.entries(PERSONAS)) {
    targetDb.prepare(`
      INSERT OR IGNORE INTO persona_states (persona, location, action, detail, mood)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, p.defaultLocation, p.defaultAction, p.defaultDetail || "现场平稳", p.defaultMood || "自然");
  }

  // 确保初始行存在
  targetDb.exec(`
    INSERT OR IGNORE INTO character_state (id, persona, location, action, detail, mood) 
    VALUES (1, 'tomoko', '海外家中二楼房间', '坐在地毯上抱着 Switch 玩单机，手边放着麦茶', '房间里只有游戏手柄按键的声音和屏幕光影', '放松、专注');
  `);

  // Tulpa 情境记忆表与本地纯算法群聊黑话词频表
  try {
    targetDb.exec(`
      CREATE TABLE IF NOT EXISTS tulpa_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT DEFAULT '',
        user_message TEXT NOT NULL,
        reply_message TEXT DEFAULT '',
        context_summary TEXT DEFAULT '',
        keywords TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_tulpa_episodes_session ON tulpa_episodes (session_key, id DESC);
      CREATE INDEX IF NOT EXISTS idx_tulpa_episodes_user ON tulpa_episodes (user_id, id DESC);

      CREATE TABLE IF NOT EXISTS group_slangs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL DEFAULT 0,
        term TEXT NOT NULL,
        frequency INTEGER DEFAULT 1,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, term)
      );
      CREATE INDEX IF NOT EXISTS idx_group_slangs_freq ON group_slangs (group_id, frequency DESC);
    `);

    try {
      targetDb.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tulpa_episodes_fts USING fts5(
          user_message,
          reply_message,
          keywords,
          content='tulpa_episodes',
          content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS trg_tulpa_episodes_ai AFTER INSERT ON tulpa_episodes BEGIN
          INSERT INTO tulpa_episodes_fts(rowid, user_message, reply_message, keywords)
          VALUES (new.id, new.user_message, new.reply_message, new.keywords);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tulpa_episodes_ad AFTER DELETE ON tulpa_episodes BEGIN
          INSERT INTO tulpa_episodes_fts(tulpa_episodes_fts, rowid, user_message, reply_message, keywords)
          VALUES ('delete', old.id, old.user_message, old.reply_message, old.keywords);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tulpa_episodes_au AFTER UPDATE ON tulpa_episodes BEGIN
          INSERT INTO tulpa_episodes_fts(tulpa_episodes_fts, rowid, user_message, reply_message, keywords)
          VALUES ('delete', old.id, old.user_message, old.reply_message, old.keywords);
          INSERT INTO tulpa_episodes_fts(rowid, user_message, reply_message, keywords)
          VALUES (new.id, new.user_message, new.reply_message, new.keywords);
        END;
      `);
      fts5Supported = true;
    } catch (ftsErr) {
      fts5Supported = false;
    }
    // 微信支持架构迁移：为 managed_groups 增设 platform 字段
    try {
      const groupColumns = targetDb.prepare("PRAGMA table_info(managed_groups)").all();
      if (groupColumns && !groupColumns.some(col => col.name === "platform")) {
        targetDb.exec("ALTER TABLE managed_groups ADD COLUMN platform TEXT DEFAULT 'qq'");
      }
      // 纠正已有记录：微信频段严格限定在 990000~999999 虚拟频段（或群名带微信），其余均归属 QQ 平台
      targetDb.exec("UPDATE managed_groups SET platform = 'qq' WHERE group_id NOT BETWEEN 990000 AND 999999");
      targetDb.exec("UPDATE managed_groups SET platform = 'wechat' WHERE (group_id BETWEEN 990000 AND 999999) OR group_name LIKE '微信%'");
    } catch {}
  } catch (err) {
    console.warn("[SQLite] tulpa_episodes / group_slangs 迁移异常:", err.message);
  }
}

/**
 * 显式初始化数据库连接与架构迁移
 * 支持自定义数据库路径（或 SQLITE_PATH 环境变量），保持向后无感兼容
 */
export function initDatabase(dbPathOrInstance = null) {
  if (db && typeof db.close === "function" && db !== dbPathOrInstance) {
    try {
      db.close();
    } catch {}
  }

  if (dbPathOrInstance && typeof dbPathOrInstance === "object" && typeof dbPathOrInstance.prepare === "function") {
    db = dbPathOrInstance;
    currentDbPath = ":memory:";
  } else if (typeof dbPathOrInstance === "string") {
    currentDbPath = dbPathOrInstance;
    if (currentDbPath !== ":memory:") {
      const parentDir = path.dirname(currentDbPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }
    db = new DatabaseSync(currentDbPath);
  } else {
    currentDbPath = process.env.SQLITE_PATH || path.join(DATA_DIR, "state.db");
    const parentDir = path.dirname(currentDbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    db = new DatabaseSync(currentDbPath);
  }

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  runSchemaMigrations(db);
  return db;
}

// 模块加载默认自动初始化主库，保障完全向后兼容
initDatabase();

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
  if (typeof points !== "number" || !Number.isFinite(points)) return "初识";
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
  const uid = Number(userId);
  if (!uid || uid <= 0) {
    return { user_id: 0, affinity_points: 30, level_name: "初识", last_reason: "初始结识" };
  }
  return runWithRetry(() => {
    const query = db.prepare("SELECT user_id, affinity_points, level_name, last_reason FROM user_affinity WHERE user_id = ?");
    let row = query.get(uid);
    if (!row) {
      try {
        db.prepare("INSERT OR IGNORE INTO user_affinity (user_id, affinity_points, level_name, last_reason) VALUES (?, 30, '初识', '初始结识')").run(uid);
      } catch {}
      row = query.get(uid) || { user_id: uid, affinity_points: 30, level_name: "初识", last_reason: "初始结识" };
    }
    return row;
  });
}

/**
 * 好感度系统：根据 [af:±x|理由] 动态加减分
 * 铁律：单次变动严格限制在 [-2, +2]（可通过 options.clamp = false 显式旁路）
 */
export function modifyUserAffinity(userId, delta, reason = "", options = {}) {
  const uid = Number(userId);
  if (!uid || uid <= 0) {
    return { newPoints: 30, newLevel: "初识", reason: "系统/巡逻保护", clampedDelta: 0 };
  }
  return runWithRetry(() => {
    let rawDelta = typeof delta === "number" ? delta : (parseInt(delta, 10) || 0);
    if (!Number.isFinite(rawDelta)) {
      rawDelta = 0;
    }
    rawDelta = Math.round(rawDelta);
    const shouldClamp = typeof options === "boolean" ? options : (options?.clamp !== false);
    const effectiveDelta = shouldClamp ? Math.max(-2, Math.min(2, rawDelta)) : rawDelta;
    const current = getUserAffinity(uid);
    let currentPoints = current.affinity_points;
    if (typeof currentPoints !== "number" || !Number.isFinite(currentPoints)) {
      currentPoints = 30;
    }
    let newPoints = currentPoints + effectiveDelta;
    // 范围约束在 -100 ~ 100
    if (newPoints > 100) newPoints = 100;
    if (newPoints < -100) newPoints = -100;
    newPoints = Math.round(newPoints);

    const newLevel = getAffinityLevelName(newPoints);
    const effectiveReason = (reason && reason.trim()) ? reason.trim() : (current.last_reason || "互动更新");

    const stmt = db.prepare(`
      UPDATE user_affinity 
      SET affinity_points = ?, level_name = ?, last_reason = ?, last_interact = CURRENT_TIMESTAMP 
      WHERE user_id = ?
    `);
    stmt.run(newPoints, newLevel, effectiveReason, uid);
    return { newPoints, newLevel, reason: effectiveReason, clampedDelta: effectiveDelta };
  });
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

const messageInsertCounters = new Map();
const MESSAGE_TRIM_BATCH_SIZE = 40;

export function resetMessageInsertCounters() {
  messageInsertCounters.clear();
}

export function getMessageInsertCount(sessionKey) {
  return messageInsertCounters.get(sessionKey) || 0;
}

/**
 * 维持单群最多 keepLimit (默认 200) 条历史消息，批量修剪旧消息以消除写放大
 */
export function trimChatMessages(sessionKey = null, keepLimit = 200) {
  if (!db) return 0;
  try {
    return runWithRetry(() => {
      const limit = Math.max(10, parseInt(keepLimit, 10) || 200);
      if (sessionKey) {
        const stmt = db.prepare(`
          DELETE FROM chat_messages 
          WHERE session_key = ? AND id NOT IN (
            SELECT id FROM chat_messages WHERE session_key = ? ORDER BY id DESC LIMIT ?
          )
        `);
        const res = stmt.run(sessionKey, sessionKey, limit);
        return res?.changes || 0;
      } else {
        const sessions = db.prepare("SELECT DISTINCT session_key FROM chat_messages").all();
        let totalChanges = 0;
        const stmt = db.prepare(`
          DELETE FROM chat_messages 
          WHERE session_key = ? AND id NOT IN (
            SELECT id FROM chat_messages WHERE session_key = ? ORDER BY id DESC LIMIT ?
          )
        `);
        for (const row of sessions) {
          if (row.session_key) {
            totalChanges += (stmt.run(row.session_key, row.session_key, limit)?.changes || 0);
          }
        }
        return totalChanges;
      }
    });
  } catch (err) {
    console.warn("[SQLite Trim] chat_messages 修剪异常:", err.message);
    return 0;
  }
}

/**
 * 记录单条群消息（无论群友发言还是机器人回复）
 * 包含单条超长自动截断保护（防小作文刷屏烧额度）与空值防御
 * 核心优化：杜绝每条插入都执行子查询修剪，按批次阈值（每 40 条）节流修剪，彻底消除写放大
 */
export function recordChatMessage(sessionKey, senderId, senderName, text, isBot = false, botName = "智子", images = [], options = {}) {
  if (!text || !text.trim()) return null;
  // 单条文本安全截断上限为 150 字
  const safeText = text.trim().slice(0, 150);
  const cleanId = (senderId && String(senderId) !== "undefined" && String(senderId) !== "null") ? Number(senderId) : 0;
  const defaultSpeaker = isBot ? (botName || "Bot") : (cleanId ? `群友(${cleanId})` : "群友");
  let finalSpeaker = (senderName && String(senderName) !== "undefined" && String(senderName).trim()) ? String(senderName).trim() : defaultSpeaker;

  let effectiveImages = images;
  let effectiveOptions = options;
  if (images && !Array.isArray(images) && typeof images === "object") {
    effectiveOptions = images;
    effectiveImages = [];
  }
  const imagesJson = Array.isArray(effectiveImages) && effectiveImages.length ? JSON.stringify(effectiveImages) : "[]";

  return runWithRetry(() => {
    const stmt = db.prepare(`
      INSERT INTO chat_messages (session_key, sender_id, sender_name, message_text, is_bot, images)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(sessionKey, cleanId, finalSpeaker, safeText, isBot ? 1 : 0, imagesJson);

    // 节流批量修剪：单群历史保持在约 200 条，每 40 次写入触发一次修剪或显式 forceTrim
    const count = (messageInsertCounters.get(sessionKey) || 0) + 1;
    const forceTrim = Boolean(effectiveOptions?.forceTrim);
    if (forceTrim || count >= MESSAGE_TRIM_BATCH_SIZE) {
      messageInsertCounters.set(sessionKey, 0);
      trimChatMessages(sessionKey, 200);
    } else {
      messageInsertCounters.set(sessionKey, count);
    }

    return info?.lastInsertRowid || null;
  });
}

export function updateChatMessageImages(messageId, images = []) {
  if (!messageId) return;
  const imagesJson = Array.isArray(images) && images.length ? JSON.stringify(images) : "[]";
  db.prepare("UPDATE chat_messages SET images = ? WHERE id = ?").run(imagesJson, messageId);
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
 * 获取指定会话最新一条消息的自增 ID
 */
export function getLastChatMessageId(sessionKey) {
  if (!db || !sessionKey) return 0;
  try {
    const row = db.prepare("SELECT id FROM chat_messages WHERE session_key = ? ORDER BY id DESC LIMIT 1").get(sessionKey);
    return row?.id || 0;
  } catch {
    return 0;
  }
}

/**
 * 检查自指定消息 ID 之后，是否有真人（is_bot = 0）发送了新消息（打断检测）
 */
export function hasHumanInterrupted(sessionKey, sinceMessageId = 0) {
  if (!db || !sessionKey) return null;
  try {
    const row = db.prepare(`
      SELECT id, sender_id, sender_name, message_text 
      FROM chat_messages 
      WHERE session_key = ? AND id > ? AND is_bot = 0 
      ORDER BY id DESC 
      LIMIT 1
    `).get(sessionKey, sinceMessageId || 0);
    return row || null;
  } catch {
    return null;
  }
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
// 群聊流行黑话/网络用语纯算法词频统计 (Local Pure-Algorithm Slang Tracker)
// -------------------------------------------------------------

// 常用虚词/停用词表（避免把常见口语助词当成流行黑话）
const SLANG_STOPWORDS = new Set([
  "这个", "那个", "什么", "怎么", "为什么", "可以", "觉得", "一下", "不是", "就是",
  "还有", "现在", "知道", "这样", "那样", "因为", "所以", "如果", "虽然", "但是",
  "而且", "然后", "其实", "大家", "自己", "已经", "感觉", "可能", "应该", "真的",
  "好像", "看到", "听到", "出来", "进去", "起来", "过来", "过去", "没有", "我们",
  "你们", "他们", "这里", "那里", "哪里", "什么时候", "怎么会", "不知道", "好不好",
  "能不能", "是不是", "行不行", "有没有", "怎么说", "怎么样", "太好了", "今天", "明天",
  "昨天", "好的", "收到", "一直", "很多", "多少", "一起", "还是", "或者", "以及",
  "不要", "不行", "不会", "不能", "不可", "这么", "那么", "非常", "特别", "十分", "比较",
  "开始", "结束", "最后", "前面", "后面", "上面", "下面", "里面", "外面", "有人", "无人",
  "谢谢", "感谢", "辛苦", "麻烦", "再见", "拜拜", "早安", "晚安", "早上好", "晚上好",
  "我也", "也是", "都是", "大家都", "大家都很", "也是这么"
]);

const FUNCTIONAL_PARTICLES = new Set([
  "的", "了", "着", "呢", "吧", "啊", "呀", "吗", "嘛", "么", "啦", "哇", "哒", "捏", "嗷", "呗"
]);

/**
 * 本地纯算法 N-gram 与流行语提取引擎 (0 API 成本，0 LLM 消耗)
 */
export function extractCandidateNgrams(text) {
  if (!text || typeof text !== "string") return [];
  // 1. 清理 CQ 码、链接、HTML转义实体、@ 与控制字符
  const cleaned = text
    .replace(/\[CQ:[^\]]+\]/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/&(?:amp|quot|lt|gt|nbsp|#\d+);/gi, " ")
    .replace(/[@#][\w\u4e00-\u9fa5]+/g, " ")
    .trim();

  const candidates = new Set();

  // 2. 提取高频字母/数字网络缩写与专有名词 (如 Switch2, DLSS, yyds, nb, gg, kswl, awsl, op, cp, xswl, dddd)
  // 排除单纯的普通数字如 100, 5000（保留 666, 233, 2333 等典型梗数字）
  const alphaMatches = cleaned.match(/(?:[a-zA-Z][a-zA-Z0-9]{1,9}|666+|233+|886|555+|999+)/g);
  if (alphaMatches) {
    for (const m of alphaMatches) {
      const lower = m.toLowerCase();
      if (!/^(the|and|for|are|but|not|you|all|any|can|had|her|was|one|our|out|day|get|has|him|his|how|man|new|now|old|see|two|way|who|boy|did|its|let|put|say|she|too|use|amp|quot|null|true|false)$/i.test(lower)) {
        candidates.add(lower);
      }
    }
  }

  // 3. 提取连续汉字子串
  const cjkSegments = cleaned.match(/[\u4e00-\u9fa5]+/g);
  if (cjkSegments) {
    for (const seg of cjkSegments) {
      const len = seg.length;
      if (len < 2) continue;
      // 提取 2-gram, 3-gram, 4-gram
      for (let n = 2; n <= Math.min(4, len); n++) {
        for (let i = 0; i <= len - n; i++) {
          const gram = seg.slice(i, i + n);
          // 滤除虚词尾缀或首尾助词（例如 "的好"、"跃啊"、"里的" 等跨词截断杂质）
          if (FUNCTIONAL_PARTICLES.has(gram[0]) || FUNCTIONAL_PARTICLES.has(gram[gram.length - 1])) {
            continue;
          }
          if (!SLANG_STOPWORDS.has(gram)) {
            candidates.add(gram);
          }
        }
      }
    }
  }

  return Array.from(candidates);
}

/**
 * 记录群聊网络用语词频（本地纯算法 N-gram，0 Token 消耗）
 */
export function trackGroupSlangFrequency(groupId, text) {
  if (!db || !groupId || !text) return;
  const terms = extractCandidateNgrams(text);
  if (terms.length === 0) return;

  runWithRetry(() => {
    const stmt = db.prepare(`
      INSERT INTO group_slangs (group_id, term, frequency, last_seen)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(group_id, term) DO UPDATE SET
        frequency = frequency + 1,
        last_seen = CURRENT_TIMESTAMP
    `);
    for (const term of terms) {
      try {
        stmt.run(Number(groupId), term);
      } catch {}
    }
  });
}

/**
 * 查询指定群聊的 Top N 流行网络黑话（支持按最小频次筛选）
 */
export function getTopGroupSlangs(groupId, limit = 5, minFrequency = 1) {
  if (!db) return [];
  try {
    const minFreq = Math.max(1, parseInt(minFrequency, 10) || 1);
    const query = db.prepare(`
      SELECT term as word, frequency as count, last_seen 
      FROM group_slangs 
      WHERE group_id = ? AND frequency >= ?
      ORDER BY frequency DESC 
      LIMIT ?
    `);
    return query.all(Number(groupId), minFreq, limit);
  } catch {
    return [];
  }
}

// -------------------------------------------------------------
// Tulpa 情境记忆 (Episodic Memory / FTS5 BM25 检索)
// -------------------------------------------------------------

/**
 * 记录真实人类对话高光切片 (Tulpa Episodic Memory)
 */
export function recordTulpaEpisode({
  sessionKey = "",
  userId = 0,
  userName = "",
  userMessage = "",
  replyMessage = "",
  contextSummary = "",
  keywords = ""
}) {
  if (!db || !userMessage || !userMessage.trim()) return null;
  return runWithRetry(() => {
    let kw = keywords;
    if (!kw) {
      kw = extractCandidateNgrams(userMessage + " " + (replyMessage || "")).join(" ");
    }
    const stmt = db.prepare(`
      INSERT INTO tulpa_episodes (session_key, user_id, user_name, user_message, reply_message, context_summary, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      sessionKey,
      Number(userId) || 0,
      userName || "",
      userMessage.trim(),
      (replyMessage || "").trim(),
      (contextSummary || "").trim(),
      kw.trim()
    );
    return info.lastInsertRowid;
  });
}

/**
 * 更新指定会话最近一条对话切片的回复内容，并同步更新分词关键词
 */
export function updateLatestTulpaEpisodeReply(sessionKey, replyMessage) {
  if (!db || !sessionKey || !replyMessage) return false;
  try {
    return runWithRetry(() => {
      const row = db.prepare(`
        SELECT id, user_message FROM tulpa_episodes 
        WHERE session_key = ? 
        ORDER BY id DESC 
        LIMIT 1
      `).get(sessionKey);
      if (!row) return false;
      const cleanReply = replyMessage.trim();
      const kw = extractCandidateNgrams(row.user_message + " " + cleanReply).join(" ");
      db.prepare(`UPDATE tulpa_episodes SET reply_message = ?, keywords = ? WHERE id = ?`).run(cleanReply, kw, row.id);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * 基于 FTS5 BM25 全文检索匹配最相关的 1~2 个真实对话情境 (0 Token API 成本)
 * 支持 FTS5 异常时自动降级到 SQL LIKE 模糊匹配
 * 严格只返回已具备真实回复的完整对话样本，杜绝注入未完结空回复
 */
export function searchTulpaEpisodes(queryText, limit = 2) {
  if (!db || !queryText || !queryText.trim()) return [];
  const cleanQuery = queryText.trim();
  const safeLimit = Math.max(1, parseInt(limit, 10) || 2);

  // 提取查询关键词与 CJK N-grams / 字母专有名词
  const candidateTerms = extractCandidateNgrams(cleanQuery);
  const explicitTokens = cleanQuery
    .replace(/['"*\(\)\{\}\[\]\^\:\+\-\?！!，,。]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2);
  // 长度优先排序，取前 20 个最具辨识度的关键词
  const tokens = Array.from(new Set([...candidateTerms, ...explicitTokens]))
    .filter(t => t.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 20);

  // 1. 优先尝试 FTS5 全文搜索与 BM25 排序 (必须具备非空回复)
  if (fts5Supported && tokens.length > 0) {
    try {
      const matchExpr = tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
      const rows = db.prepare(`
        SELECT e.id, e.session_key, e.user_id, e.user_name, e.user_message, e.reply_message, e.context_summary, e.keywords, e.created_at, f.rank
        FROM tulpa_episodes e
        JOIN tulpa_episodes_fts f ON e.id = f.rowid
        WHERE tulpa_episodes_fts MATCH ?
          AND e.reply_message IS NOT NULL 
          AND e.reply_message != ''
        ORDER BY f.rank
        LIMIT ?
      `).all(matchExpr, safeLimit);

      if (rows && rows.length > 0) {
        return rows;
      }
    } catch (err) {
      // 若 FTS5 出错，降级走 LIKE
    }
  }

  // 2. 降级：使用标准 SQL LIKE 匹配 (必须具备非空回复)
  try {
    if (tokens.length > 0) {
      const whereClauses = tokens.map(() => `(user_message LIKE ? ESCAPE '\\' OR reply_message LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')`).join(" OR ");
      const params = [];
      for (const t of tokens) {
        const escaped = t.replace(/([%_\\])/g, "\\$1");
        const pattern = `%${escaped}%`;
        params.push(pattern, pattern, pattern);
      }
      params.push(safeLimit);

      const rows = db.prepare(`
        SELECT id, session_key, user_id, user_name, user_message, reply_message, context_summary, keywords, created_at
        FROM tulpa_episodes
        WHERE (${whereClauses})
          AND reply_message IS NOT NULL 
          AND reply_message != ''
        ORDER BY id DESC
        LIMIT ?
      `).all(...params);

      if (rows && rows.length > 0) {
        return rows;
      }
    }

    // 3. 兜底：返回最新 1~2 条真实已回复对话样本
    return db.prepare(`
      SELECT id, session_key, user_id, user_name, user_message, reply_message, context_summary, keywords, created_at
      FROM tulpa_episodes
      WHERE reply_message IS NOT NULL AND reply_message != ''
      ORDER BY id DESC
      LIMIT ?
    `).all(safeLimit);
  } catch (err) {
    return [];
  }
}

/**
 * 获取最近的 Tulpa 对话情境切片
 */
export function getRecentTulpaEpisodes(limit = 5) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT id, session_key, user_id, user_name, user_message, reply_message, context_summary, keywords, created_at
      FROM tulpa_episodes
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.max(1, parseInt(limit, 10) || 5));
  } catch {
    return [];
  }
}

// -------------------------------------------------------------
// 群组管理中心 (Group Management)
// -------------------------------------------------------------

/**
 * 确保默认群组写入 managed_groups（幂等写入，补全缺失群号与微信群）
 */
export function initManagedGroups(defaultGroupIds = []) {
  if (Array.isArray(defaultGroupIds)) {
    const stmt = db.prepare("INSERT OR IGNORE INTO managed_groups (group_id, group_name, enabled, trigger_policy, platform) VALUES (?, ?, 1, 'all', 'qq')");
    for (const gid of defaultGroupIds) {
      if (gid) {
        stmt.run(Number(gid), `群聊 ${gid}`);
      }
    }
  }
  // 确保默认微信白名单“道馆馆”存在于 managed_groups
  try {
    const wechatStmt = db.prepare("INSERT OR IGNORE INTO managed_groups (group_id, group_name, enabled, trigger_policy, platform) VALUES (?, ?, 1, 'all', 'wechat')");
    wechatStmt.run(999001, "道馆馆");
  } catch {}
}

/**
 * 动态为微信群计算或分配唯一的 99xxxx 虚拟群信道 ID
 */
export function allocateWechatGroupId(roomName) {
  const cleanName = String(roomName || "").trim();
  if (!cleanName) return 990001;

  // 1. 若已有该微信群，直接复用既有 ID
  const existing = db.prepare("SELECT group_id FROM managed_groups WHERE platform = 'wechat' AND group_name = ?").get(cleanName);
  if (existing) return existing.group_id;

  // 2. 尝试基于名称 Hash 生成 990000 ~ 998999
  let hash = 0;
  for (let i = 0; i < cleanName.length; i++) hash = (hash * 31 + cleanName.charCodeAt(i)) & 0x7fffffff;
  const candidate = 990000 + (hash % 9000);
  const conflict = db.prepare("SELECT group_id FROM managed_groups WHERE group_id = ?").get(candidate);
  if (!conflict) return candidate;

  // 3. 若冲突，自动取 990001 起的最大空闲 ID
  const row = db.prepare("SELECT MAX(group_id) as max_id FROM managed_groups WHERE group_id >= 990000 AND group_id < 999999").get();
  return (row && row.max_id) ? row.max_id + 1 : 990001;
}

/**
 * 获取所有被管理的群组列表，含平台类型、发言量与最后活跃时间
 */
export function getManagedGroups() {
  const rows = db.prepare(`
    SELECT g.group_id, g.group_name, g.enabled, g.trigger_policy, g.platform, g.created_at, g.updated_at,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.session_key = 'group:' || g.group_id) as message_count,
           (SELECT MAX(created_at) FROM chat_messages m WHERE m.session_key = 'group:' || g.group_id) as last_active
    FROM managed_groups g
    ORDER BY g.group_id ASC
  `).all();
  return rows.map(r => {
    const gid = Number(r.group_id);
    const isWechat = r.platform === "wechat" || (gid >= 990000 && gid <= 999999) || String(r.group_name || "").startsWith("微信");
    return {
      ...r,
      enabled: Boolean(r.enabled),
      platform: isWechat ? "wechat" : "qq"
    };
  });
}

/**
 * 获取指定群组配置
 */
export function getManagedGroup(groupId) {
  const row = db.prepare("SELECT group_id, group_name, enabled, trigger_policy, platform FROM managed_groups WHERE group_id = ?").get(Number(groupId));
  if (!row) return null;
  const gid = Number(row.group_id);
  const isWechat = row.platform === "wechat" || (gid >= 990000 && gid <= 999999) || String(row.group_name || "").startsWith("微信");
  return {
    ...row,
    enabled: Boolean(row.enabled),
    platform: isWechat ? "wechat" : "qq"
  };
}

/**
 * 保存或更新群组配置
 */
export function saveManagedGroup(groupId, groupName = "", enabled = true, triggerPolicy = "all", platform = null) {
  const gid = Number(groupId);
  const existing = getManagedGroup(gid);
  const name = String((groupName !== undefined && groupName !== "") ? groupName : (existing?.group_name || `群聊 ${gid}`));
  const en = enabled ? 1 : 0;
  const policy = triggerPolicy === "strict" ? "strict" : "all";
  const isWechat = platform === "wechat" || existing?.platform === "wechat" || (gid >= 990000 && gid <= 999999) || name.startsWith("微信");
  const targetPlatform = platform || existing?.platform || (isWechat ? "wechat" : "qq");

  const stmt = db.prepare(`
    INSERT INTO managed_groups (group_id, group_name, enabled, trigger_policy, platform, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(group_id) DO UPDATE SET
      group_name = excluded.group_name,
      enabled = excluded.enabled,
      trigger_policy = excluded.trigger_policy,
      platform = excluded.platform,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(gid, name, en, policy, targetPlatform);
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
  client = "antigravity",
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

    const effectiveClient = String(client || (mName && mName.toLowerCase().includes("deepseek") ? "dsh" : "antigravity")).trim();

  runWithRetry(() => {
    const stmt = db.prepare(`
      INSERT INTO token_usage (
        session_key, group_id, persona,
        prompt_chars, reply_chars,
        estimated_prompt_tokens, estimated_reply_tokens,
        reasoning_tokens, duration_ms, throughput_tps,
        cost_cny, cost_usd, model_name,
        cached_tokens, new_tokens, cache_hit_rate,
        total_tokens, client
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionKey, gid, persona,
      pChars, rChars,
      pTokens, rTokens,
      rReasoning, dMs, tps,
      cCny, cUsd, mName,
      calculatedCachedTokens, calculatedNewTokens, finalHitRate,
      totalTokens, effectiveClient
    );
  });

  return {
    sessionKey,
    groupId: gid,
    persona,
    client: effectiveClient,
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
 * 获取 Token 监测统计汇总（支持按天数、群组、人设、客户端聚合筛选，包含缓存命中率、推理Token、吞吐与成本估算）
 */
export function getTokenUsageStats({ days = 7, groupId = null, persona = null, client = null } = {}) {
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
  if (client && String(client).toLowerCase() !== "all" && String(client).toLowerCase() !== "both") {
    whereClauses.push("client = ?");
    params.push(String(client).toLowerCase());
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
export function getRecentTokenLogs(limit = 50, { excludeTest = false, groupId = null, client = null } = {}) {
  const whereClauses = [];
  const params = [];
  if (excludeTest) {
    whereClauses.push("session_key NOT LIKE 'test:%' AND session_key NOT LIKE 'group:test_%' AND session_key != 'group:123' AND (group_id != 0 OR session_key LIKE 'private:%')");
  }
  if (groupId) {
    whereClauses.push("group_id = ?");
    params.push(Number(groupId));
  }
  if (client && String(client).toLowerCase() !== "all" && String(client).toLowerCase() !== "both") {
    whereClauses.push("client = ?");
    params.push(String(client).toLowerCase());
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  params.push(limit);
  return db.prepare(`
    SELECT id, session_key, group_id, persona, client, prompt_chars, reply_chars,
           estimated_prompt_tokens, estimated_reply_tokens,
           reasoning_tokens, duration_ms, throughput_tps,
           cost_cny, cost_usd, model_name,
           cached_tokens, new_tokens, cache_hit_rate,
           total_tokens, created_at
    FROM token_usage
    ${whereSql}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params);
}

/**
 * 清理测试流量流水记录 (session_key LIKE 'test:%' 等)
 */
export function cleanTestTokenLogs() {
  const res = db.prepare(`
    DELETE FROM token_usage 
    WHERE session_key LIKE 'test:%' 
       OR session_key LIKE 'group:test_%' 
       OR session_key LIKE 'group:999888%' 
       OR session_key = 'group:88812345'
       OR session_key = 'group:123' 
       OR group_id IN (88812345, 999888111, 999888222, 999888333, 999888777)
       OR (group_id = 0 AND session_key NOT LIKE 'private:%')
  `).run();
  return {
    deletedCount: res.changes,
    remaining: db.prepare("SELECT COUNT(*) as count FROM token_usage").get()?.count || 0
  };
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

/**
 * 定期归档与清理陈旧流水日志 (保留好感度与核心记忆表)
 * 默认清理超过 30 天的普通群聊流水日志与已过期的消息队列记录
 */
export function pruneOldRecords(days = 30) {
  try {
    const safeDays = Math.max(1, parseInt(days, 10) || 30);
    const msgStmt = db.prepare(`DELETE FROM chat_messages WHERE created_at < datetime('now', '-' || ? || ' days')`);
    const msgRes = msgStmt.run(safeDays);
    let deletedCount = msgRes.changes || 0;

    try {
      const inboxStmt = db.prepare(`DELETE FROM inbox_queue WHERE created_at < datetime('now', '-' || ? || ' days')`);
      const inboxRes = inboxStmt.run(safeDays);
      deletedCount += (inboxRes.changes || 0);
    } catch {}

    // 维持各群最多 200 条轻量历史
    try {
      deletedCount += trimChatMessages(null, 200);
    } catch {}

    // 清理超过 30 天且仅出现过 1 次的偶发黑话碎片
    try {
      const slangStmt = db.prepare(`DELETE FROM group_slangs WHERE frequency = 1 AND last_seen < datetime('now', '-' || ? || ' days')`);
      const slangRes = slangStmt.run(safeDays);
      deletedCount += (slangRes.changes || 0);
    } catch {}

    // 触发 WAL Checkpoint 截断归档
    checkpointDatabase("TRUNCATE");

    console.log(`🧹 [SQLite 自动归档] 成功清理超过 ${safeDays} 天的历史流水日志 (共 ${deletedCount} 条) 并完成 WAL 截断`);
    return deletedCount;
  } catch (err) {
    console.warn(`[SQLite 自动归档失败]:`, err.message);
    return 0;
  }
}

export { getAntigravityBrainTokenStats } from "./antigravity-discovery.mjs";

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const isInitCmd = process.argv.includes("--init");
  console.log(`[SQLite] 数据库初始化成功: ${getDatabasePath()}`);
  if (isInitCmd) {
    const checkpointRes = checkpointDatabase("TRUNCATE");
    console.log(`[SQLite] WAL Checkpoint (TRUNCATE) 执行完成:`, checkpointRes || { busy: 0, log: 0, checkpointed: 0 });
  }
}

