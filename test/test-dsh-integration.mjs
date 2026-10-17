import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import {
  resolveModelPricing,
  calculateTokenCost,
  isPeakAtBeijing
} from "../src/pricing.mjs";

import {
  resolveDshHome,
  isDshAvailable,
  getDshSessions,
  getDshBrainTokenStats
} from "../src/dsh-discovery.mjs";

import {
  recordTokenUsage,
  getTokenUsageStats,
  getRecentTokenLogs
} from "../src/db.mjs";

import { createWebServer } from "../src/web-server.mjs";

console.log("=== 开始 DeepSeek Harness (DSH) 计费、发现与双端看板全项深度测试 ===");

// -------------------------------------------------------------
// 1. DeepSeek 系列模型阶梯价格与成本计算验证 (DSH Model Pricing)
// -------------------------------------------------------------
console.log("\n--- 1. 验证 DeepSeek 模型阶梯费率与别名解析 (Pricing & Aliases) ---");

// 1.1 别名模糊匹配与模型定位
const pV3 = resolveModelPricing("deepseek-chat");
assert(pV3.id === "deepseek-chat" || pV3.id === "deepseek-v3");
assert(pV3.name.includes("DeepSeek"));
assert.strictEqual(pV3.inputPerM, 0.14);

const pR1 = resolveModelPricing("deepseek-reasoner");
assert(pR1.id === "deepseek-reasoner" || pR1.id === "deepseek-r1");
assert(pR1.name.includes("DeepSeek"));
assert.strictEqual(pR1.inputPerM, 0.55);

const pFlash = resolveModelPricing("deepseek-flash");
assert.strictEqual(pFlash.id, "deepseek-flash");
assert.strictEqual(pFlash.useCnyDirect, true);
assert.strictEqual(pFlash.cnyInputPerM, 1.0);
assert.strictEqual(pFlash.cnyCachedInputPerM, 0.02);
assert.strictEqual(pFlash.cnyOutputPerM, 4.0);

const pFlashAlias = resolveModelPricing("deepseek-v4.1-flash");
assert.strictEqual(pFlashAlias.id, "deepseek-flash");

const pProAlias = resolveModelPricing("deepseek-v4-pro-0813");
assert.strictEqual(pProAlias.id, "deepseek-pro");
assert.strictEqual(pProAlias.cnyInputPerM, 4.5);

const pDshFallback = resolveModelPricing("dsh-companion-agent");
assert.strictEqual(pDshFallback.id, "deepseek-flash");
console.log("✅ DeepSeek 全系列模型 (V3/Chat, R1/Reasoner, Flash, Pro, DSH Fallback) 别名解析全部通过！");

// 1.2 DeepSeek Flash 原生 CNY 精确计费验证
const costFlash = calculateTokenCost({
  modelName: "deepseek-flash",
  promptTokens: 1000000, // 100万总输入
  cachedTokens: 800000,  // 80万命中缓存 (80% 命中)
  replyTokens: 100000    // 10万输出
});

// 未命中输入: 200k * 1.00 / 1M = 0.200000 CNY
// 缓存命中输入: 800k * 0.02 / 1M = 0.016000 CNY
// 输出生成: 100k * 4.00 / 1M = 0.400000 CNY
// 总成本: 0.20 + 0.016 + 0.40 = 0.616 CNY
assert.strictEqual(costFlash.costCny, 0.616);
assert(costFlash.costUsd > 0);
assert.strictEqual(costFlash.breakdown.uncachedPromptTokens, 200000);
assert.strictEqual(costFlash.breakdown.cachedTokens, 800000);
assert.strictEqual(costFlash.breakdown.costPromptCny, 0.2);
assert.strictEqual(costFlash.breakdown.costCachedCny, 0.016);
assert.strictEqual(costFlash.breakdown.costReplyCny, 0.4);
console.log(`✅ DeepSeek Flash 原生 CNY 计算精确吻合：1M 输入 (800k 缓存) + 100k 输出 = ¥${costFlash.costCny} ($${costFlash.costUsd})`);

