import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const AGENTS_DIR = path.resolve(PROJECT_ROOT, "agents");

/**
 * 解析 Markdown 文件的 YAML Frontmatter
 */
export function parseFrontmatter(rawContent) {
  if (!rawContent || !rawContent.startsWith("---")) {
    return { meta: {}, body: rawContent || "" };
  }
  const endIdx = rawContent.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { meta: {}, body: rawContent };
  }
  const rawMeta = rawContent.slice(3, endIdx).trim();
  const body = rawContent.slice(endIdx + 4).trim();
  const meta = {};

  for (const line of rawMeta.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    if (val.startsWith("[") && val.endsWith("]")) {
      try {
        val = JSON.parse(val);
      } catch {
        val = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (val === "true") {
      val = true;
    } else if (val === "false") {
      val = false;
    } else if (!isNaN(Number(val)) && val !== "") {
      val = Number(val);
    }
    meta[key] = val;
  }

  return { meta, body };
}

/**
 * 动态扫描 agents/ 目录并自动加载所有人格定义
 */
export const PERSONAS = {};

// 人格别名映射表 (例如 bailong <-> dragon_girl, whale <-> little_whale)
export const PERSONA_ALIASES = {
  dragon_girl: "bailong",
  bailong: "dragon_girl",
  little_whale: "whale",
  whale: "little_whale"
};

export function reloadPersonasFromAgents() {
  // 清空现有键
  for (const k of Object.keys(PERSONAS)) {
    delete PERSONAS[k];
  }

  if (!fs.existsSync(AGENTS_DIR)) {
    return PERSONAS;
  }

  try {
    const files = fs.readdirSync(AGENTS_DIR);
    const loadedMap = new Map();

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      // 忽略下划线开头的协议/配置文件和系统提示词
      if (file.startsWith("_") || file === "qq-chat-v2.md") continue;

      const fileKey = file.replace(/\.md$/, "");
      const fullPath = path.join(AGENTS_DIR, file);

      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const { meta } = parseFrontmatter(raw);

        const id = (meta.id || fileKey).toLowerCase().trim();
        const displayName = meta.displayName || meta.name || fileKey;
        const mentionRegex = meta.mentionRegex
          ? (meta.mentionRegex instanceof RegExp ? meta.mentionRegex : new RegExp(meta.mentionRegex, "i"))
          : new RegExp(displayName || id, "i");
        const interestKeywords = Array.isArray(meta.interestKeywords)
          ? meta.interestKeywords
          : [];

        const personaObj = {
          name: id,
          displayName,
          mentionRegex,
          interestKeywords,
          defaultLocation: meta.defaultLocation || "现实世界",
          defaultAction: meta.defaultAction || "待命中",
          defaultDetail: meta.defaultDetail || "周围环境安静",
          defaultMood: meta.defaultMood || "自然",
          defaultAffection: meta.defaultAffection ?? 30,
          avatar: meta.avatar || `${id}.png`,
          aliases: Array.isArray(meta.aliases) ? meta.aliases : []
        };

        loadedMap.set(fileKey, personaObj);
        loadedMap.set(id, personaObj);

        if (Array.isArray(meta.aliases)) {
          for (const alias of meta.aliases) {
            loadedMap.set(alias.toLowerCase().trim(), personaObj);
          }
        }
      } catch (err) {
        console.warn(`[Persona] 加载人格文件失败: ${file}`, err.message);
      }
    }

    // 注入别名映射与双向兼容支持
    for (const [alias, target] of Object.entries(PERSONA_ALIASES)) {
      if (loadedMap.has(target) && !loadedMap.has(alias)) {
        const base = loadedMap.get(target);
        loadedMap.set(alias, { ...base, name: alias });
      } else if (loadedMap.has(alias) && !loadedMap.has(target)) {
        const base = loadedMap.get(alias);
        loadedMap.set(target, { ...base, name: target });
      }
    }

    // 同步到全局导出的 PERSONAS
    for (const [k, v] of loadedMap.entries()) {
      PERSONAS[k] = v;
    }
  } catch (err) {
    console.warn("[Persona] 扫描 agents/ 目录失败:", err.message);
  }

  // 兜底保证 tomoko 存在
  if (!PERSONAS.tomoko) {
    PERSONAS.tomoko = {
      name: "tomoko",
      displayName: "智子",
      mentionRegex: /智子|tomoko/i,
      interestKeywords: [
        "switch", "ps5", "playstation", "任天堂", "主机", "单机", "游戏", "塞尔达", "马里奥",
        "宝可梦", "怪物猎人", "怪猎", "最终幻想", "直面会", "新番", "动漫", "漫画", "二次元",
        "拉面", "寿喜烧", "麦茶", "电玩", "通关", "白金", "卡关", "画质", "steam", "好玩", "神作"
      ],
      defaultLocation: "海外家中二楼房间",
      defaultAction: "坐在地毯上抱着 Switch 玩单机，手边放着麦茶",
      defaultDetail: "房间里只有游戏手柄按键的声音和屏幕光影",
      defaultMood: "放松、专注",
      defaultAffection: 20,
      avatar: "tomoko.png"
    };
  }

  return PERSONAS;
}

