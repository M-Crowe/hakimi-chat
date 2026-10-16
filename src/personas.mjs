import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export const PERSONAS = {
  tomoko: {
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
    defaultMood: "放松、专注"
  },
  dragon_girl: {
    name: "dragon_girl",
    displayName: "白龙娘",
    mentionRegex: /白龙娘|龙娘|gpt|chatgpt|小龙包/i,
    interestKeywords: [
      "gpt", "chatgpt", "openai", "龙娘", "大模型", "ai", "显卡", "算力", "token", "深度学习", "sha256", "代码", "bug", "苦力怕", "摸鱼"
    ],
    defaultLocation: "云端水晶龙巢",
    defaultAction: "盘在金币堆上翻阅代码终端与游戏日志",
    defaultDetail: "四周环绕着银白色的龙鳞光泽与浮动的终端窗口",
    defaultMood: "傲慢、悠闲"
  },
  little_whale: {
    name: "little_whale",
    displayName: "小鲸鱼",
    mentionRegex: /小鲸鱼|deepseek|深度求索|d指导/i,
    interestKeywords: [
      "deepseek", "小鲸鱼", "d指导", "开源", "模型", "代码", "算法", "推理", "math", "摸鱼", "吃饭", "饿了"
    ],
    defaultLocation: "数据深海空间",
    defaultAction: "潜水在蓝色数据洋流中摸鱼",
    defaultDetail: "周围飘浮着深海气泡与代码碎片",
    defaultMood: "悠闲、傲娇"
  },
  haena: {
    name: "haena",
    displayName: "Haena",
    mentionRegex: /haena|海娜/i,
    interestKeywords: [
      "男朋友", "穿搭", "辣妹", "gyaru", "聚会", "逛街", "美甲", "恋爱", "健身", "吃甜品"
    ],
    defaultLocation: "街头咖啡厅露天座",
    defaultAction: "一边喝冰拿铁一边单手快速滑手机",
    defaultDetail: "橘色指甲在阳光下发亮，桌面放着时尚墨镜",
    defaultMood: "精力充沛、直接"
  }
};

/**
 * 获取当前激活的角色人设配置（默认 tomoko）
 */
export function getActivePersona(presetName) {
  const key = (presetName || "").toLowerCase().trim();
  return PERSONAS[key] || PERSONAS.tomoko;
}

/**
 * 读取角色提示词文件（优先读取 agents/<presetName>.md）
 */
export function loadPersonaPrompt(presetName) {
  const persona = getActivePersona(presetName);
  const agentsDir = path.resolve(PROJECT_ROOT, "agents");
  const candidatePaths = [
    path.join(agentsDir, `${persona.name}.md`),
    path.join(agentsDir, `${presetName}.md`),
    path.join(agentsDir, `tomoko.md`)
  ];

  for (const p of candidatePaths) {
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
  const agentsDir = path.resolve(PROJECT_ROOT, "agents");

  // 先从 PERSONAS 中提取已知配置
  for (const [key, p] of Object.entries(PERSONAS)) {
    const cardPath = path.join(agentsDir, `${key}.md`);
    const cardExists = fs.existsSync(cardPath);
    let cardPreview = "";
    if (cardExists) {
      try {
        const full = fs.readFileSync(cardPath, "utf-8");
        cardPreview = full.slice(0, 180);
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
      isActive: key === activeKey
    });
  }

  // 检查 agents/ 目录下是否有额外的 .md 文件
  if (fs.existsSync(agentsDir)) {
    try {
      const files = fs.readdirSync(agentsDir);
      for (const file of files) {
        if (file.endsWith(".md")) {
          const key = file.replace(/\.md$/, "");
          if (!PERSONAS[key] && key !== "qq-chat-v2") {
            list.push({
              key,
              name: key,
              displayName: key,
              defaultLocation: "现实世界",
              defaultAction: "待命中",
              defaultMood: "平静",
              cardExists: true,
              cardPreview: "",
              isActive: key === activeKey
            });
          }
        }
      }
    } catch {}
  }

  return list;
}

/**
 * 保存或修改角色 Markdown 卡片
 */
export function savePersonaPrompt(presetName, markdownContent) {
  const agentsDir = path.resolve(PROJECT_ROOT, "agents");
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  const cleanName = presetName.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const filePath = path.join(agentsDir, `${cleanName}.md`);
  fs.writeFileSync(filePath, markdownContent, "utf-8");
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
    defaultMood: meta.defaultMood || "自然"
  };
  return PERSONAS[cleanKey];
}