// 1.3 DeepSeek V3 (Chat) 与 R1 (Reasoner) 原生 CNY 计算验证
const costV3 = calculateTokenCost({
  modelName: "deepseek-chat",
  promptTokens: 1000000,
  cachedTokens: 800000,
  replyTokens: 100000
});
// 200k * 1.0/1M (0.20) + 800k * 0.1/1M (0.08) + 100k * 2.0/1M (0.20) = 0.48 CNY
assert.strictEqual(costV3.costCny, 0.48);
assert.strictEqual(costV3.breakdown.costPromptCny, 0.2);
assert.strictEqual(costV3.breakdown.costCachedCny, 0.08);
assert.strictEqual(costV3.breakdown.costReplyCny, 0.2);

const costR1 = calculateTokenCost({
  modelName: "deepseek-reasoner",
  promptTokens: 1000000,
  cachedTokens: 800000,
  replyTokens: 100000
});
// 200k * 4.0/1M (0.80) + 800k * 1.0/1M (0.80) + 100k * 16.0/1M (1.60) = 3.20 CNY
assert.strictEqual(costR1.costCny, 3.2);
console.log(`✅ DeepSeek V3 (¥${costV3.costCny}) 与 R1 (¥${costR1.costCny}) 原生直接 CNY 计费校验通过！`);

// 1.4 北京时间峰谷分时定价与法定节假日验证
// 周六 10:00 (UTC 02:00) 判定为空闲时段
const saturdayMs = new Date("2026-10-17T02:00:00Z").getTime();
assert.strictEqual(isPeakAtBeijing(saturdayMs), false, "周六应判为空闲时段");

// 周四 国庆节法定节假日 10:00 (UTC 02:00) 判定为空闲时段（排除高峰加价）
const nationalDayMs = new Date("2026-10-01T02:00:00Z").getTime();
assert.strictEqual(isPeakAtBeijing(nationalDayMs), false, "国庆节虽为周四，但作为法定节假日应判为空闲时段");

// 普通周三 10:00 (UTC 02:00) 判定为高峰时段
const wednesdayPeakMs = new Date("2026-10-14T02:00:00Z").getTime();
assert.strictEqual(isPeakAtBeijing(wednesdayPeakMs), true, "普通周三上午 10:00 应判为高峰时段");

const costPeak = calculateTokenCost({
  modelName: "deepseek-flash",
  promptTokens: 1000000,
  cachedTokens: 800000,
  replyTokens: 100000,
  atMs: wednesdayPeakMs,
  customPricing: { applyPeakMultiplier: true, peakMultiplier: 2.0 }
});
assert.strictEqual(costPeak.peakFactor, 2.0);
assert.strictEqual(costPeak.costCny, Number((0.616 * 2).toFixed(6)));
console.log(`✅ 高峰时段 2 倍费率与法定节假日空闲豁免判定验证通过：¥${costPeak.costCny}`);

// -------------------------------------------------------------
// 2. DSH 本地 ProjCache 会话发现与审计 (DSH Projcache Discovery)
// -------------------------------------------------------------
console.log("\n--- 2. 验证 DSH 存储投影发现与会话 Token 遥测 (Discovery & Projcache) ---");

const dshHome = resolveDshHome();
assert(typeof dshHome === "string" && dshHome.length > 0, "DSH_HOME 必须有效解析");
console.log(`DSH Home 路径: ${dshHome}`);