// 模块初始化时执行首次加载
reloadPersonasFromAgents();

/**
 * 获取当前激活的角色人设配置（默认 tomoko）
 */
export function getActivePersona(presetName) {
  const key = (presetName || "").toLowerCase().trim();
  if (PERSONAS[key]) return PERSONAS[key];

  // 尝试别名
  if (PERSONA_ALIASES[key] && PERSONAS[PERSONA_ALIASES[key]]) {
    return PERSONAS[PERSONA_ALIASES[key]];
  }

  return PERSONAS.tomoko;
}

/**
 * 读取角色提示词文件（优先读取 agents/<presetName>.md）
 */
export function loadPersonaPrompt(presetName) {
  const key = (presetName || "tomoko").toLowerCase().trim();
  const candidateKeys = [
    key,
    PERSONA_ALIASES[key],
    getActivePersona(key)?.name,
    "tomoko"
  ].filter(Boolean);

  for (const candidate of candidateKeys) {
    const p = path.join(AGENTS_DIR, `${candidate}.md`);
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf-8");
      } catch (e) {
        console.warn(`[Persona] 读取角色提示词失败: ${p}`, e.message);
      }
    }
  }

  return "";
}

/**
 * 获取所有可用人格列表及其元数据
 */
export function getAllPersonas(activePreset = "tomoko") {
  const activeKey = (activePreset || "tomoko").toLowerCase().trim();
  const list = [];
  const seenKeys = new Set();
  const seenDisplayNames = new Set();

  // 保证核心人设显示顺序
  const preferredKeys = ["tomoko", "bailong", "whale", "haena"];
  // 若请求的 activeKey 为旧别名，也支持识别
  const activeCanonical = PERSONAS[activeKey]?.name || activeKey;

  for (const key of preferredKeys) {
    if (PERSONAS[key]) {
      const p = PERSONAS[key];
      if (seenDisplayNames.has(p.displayName)) continue;
      seenDisplayNames.add(p.displayName);
      seenKeys.add(key);

      const cardPath = path.join(AGENTS_DIR, `${key}.md`);
      const cardExists = fs.existsSync(cardPath) || fs.existsSync(path.join(AGENTS_DIR, `${p.name}.md`));
      let cardPreview = "";
      if (cardExists) {
        try {
          const content = loadPersonaPrompt(key);
          const { body } = parseFrontmatter(content);
          cardPreview = (body || content).slice(0, 180);
        } catch {}
      }

      list.push({
        key,
        name: p.name,
        displayName: p.displayName,
        defaultLocation: p.defaultLocation,
        defaultAction: p.defaultAction,
        defaultMood: p.defaultMood,
        cardExists,
        cardPreview,
        isActive: key === activeKey || p.name === activeKey || key === activeCanonical || p.name === activeCanonical
      });
    }
  }

  // 追加其他动态发现的人设
  for (const [key, p] of Object.entries(PERSONAS)) {
    if (seenKeys.has(key) || seenDisplayNames.has(p.displayName)) continue;
    seenKeys.add(key);
    seenDisplayNames.add(p.displayName);

    const cardPath = path.join(AGENTS_DIR, `${key}.md`);
    const cardExists = fs.existsSync(cardPath);
    let cardPreview = "";
    if (cardExists) {
      try {
        const content = fs.readFileSync(cardPath, "utf-8");
        const { body } = parseFrontmatter(content);
        cardPreview = (body || content).slice(0, 180);
      } catch {}
    }

    list.push({
      key,
      name: p.name,
      displayName: p.displayName,
      defaultLocation: p.defaultLocation,
      defaultAction: p.defaultAction,
      defaultMood: p.defaultMood,
      cardExists,
      cardPreview,
      isActive: key === activeKey || p.name === activeKey || key === activeCanonical
    });
  }

  return list;
}

