import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const PRICING_CONFIG_PATH = path.resolve(PROJECT_ROOT, "config/pricing.json");

/**
 * 默认汇率 (默认 1 USD = 7.25 CNY)
 */
export const DEFAULT_EXCHANGE_RATE_USD_CNY = 7.25;

/**
 * 内置兜底模型阶梯价格表 (USD / 1,000,000 Tokens)
 */
export const DEFAULT_MODEL_PRICING = {
  // Google Gemini 系列
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    inputPerM: 1.25,
    cachedInputPerM: 0.3125,
    outputPerM: 5.00
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    inputPerM: 0.075,
    cachedInputPerM: 0.01875,
    outputPerM: 0.30
  },
  "gemini-1.5-pro": {
    name: "Gemini 1.5 Pro",
    inputPerM: 1.25,
    cachedInputPerM: 0.3125,
    outputPerM: 5.00
  },
  "gemini-1.5-flash": {
    name: "Gemini 1.5 Flash",
    inputPerM: 0.075,
    cachedInputPerM: 0.01875,
    outputPerM: 0.30
  },
  // Anthropic Claude 系列
  "claude-3.7-sonnet": {
    name: "Claude 3.7 Sonnet (Hybrid)",
    inputPerM: 3.00,
    cachedInputPerM: 0.30,
    outputPerM: 15.00
  },
  "claude-3.5-sonnet": {
    name: "Claude 3.5 Sonnet",
    inputPerM: 3.00,
    cachedInputPerM: 0.30,
    outputPerM: 15.00
  },
  "claude-3.5-haiku": {
    name: "Claude 3.5 Haiku",
    inputPerM: 0.80,
    cachedInputPerM: 0.08,
    outputPerM: 4.00
  },
  // DeepSeek 系列 (含 DSH 常用模型)
  "deepseek-v3": {
    name: "DeepSeek V3",
    useCnyDirect: true,
    inputPerM: 0.14,
    cachedInputPerM: 0.014,
    outputPerM: 0.28,
    cnyInputPerM: 1.00,
    cnyCachedInputPerM: 0.10,
    cnyOutputPerM: 2.00
  },
  "deepseek-chat": {
    name: "DeepSeek Chat (V3)",
    useCnyDirect: true,
    inputPerM: 0.14,
    cachedInputPerM: 0.014,
    outputPerM: 0.28,
    cnyInputPerM: 1.00,
    cnyCachedInputPerM: 0.10,
    cnyOutputPerM: 2.00
  },
  "deepseek-r1": {
    name: "DeepSeek R1",
    useCnyDirect: true,
    inputPerM: 0.55,
    cachedInputPerM: 0.14,
    outputPerM: 2.19,
    cnyInputPerM: 4.00,
    cnyCachedInputPerM: 1.00,
    cnyOutputPerM: 16.00
  },
  "deepseek-reasoner": {
    name: "DeepSeek Reasoner (R1)",
    useCnyDirect: true,
    inputPerM: 0.55,
    cachedInputPerM: 0.14,
    outputPerM: 2.19,
    cnyInputPerM: 4.00,
    cnyCachedInputPerM: 1.00,
    cnyOutputPerM: 16.00
  },
  "deepseek-flash": {
    name: "DeepSeek V4.1 Flash",
    useCnyDirect: true,
    inputPerM: 0.137931,
    cachedInputPerM: 0.002759,
    outputPerM: 0.551724,
    cnyInputPerM: 1.00,
    cnyCachedInputPerM: 0.02,
    cnyOutputPerM: 4.00
  },
  "deepseek-pro": {
    name: "DeepSeek V4 Pro",
    useCnyDirect: true,
    inputPerM: 0.62069,
    cachedInputPerM: 0.02069,
    outputPerM: 1.862069,
    cnyInputPerM: 4.50,
    cnyCachedInputPerM: 0.15,
    cnyOutputPerM: 13.50
  },
  // OpenAI 系列
  "gpt-4o": {
    name: "GPT-4o",
    inputPerM: 2.50,
    cachedInputPerM: 1.25,
    outputPerM: 10.00
  },
  "gpt-4o-mini": {
    name: "GPT-4o mini",
    inputPerM: 0.15,
    cachedInputPerM: 0.075,
    outputPerM: 0.60
  }
};

/**
 * 内存中动态持有的标准模型价格字典
 */
export let STANDARD_MODEL_PRICING = { ...DEFAULT_MODEL_PRICING };
export let CURRENT_EXCHANGE_RATE = DEFAULT_EXCHANGE_RATE_USD_CNY;

/**
 * 从 config/pricing.json 读取并同步最新模型费率
 */