if (isDshAvailable()) {
  const sessions = getDshSessions();
  assert(Array.isArray(sessions), "getDshSessions 必须返回数组");
  console.log(`✅ 检测到本地已安装 DSH，扫描到 ${sessions.length} 个历史会话`);

  if (sessions.length > 0) {
    const s0 = sessions[0];
    assert(s0.sessionId, "会话必须包含 sessionId");
    assert(s0.title, "会话必须包含 title");
    assert(typeof s0.totalTokens === "number", "totalTokens 必须为数字");
    assert(typeof s0.costCny === "number", "costCny 必须为数字");
    console.log(`   • 首个会话: ${s0.title} | 模型: ${s0.model} | 物理 Tokens: ${s0.totalTokens} | 成本: ¥${s0.costCny}`);
  }

  const brainStats = await getDshBrainTokenStats();
  assert.strictEqual(brainStats.success, true);
  assert.strictEqual(brainStats.client, "dsh");
  assert(brainStats.totalTokens >= 0, "totalTokens 必须非负");
  assert(brainStats.cachedTokens >= 0, "cachedTokens 必须非负");
  assert(brainStats.costCny >= 0, "costCny 必须非负");
  console.log(`✅ DSH 伴聊大脑物理用量探针聚合成功: ${brainStats.title || brainStats.sessionId} | 总量: ${(brainStats.totalTokens / 1e6).toFixed(2)}M Tokens (KV Cache: ${(brainStats.cachedTokens / 1e6).toFixed(2)}M, 命中率: ${brainStats.cacheHitPercent}%) | 成本: ¥${brainStats.costCny}`);
} else {
  console.log("ℹ️ 当前环境未安装真实 DSH，使用 Mock 目录验证扫描解析链路...");
  const tmpDsh = fs.mkdtempSync(path.join(os.tmpdir(), "mock-dsh-"));
  const mockSessionsDir = path.join(tmpDsh, "storages", "session_projcache", "sessions");
  fs.mkdirSync(mockSessionsDir, { recursive: true });

  const mockSessionFile = path.join(mockSessionsDir, "session-test-hakimi.json");
  fs.writeFileSync(mockSessionFile, JSON.stringify({
    record: {
      identity: { createdAt: Date.now(), cwd: "D:\\test\\hakimi" },
      rows: {
        title: { val: "哈基米伴聊测试会话" },
        tokenUsage: {
          val: {
            totals: {
              uncachedInputTokens: 50000,
              cacheReadTokens: 450000,
              cacheWriteTokens: 0,
              outputTokens: 25000
            }
          }
        },
        modelSelection: {
          val: {
            lastUsed: { model: "deepseek-flash", provider: "deepseek-official" }
          }
        },
        sessionStats: { val: { turns: 5, steps: 12 } }
      }
    }
  }), "utf-8");

  const mockStats = await getDshBrainTokenStats({ dshHome: tmpDsh });
  assert.strictEqual(mockStats.success, true);
  assert.strictEqual(mockStats.totalTokens, 525000);
  assert.strictEqual(mockStats.cachedTokens, 450000);
  assert.strictEqual(mockStats.inputTokens, 50000);
  assert.strictEqual(mockStats.outputTokens, 25000);
  assert.strictEqual(mockStats.cacheHitPercent, 90.0);
  assert.strictEqual(mockStats.turns, 5);
  assert.strictEqual(mockStats.steps, 12);
  fs.rmSync(tmpDsh, { recursive: true, force: true });
  console.log("✅ Mock DSH ProjCache 扫描与遥测聚合测试通过！");
}

// -------------------------------------------------------------
// 3. SQLite DB client 字段持久化与聚合统计 (DB Schema & Client Filter)
// -------------------------------------------------------------
console.log("\n--- 3. 验证 SQLite 存储支持 client 字段与独立筛选 (DB Integration) ---");

const testDshSession = "group:dsh_test_group";
const dshRecord = recordTokenUsage({
  sessionKey: testDshSession,
  groupId: 587071853,
  persona: "tomoko",
  client: "dsh",
  modelName: "deepseek-flash",
  promptText: "来自群友(123): 智子在吗？",
  replyText: "在的呢，有什么事呀！",
  promptChars: 20,
  replyChars: 12,
  estimatedPromptTokens: 1000,
  estimatedReplyTokens: 100,
  cachedTokens: 800
});

assert.strictEqual(dshRecord.client, "dsh", "client 字段必须为 dsh");
assert.strictEqual(dshRecord.modelName, "DeepSeek V4.1 Flash");
assert(dshRecord.costCny > 0, "必须生成有效 CNY 成本");

// 验证按 client 过滤聚合
const dshStats = getTokenUsageStats({ days: 1, client: "dsh" });
assert(dshStats.summary.total_turns >= 1, "client: 'dsh' 筛选应统计到该交互");

