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
  // DeepSeek 系列
  "deepseek-v3": {
    name: "DeepSeek V3",
    inputPerM: 0.14,
    cachedInputPerM: 0.014,
    outputPerM: 0.28
  },
  "deepseek-r1": {
    name: "DeepSeek R1",
    inputPerM: 0.55,
    cachedInputPerM: 0.14,
    outputPerM: 2.19
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
  customPricing = {}
} = {}) {
  const pricing = resolveModelPricing(modelName, customPricing);
  const exchangeRate = Number(customPricing.exchangeRateUsdToCny) || CURRENT_EXCHANGE_RATE;

  // 有效非缓存输入 Tokens
  const safeCachedTokens = Math.min(promptTokens, Math.max(0, cachedTokens || 0));
  const uncachedPromptTokens = Math.max(0, promptTokens - safeCachedTokens);
  const safeReplyTokens = Math.max(0, replyTokens || 0);

  // 成本 = (未命中输入 * 输入单价 + 缓存命中输入 * 缓存单价 + 输出 * 输出单价) / 1,000,000
  const costPromptUsd = (uncachedPromptTokens * pricing.inputPerM) / 1000000;
  const costCachedUsd = (safeCachedTokens * pricing.cachedInputPerM) / 1000000;
  const costReplyUsd = (safeReplyTokens * pricing.outputPerM) / 1000000;

  const totalUsd = costPromptUsd + costCachedUsd + costReplyUsd;
  const totalCny = totalUsd * exchangeRate;

  return {
    modelName: pricing.name,
    modelId: pricing.id,
    costUsd: Number(totalUsd.toFixed(6)),
    costCny: Number(totalCny.toFixed(6)),
    breakdown: {
      uncachedPromptTokens,
      cachedTokens: safeCachedTokens,
      replyTokens: safeReplyTokens,
      costPromptUsd: Number(costPromptUsd.toFixed(6)),
      costCachedUsd: Number(costCachedUsd.toFixed(6)),
      costReplyUsd: Number(costReplyUsd.toFixed(6))
    }
  };
}