export function loadPricingConfig() {
  if (fs.existsSync(PRICING_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(PRICING_CONFIG_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (data.models && typeof data.models === "object") {
          STANDARD_MODEL_PRICING = { ...DEFAULT_MODEL_PRICING, ...data.models };
        }
        if (typeof data.exchangeRateUsdToCny === "number" && data.exchangeRateUsdToCny > 0) {
          CURRENT_EXCHANGE_RATE = data.exchangeRateUsdToCny;
        }
        return {
          exchangeRateUsdToCny: CURRENT_EXCHANGE_RATE,
          models: STANDARD_MODEL_PRICING
        };
      }
    } catch (err) {
      console.warn("[Pricing] 读取 config/pricing.json 失败，使用内置默认定价:", err.message);
    }
  }
  return {
    exchangeRateUsdToCny: CURRENT_EXCHANGE_RATE,
    models: STANDARD_MODEL_PRICING
  };
}

/**
 * 保存并热更新费率配置到 config/pricing.json
 */
export function savePricingConfig(newConfig = {}) {
  const cfgDir = path.dirname(PRICING_CONFIG_PATH);
  if (!fs.existsSync(cfgDir)) {
    fs.mkdirSync(cfgDir, { recursive: true });
  }

  const payload = {
    exchangeRateUsdToCny: Number(newConfig.exchangeRateUsdToCny) || CURRENT_EXCHANGE_RATE,
    models: newConfig.models && typeof newConfig.models === "object" ? newConfig.models : STANDARD_MODEL_PRICING
  };

  fs.writeFileSync(PRICING_CONFIG_PATH, JSON.stringify(payload, null, 2), "utf-8");
  return loadPricingConfig();
}

// 模块加载时执行首次初始化
loadPricingConfig();

/**
 * 依据传入的模型名称匹配对应的价格策略 (支持模糊匹配与别名)
 */
/**
 * 2026 年中国法定节假日（放假日，含调休连休段）
 */
export const CN_HOLIDAYS_2026 = [
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07"
];

/**
 * 2027 年中国法定节假日
 */
export const CN_HOLIDAYS_2027 = [
  "2027-01-01", "2027-01-02", "2027-01-03",
  "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",
  "2027-02-10", "2027-02-11", "2027-02-12", "2027-02-13",
  "2027-04-04", "2027-04-05", "2027-04-06",
  "2027-05-01", "2027-05-02", "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-06-09", "2027-06-10", "2027-06-11",
  "2027-09-15", "2027-09-16", "2027-09-17",
  "2027-10-01", "2027-10-02", "2027-10-03", "2027-10-04",
  "2027-10-05", "2027-10-06", "2027-10-07"
];

export const CN_HOLIDAYS = [...CN_HOLIDAYS_2026, ...CN_HOLIDAYS_2027];

/**
 * 判定北京时间 (UTC+8) 是否为高峰时段
 * 高峰时段定义（对齐 DeepSeek 官方规则）：周一至周五 9:00-12:00, 14:00-18:00，且不含中国法定节假日；
 * 周末及法定节假日全天均为空闲时段。
 */