// 验证 client: "all" 联合统计全部客户端用量
const allClientStats = getTokenUsageStats({ days: 1, client: "all" });
assert(allClientStats.summary.total_turns >= dshStats.summary.total_turns, "client: 'all' 筛选必须包含所有客户端交互");

const recentLogs = getRecentTokenLogs(10, { client: "dsh" });
assert(recentLogs.some(l => l.client === "dsh"), "流水记录中必须包含 client 字段且值为 dsh");

const allLogs = getRecentTokenLogs(20, { client: "all" });
assert(Array.isArray(allLogs) && allLogs.length >= recentLogs.length, "client: 'all' 流水必须支持联合拉取");
console.log(`✅ SQLite 扩展 client 字段落盘与精准聚合过滤验证通过：${dshRecord.client} | 成本: ¥${dshRecord.costCny}`);

// -------------------------------------------------------------
// 4. Web Server REST API 双端兼容验证 (Web Server Dual-Engine APIs)
// -------------------------------------------------------------
console.log("\n--- 4. 验证 Web Server REST API /api/dsh/stats 与 /api/tokens/brain ---");

const testPort = 5133;
const webInstance = createWebServer({
  config: {
    web: { port: testPort, adminToken: "test-dsh-token", cors: true },
    antigravity: { agentPreset: "tomoko" }
  },
  eventBus: new EventEmitter(),
  daemonApi: null
});
await webInstance.start();

try {
  // 4.1 /api/dsh/stats
  const dshApiRes = await fetch(`http://127.0.0.1:${testPort}/api/dsh/stats`, {
    headers: { Authorization: "Bearer test-dsh-token" }
  });
  assert.strictEqual(dshApiRes.status, 200);
  const dshApiJson = await dshApiRes.json();
  assert.strictEqual(dshApiJson.success, true);
  assert(dshApiJson.data, "必须返回 data");
  console.log(`✅ GET /api/dsh/stats 响应成功: client = ${dshApiJson.data.client}`);

  // 4.2 /api/tokens/brain?client=dsh
  const brainDshRes = await fetch(`http://127.0.0.1:${testPort}/api/tokens/brain?client=dsh`, {
    headers: { Authorization: "Bearer test-dsh-token" }
  });
  assert.strictEqual(brainDshRes.status, 200);
  const brainDshJson = await brainDshRes.json();
  assert.strictEqual(brainDshJson.success, true);
  assert.strictEqual(brainDshJson.data.client, "dsh");
  console.log(`✅ GET /api/tokens/brain?client=dsh 返回 DSH 探针数据`);

  // 4.3 /api/tokens/brain (默认兼容 Antigravity)
  const brainDefaultRes = await fetch(`http://127.0.0.1:${testPort}/api/tokens/brain`, {
    headers: { Authorization: "Bearer test-dsh-token" }
  });
  assert.strictEqual(brainDefaultRes.status, 200);
  const brainDefaultJson = await brainDefaultRes.json();
  assert.strictEqual(brainDefaultJson.success, true);
  console.log(`✅ GET /api/tokens/brain 默认向后兼容 Antigravity 探针`);

  // 4.4 /api/tokens/stats 双端统一汇总
  const statsDualRes = await fetch(`http://127.0.0.1:${testPort}/api/tokens/stats`, {
    headers: { Authorization: "Bearer test-dsh-token" }
  });
  assert.strictEqual(statsDualRes.status, 200);
  const statsDualJson = await statsDualRes.json();
  assert.strictEqual(statsDualJson.success, true);
  assert(statsDualJson.data.antigravityBrain !== undefined, "必须包含 antigravityBrain");
  assert(statsDualJson.data.dshBrain !== undefined, "必须包含 dshBrain");
  console.log(`✅ GET /api/tokens/stats 双端大脑载荷结构校验完全通过！`);
} finally {
  webInstance.stop();
}

console.log("\n🎉 DeepSeek Harness (DSH) 计费、发现与双端看板全项深度测试全部通过！");