/**
 * 保存或修改角色 Markdown 卡片
 */
export function savePersonaPrompt(presetName, markdownContent) {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
  const cleanName = presetName.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const filePath = path.join(AGENTS_DIR, `${cleanName}.md`);
  fs.writeFileSync(filePath, markdownContent, "utf-8");
  reloadPersonasFromAgents();
  return true;
}

/**
 * 动态注册/更新人设元数据
 */
export function registerPersona(key, meta = {}) {
  const cleanKey = key.toLowerCase().trim();
  PERSONAS[cleanKey] = {
    name: cleanKey,
    displayName: meta.displayName || cleanKey,
    mentionRegex: meta.mentionRegex || new RegExp(meta.displayName || cleanKey, "i"),
    interestKeywords: Array.isArray(meta.interestKeywords) ? meta.interestKeywords : [],
    defaultLocation: meta.defaultLocation || "现实世界",
    defaultAction: meta.defaultAction || "待命中",
    defaultDetail: meta.defaultDetail || "周围环境安静",
    defaultMood: meta.defaultMood || "自然",
    defaultAffection: meta.defaultAffection ?? 30,
    avatar: meta.avatar || `${cleanKey}.png`
  };
  return PERSONAS[cleanKey];
}

/**
 * 读取底层通用协议 _base_protocol.md
 */
export function loadBaseProtocol() {
  const protocolPath = path.join(AGENTS_DIR, "_base_protocol.md");
  if (fs.existsSync(protocolPath)) {
    try {
      return fs.readFileSync(protocolPath, "utf-8").trim();
    } catch {}
  }
  return "";
}

/**
 * 读取好感度态度矩阵配置 _affection_matrix.json
 */
export function loadAffectionMatrix() {
  const matrixPath = path.join(AGENTS_DIR, "_affection_matrix.json");
  if (fs.existsSync(matrixPath)) {
    try {
      return JSON.parse(fs.readFileSync(matrixPath, "utf-8"));
    } catch {}
  }
  return { ranges: [] };
}

/**
 * 根据好感度分数从矩阵中解析出当前角色的态度指令
 */