export function isPeakAtBeijing(atMs = Date.now()) {
  const BEIJING_OFFSET_MINUTES = 8 * 60;
  const d = new Date(Number(atMs) + BEIJING_OFFSET_MINUTES * 60000);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=周一 … 7=周日
  if (weekday > 5) return false; // 周末为空闲时段

  const dateStr = d.toISOString().slice(0, 10);
  if (CN_HOLIDAYS.includes(dateStr)) return false; // 中国法定节假日全天空闲

  const hour = d.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/**
 * 依据传入的模型名称匹配对应的价格策略 (支持模糊匹配与别名)
 */
export function resolveModelPricing(modelName = "", customPricing = {}) {
  const customModels = customPricing.models || {};
  const norm = String(modelName || "").trim().toLowerCase();

  // 1. 用户自定义显式精确覆盖
  if (customModels[norm]) {
    return { ...customModels[norm], id: norm };
  }

  // 2. 匹配外置 JSON 或标准库
  if (STANDARD_MODEL_PRICING[norm]) {
    return { ...STANDARD_MODEL_PRICING[norm], id: norm };
  }

  // 3. 别名与模糊匹配
  if (norm.includes("gemini") && (norm.includes("pro") || norm.includes("argon"))) {
    return { ...STANDARD_MODEL_PRICING["gemini-2.5-pro"], id: "gemini-2.5-pro" };
  }
  if (norm.includes("gemini") && (norm.includes("flash") || norm.includes("3.8") || norm.includes("2.0"))) {
    return { ...STANDARD_MODEL_PRICING["gemini-2.5-flash"], id: "gemini-2.5-flash" };
  }
  if (norm.includes("sonnet") || norm.includes("claude-3-7") || norm.includes("claude-4")) {
    return { ...STANDARD_MODEL_PRICING["claude-3.7-sonnet"], id: "claude-3.7-sonnet" };
  }
  if (norm.includes("deepseek") && (norm.includes("r1") || norm.includes("reasoner"))) {
    return { ...STANDARD_MODEL_PRICING["deepseek-r1"], id: "deepseek-r1" };
  }
  if (norm.includes("deepseek") && (norm.includes("flash") || norm.includes("v4.1") || norm.includes("v4-flash"))) {
    return { ...STANDARD_MODEL_PRICING["deepseek-flash"], id: "deepseek-flash" };
  }
  if (norm.includes("deepseek") && (norm.includes("pro") || norm.includes("v4-pro") || norm.includes("0813"))) {
    return { ...STANDARD_MODEL_PRICING["deepseek-pro"], id: "deepseek-pro" };
  }
  if (norm.includes("deepseek") && (norm.includes("chat") || norm.includes("v3"))) {
    return { ...STANDARD_MODEL_PRICING["deepseek-v3"], id: "deepseek-v3" };
  }
  if (norm.includes("dsh")) {
    return { ...STANDARD_MODEL_PRICING["deepseek-flash"], id: "deepseek-flash" };
  }
  if (norm.includes("deepseek")) {
    return { ...STANDARD_MODEL_PRICING["deepseek-v3"], id: "deepseek-v3" };
  }

  // 默认兜底为 Gemini 2.5 Pro (Antigravity 常用主力模型)
  return { ...STANDARD_MODEL_PRICING["gemini-2.5-pro"], id: "gemini-2.5-pro" };
}

/**
 * 计算单次调用的成本 (CNY 与 USD)
 */
export function calculateTokenCost({
  modelName = "gemini-2.5-pro",
  promptTokens = 0,
  replyTokens = 0,
  cachedTokens = 0,
  customPricing = {},
  atMs = null,
  isPeak = null
} = {}) {
  const pricing = resolveModelPricing(modelName, customPricing);
  const exchangeRate = Number(customPricing.exchangeRateUsdToCny) || CURRENT_EXCHANGE_RATE;

  // 有效非缓存输入 Tokens
  const safeCachedTokens = Math.min(promptTokens, Math.max(0, cachedTokens || 0));
  const uncachedPromptTokens = Math.max(0, promptTokens - safeCachedTokens);
  const safeReplyTokens = Math.max(0, replyTokens || 0);

  // 峰谷分时倍率判定 (支持 DeepSeek 峰谷策略，默认 1.0)
  let peakFactor = 1.0;
  const shouldCheckPeak = isPeak !== null ? isPeak : (customPricing.applyPeakMultiplier ? isPeakAtBeijing(atMs || Date.now()) : false);
  if (shouldCheckPeak) {
    peakFactor = Number(customPricing.peakMultiplier) || 2.0;
  }

  let totalUsd, totalCny;
  let costPromptUsd, costCachedUsd, costReplyUsd;
  let costPromptCny, costCachedCny, costReplyCny;

  if (pricing.useCnyDirect && pricing.cnyInputPerM !== undefined) {
    // 原生 CNY 精确计费 (如 DeepSeek Flash / Pro)
    costPromptCny = (uncachedPromptTokens * pricing.cnyInputPerM * peakFactor) / 1000000;
    costCachedCny = (safeCachedTokens * pricing.cnyCachedInputPerM * peakFactor) / 1000000;
    costReplyCny = (safeReplyTokens * pricing.cnyOutputPerM * peakFactor) / 1000000;
    totalCny = costPromptCny + costCachedCny + costReplyCny;
    totalUsd = totalCny / exchangeRate;
    costPromptUsd = costPromptCny / exchangeRate;
    costCachedUsd = costCachedCny / exchangeRate;
    costReplyUsd = costReplyCny / exchangeRate;
  } else {
    // 标准 USD 计费折算
    costPromptUsd = (uncachedPromptTokens * pricing.inputPerM * peakFactor) / 1000000;
    costCachedUsd = (safeCachedTokens * pricing.cachedInputPerM * peakFactor) / 1000000;
    costReplyUsd = (safeReplyTokens * pricing.outputPerM * peakFactor) / 1000000;
    totalUsd = costPromptUsd + costCachedUsd + costReplyUsd;
    totalCny = totalUsd * exchangeRate;
    costPromptCny = costPromptUsd * exchangeRate;
    costCachedCny = costCachedUsd * exchangeRate;
    costReplyCny = costReplyUsd * exchangeRate;
  }

  return {
    modelName: pricing.name,
    modelId: pricing.id,
    costUsd: Number(totalUsd.toFixed(6)),
    costCny: Number(totalCny.toFixed(6)),
    isPeak: Boolean(shouldCheckPeak),
    peakFactor,
    breakdown: {
      uncachedPromptTokens,
      cachedTokens: safeCachedTokens,
      replyTokens: safeReplyTokens,
      costPromptUsd: Number(costPromptUsd.toFixed(6)),
      costCachedUsd: Number(costCachedUsd.toFixed(6)),
      costReplyUsd: Number(costReplyUsd.toFixed(6)),
      costPromptCny: Number(costPromptCny.toFixed(6)),
      costCachedCny: Number(costCachedCny.toFixed(6)),
      costReplyCny: Number(costReplyCny.toFixed(6))
    }
  };
}
