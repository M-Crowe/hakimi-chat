import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { calculateTokenCost, resolveModelPricing } from "./pricing.mjs";

/**
 * 解析 DSH (DeepSeek Harness) 根目录
 * 查找顺序：显式传入路径 -> 环境变量 DSH_HOME -> config.json 的 dsh.home -> 用户主目录 ~/.dsh
 */
export function resolveDshHome(customPath = null) {
  if (customPath && typeof customPath === "string") {
    return path.resolve(customPath);
  }
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
    return path.resolve(process.env.DSH_HOME.trim());
  }
  try {
    const cfgPath = path.resolve(process.cwd(), "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      if (cfg.dsh?.home && typeof cfg.dsh.home === "string" && cfg.dsh.home.trim()) {
        return path.resolve(cfg.dsh.home.trim());
      }
    }
  } catch {}
  return path.join(os.homedir(), ".dsh");
}

/**
 * 探测本地 DSH 是否安装与可用
 */
export function isDshAvailable(customPath = null) {
  const dshHome = resolveDshHome(customPath);
  return fs.existsSync(dshHome);
}

/**
 * 读取并解析所有 DSH 会话投影缓存 (Session ProjCache)
 */
export function getDshSessions({ dshHome = null } = {}) {
  const home = resolveDshHome(dshHome);
  if (!fs.existsSync(home)) {
    return [];
  }

  const projCacheDir = path.join(home, "storages", "session_projcache", "sessions");
  if (!fs.existsSync(projCacheDir)) {
    return [];
  }

  const files = fs.readdirSync(projCacheDir).filter(f => f.endsWith(".json"));
  const sessions = [];

  for (const f of files) {
    try {
      const fullPath = path.join(projCacheDir, f);
      const stat = fs.statSync(fullPath);
      const raw = fs.readFileSync(fullPath, "utf-8");
      const d = JSON.parse(raw);
      const rec = d.record;
      if (!rec) continue;

      const sid = f.replace(/\.json$/, "");
      const createdAt = rec.identity?.createdAt || stat.birthtimeMs || stat.mtimeMs;
      const title = rec.rows?.title?.val || rec.rows?.titleInput?.val?.first?.text || sid;
      const tu = rec.rows?.tokenUsage?.val?.totals || {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0
      };
      const model = rec.rows?.modelSelection?.val?.lastUsed?.model || "deepseek-flash";
      const provider = rec.rows?.modelSelection?.val?.lastUsed?.provider || "deepseek-official";
      const stats = rec.rows?.sessionStats?.val || {};
      const turns = stats.turns || (rec.rows?.turnBoundary?.val ? 1 : 0);
      const steps = stats.steps || 0;

      const uncachedInput = Number(tu.uncachedInputTokens) || 0;
      const cachedTokens = (Number(tu.cacheReadTokens) || 0) + (Number(tu.cacheWriteTokens) || 0);
      const outputTokens = Number(tu.outputTokens) || 0;
      const totalTokens = uncachedInput + cachedTokens + outputTokens;
      const promptTokens = uncachedInput + cachedTokens;
      const hitRate = promptTokens > 0 ? (cachedTokens / promptTokens) : 0;

      // 依据模型与时段折算成本
      const cost = calculateTokenCost({
        modelName: model,
        promptTokens,
        replyTokens: outputTokens,
        cachedTokens,
        atMs: stat.mtimeMs
      });

      const isCompanion = /hakimi|哈基米|tomoko|智子|伴聊|qq|bridge|chat|bailong|白龙|whale|小鲸鱼|haena/i.test(title)
        || /hakimi|qq-bridge|agy[\\\/]chat|agy-qq-bridge/i.test(rec.identity?.cwd || "");

      sessions.push({
        sessionId: sid,
        title,
        cwd: rec.identity?.cwd || "",
        createdAt,
        updatedAt: stat.mtimeMs,
        lastModified: new Date(stat.mtimeMs).toISOString(),
        model,
        provider,
        modelName: cost.modelName,
        uncachedInputTokens: uncachedInput,
        cachedTokens,
        outputTokens,
        totalTokens,
        cacheHitRate: Number(hitRate.toFixed(4)),
        cacheHitPercent: Number((hitRate * 100).toFixed(1)),
        costCny: cost.costCny,
        costUsd: cost.costUsd,
        turns,
        steps,
        isCompanion
      });
    } catch {}
  }

  // 默认按最新更新时间倒序排列
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 实时同步 DSH (DeepSeek Harness) 伴聊大脑物理 Token 遥测与计费指标
 * 包含：物理总用量、KV Cache 提示词缓存命中率、物理新输入、回复输出、会话趋势与成本核算
 */
export async function getDshBrainTokenStats({
  days = 7,
  sessionId = null,
  dshHome = null,
  filterCompanion = true
} = {}) {
  const home = resolveDshHome(dshHome);
  if (!fs.existsSync(home)) {
    return {
      success: false,
      client: "dsh",
      reason: "dsh_home_not_found",
      dshHome: home
    };
  }

  const sessions = getDshSessions({ dshHome: home });
  if (sessions.length === 0) {
    return {
      success: false,
      client: "dsh",
      reason: "no_sessions_found",
      dshHome: home
    };
  }

  // 1. 确定目标焦点会话 (Target Session)
  let targetSession = null;
  if (sessionId) {
    targetSession = sessions.find(s => s.sessionId === sessionId);
  }
  if (!targetSession) {
    targetSession = sessions.find(s => s.isCompanion && s.totalTokens > 0)
      || sessions.find(s => s.isCompanion)
      || sessions.find(s => s.totalTokens > 0)
      || sessions[0];
  }

  // 2. 统计池筛选：若存在伴聊会话则优先聚合伴聊相关会话，否则聚合全部会话
  const companionSessions = sessions.filter(s => s.isCompanion);
  const targetPool = (filterCompanion && companionSessions.length > 0)
    ? companionSessions
    : sessions;

  let totalPhysical = 0;
  let totalInput = 0;
  let totalCache = 0;
  let totalOutput = 0;
  let totalCostCny = 0;
  let totalCostUsd = 0;
  let totalSteps = 0;
  let totalTurns = 0;

  const trendMap = new Map();

  for (const s of targetPool) {
    const sCostCny = Number(s.costCny) || 0;
    const sCostUsd = Number(s.costUsd) || 0;
    totalPhysical += (Number(s.totalTokens) || 0);
    totalInput += (Number(s.uncachedInputTokens) || 0);
    totalCache += (Number(s.cachedTokens) || 0);
    totalOutput += (Number(s.outputTokens) || 0);
    totalCostCny += sCostCny;
    totalCostUsd += sCostUsd;
    totalSteps += (Number(s.steps) || 0);
    totalTurns += (Number(s.turns) || 0);

    const date = new Date(s.createdAt).toISOString().slice(0, 10);
    if (!trendMap.has(date)) {
      trendMap.set(date, {
        date,
        turns: 0,
        steps: 0,
        tokens: 0,
        prompt_tokens: 0,
        reply_tokens: 0,
        cached_tokens: 0,
        cost_cny: 0,
        cost_usd: 0
      });
    }
    const day = trendMap.get(date);
    day.turns += (Number(s.turns) || 0);
    day.steps += (Number(s.steps) || 0);
    day.tokens += (Number(s.totalTokens) || 0);
    day.prompt_tokens += (Number(s.uncachedInputTokens) || 0);
    day.reply_tokens += (Number(s.outputTokens) || 0);
    day.cached_tokens += (Number(s.cachedTokens) || 0);
    day.cost_cny = Number((day.cost_cny + sCostCny).toFixed(4));
    day.cost_usd = Number((day.cost_usd + sCostUsd).toFixed(4));
  }

  const overallPrompt = totalInput + totalCache;
  const overallHitRate = overallPrompt > 0 ? (totalCache / overallPrompt) : 0;
  const trend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    success: true,
    client: "dsh",
    dshHome: home,
    sessionId: targetSession ? targetSession.sessionId : null,
    title: targetSession ? targetSession.title : null,
    model: targetSession ? targetSession.model : null,
    modelName: targetSession ? targetSession.modelName : null,
    totalTokens: totalPhysical,
    cachedTokens: totalCache,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheHitRate: Number(overallHitRate.toFixed(4)),
    cacheHitPercent: Number((overallHitRate * 100).toFixed(1)),
    costCny: Number(totalCostCny.toFixed(4)),
    costUsd: Number(totalCostUsd.toFixed(4)),
    steps: totalSteps,
    turns: totalTurns,
    trend,
    sessions,
    targetSession,
    companionSessions
  };
}