export function getAttitudeInstruction(userAffection = 30) {
  const matrix = loadAffectionMatrix();
  const rawAff = typeof userAffection === "number" && !isNaN(userAffection) ? userAffection : 30;
  const ranges = matrix.ranges || [];

  if (ranges.length > 0) {
    // 约束在矩阵区间上下界内，确保极值仍能匹配第一项或最后一项态度配置
    const lowestMin = ranges[0].min ?? -100;
    const highestMax = ranges[ranges.length - 1].max ?? 100;
    const clampedAff = Math.max(lowestMin, Math.min(highestMax, rawAff));

    for (const item of ranges) {
      if (clampedAff >= item.min && clampedAff <= item.max) {
        return {
          level: item.level,
          instruction: item.instruction
        };
      }
    }
  }

  // 默认兜底
  if (rawAff < 0) {
    return { level: "嫌恶", instruction: "态度指令：当前好感度为负数（极其反感）：极度冷淡厌恶甚至带刺，多用冷嘲反问，不屑一顾，坚决潜水无视或敷衍打发对方。" };
  } else if (rawAff <= 20) {
    return { level: "戒备", instruction: "态度指令：当前好感度在 0-20 分（极其冷淡戒备）：表现出戒备与生疏，多用反问句或单字敷衍，不主动展开话题，语气冷淡客气保持距离。" };
  } else if (rawAff < 50) {
    return { level: "初识", instruction: "态度指令：当前好感度在初识阶段（普通友好）：保持礼貌客气，偶有拘谨或好奇，根据人设性格正常互动接话。" };
  } else if (rawAff < 70) {
    return { level: "朋友", instruction: "态度指令：当前好感度在朋友阶段：放松自然，说话直接亲近，愿意主动接梗、吐槽、分享自己的兴趣。" };
  } else if (rawAff < 90) {
    return { level: "挚友", instruction: "态度指令：当前好感度在挚友阶段：表现出明显的亲近与信赖，会偏袒对方，主动关心，分享私人心事。" };
  } else {
    return { level: "特别", instruction: "态度指令：当前好感度在特别阶段：极度信任与在乎对方，秒回且情绪受对方牵动，略显傲娇或依恋。" };
  }
}

/**
 * 🌟 核心三层 Prompt 架构动态拼接引擎
 * 第一层：_base_protocol.md (全局绝对法则、去 AI 味、群聊注意力、防破甲)
 * 第二层：agents/{persona}.md (人设核心特征、口癖、Few-shot 对话范例)
 * 第三层：好感度矩阵态度指令 + 动态时空身位与背景感知
 *
 * @param {string} personaId 角色预设ID (如 tomoko, bailong, whale, haena)
 * @param {number} userAffection 目标用户的当前好感度数值
 * @param {object} context 动态上下文 (location, action, detail, mood, etc.)
 * @returns {string} 动态拼接完成的三层标准化 System Prompt
 */
export function buildSystemPrompt(personaId, userAffection = 30, context = {}) {
  const baseProtocol = loadBaseProtocol();
  const rawPersonaContent = loadPersonaPrompt(personaId);
  const { body: personaBody } = parseFrontmatter(rawPersonaContent);
  const attitude = getAttitudeInstruction(userAffection);
  const persona = getActivePersona(personaId);

  const location = context.location || persona.defaultLocation;
  const action = context.action || persona.defaultAction;
  const detail = context.detail || persona.defaultDetail;
  const mood = context.mood || persona.defaultMood;

  const parts = [];

  // 第 1 层：底层通用协议 (ABSOLUTE RULES)
  if (baseProtocol) {
    parts.push(`=== [第一层：底层通用环境与交互法则] ===\n${baseProtocol}`);
  }

  // 第 2 层：角色人设、口癖与 Few-shot 示例
  if (personaBody) {
    parts.push(`=== [第二层：当前激活角色设定 (${persona.displayName})] ===\n${personaBody}`);
  }

  // 第 3 层：实时好感度态度注入与动态时空身位
  const thirdLayer = [
    `=== [第三层：实时好感度态度注入与时空身位] ===`,
    `• 当前说话人好感度: ${userAffection} 分 (关系阶段: 【${attitude.level}】)`,
    `• ${attitude.instruction}`,
    `• 你的当前真实物理位置: 【${location}】`,
    `• 你当前正在进行的活动: 【${action}】`,
    `• 现场细节与环境氛围: 【${detail}】`,
    `• 当前情绪心境: 【${mood}】`
  ].join("\n");

  parts.push(thirdLayer);

  return parts.join("\n\n");
}
