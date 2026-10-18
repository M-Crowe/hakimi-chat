import assert from "node:assert";
import { 
  recordTokenUsage, 
  getTokenUsageStats, 
  getRecentTokenLogs, 
  estimateTokens,
  cleanTestTokenLogs 
} from "../src/db.mjs";
import { 
  calculateTokenCost, 
  resolveModelPricing, 
  STANDARD_MODEL_PRICING 
} from "../src/pricing.mjs";
import { 
  processOutboundMessage, 
  checkAntigravityQuota 
} from "../src/bridge-daemon.mjs";
import { AgyConnectRpcClient } from "../src/connect-rpc-client.mjs";
import { queryLanguageServerQuota } from "../src/antigravity-discovery.mjs";
import { createWebServer } from "../src/web-server.mjs";
import { EventEmitter } from "node:events";

console.log("=== 开始 Token 监测升级与配额防爆全项深度测试 (Token Upgrade & Quota Probe Test) ===");

// -------------------------------------------------------------
// 1. 模型价格字典与成本计算器验证 (Pricing & Cost Calculator)
// -------------------------------------------------------------
console.log("\n--- 1. 验证模型价格字典与成本计算 (Pricing & Cost Calculation) ---");

// 1.1 标准模型匹配与别名模糊识别
const pricingPro = resolveModelPricing("gemini-2.5-pro");
assert.strictEqual(pricingPro.id, "gemini-2.5-pro");
assert.strictEqual(pricingPro.inputPerM, 1.25);
assert.strictEqual(pricingPro.outputPerM, 5.00);

const pricingFlashAlias = resolveModelPricing("gemini-3.8-flash-high");
assert.strictEqual(pricingFlashAlias.id, "gemini-2.5-flash");

const pricingSonnetAlias = resolveModelPricing("claude-sonnet-4.6");
assert.strictEqual(pricingSonnetAlias.id, "claude-3.7-sonnet");

const pricingR1Alias = resolveModelPricing("deepseek-reasoner-r1");
assert.strictEqual(pricingR1Alias.id, "deepseek-r1");

// 1.2 成本计算：输入、前缀缓存折扣、输出 (含思考/推理)
const costTest = calculateTokenCost({
  modelName: "gemini-2.5-pro",
  promptTokens: 10000,
  replyTokens: 2000,
  cachedTokens: 8000,
  customPricing: { exchangeRateUsdToCny: 7.2 }
});
// 未命中输入: 2000 * 1.25 / 1M = 0.0025
// 缓存命中输入: 8000 * 0.3125 / 1M = 0.0025
// 输出: 2000 * 5.00 / 1M = 0.0100
// 总 USD: 0.0150
// 总 CNY: 0.0150 * 7.2 = 0.1080
assert.strictEqual(costTest.costUsd, 0.015);
assert.strictEqual(costTest.costCny, 0.108);
assert.strictEqual(costTest.breakdown.uncachedPromptTokens, 2000);
assert.strictEqual(costTest.breakdown.cachedTokens, 8000);
assert.strictEqual(costTest.breakdown.replyTokens, 2000);
console.log(`✅ 模型成本计算精确吻合：10k 输入 (8k 缓存) + 2k 输出 = $${costTest.costUsd} (¥${costTest.costCny})`);

// -------------------------------------------------------------
// 2. 思考推理 Token 与生成速率 (tok/s) 数据库落盘验证
// -------------------------------------------------------------
console.log("\n--- 2. 验证思考 Token、吞吐速率 (tok/s) 与 SQLite 存储 (DB Schema & Storage) ---");

const testSessionKey = "group:999888111";
const reasoningText = "让我想想，用户询问关于量子计算的问题，需要用通俗的比喻解释叠加态与纠缠...";
const replyVisibleText = "量子计算就像是能同时抛无数枚硬币并在空中得出结果的神奇计算机呢！";
const fullModelOutput = `<think>\n${reasoningText}\n</think>\n<reply>${replyVisibleText}</reply>`;

const estThinkTokens = estimateTokens(reasoningText);
const estTotalReplyTokens = estimateTokens(fullModelOutput);

const durationMs = 2500; // 2.5 秒
const expectedTps = Number((estTotalReplyTokens / (durationMs / 1000)).toFixed(1));

const recorded = recordTokenUsage({
  sessionKey: testSessionKey,
  groupId: 999888111,
  persona: "tomoko",
  promptText: "来自群友(123): 你好智子，能解释一下量子计算吗？",
  replyText: fullModelOutput,
  reasoningTokens: estThinkTokens,
  durationMs,
  modelName: "claude-3.7-sonnet"
});

assert.strictEqual(recorded.reasoningTokens, estThinkTokens, "思考推理 Token 必须精准落盘");
assert.strictEqual(recorded.durationMs, 2500, "耗时 duration_ms 应为 2500ms");
assert.strictEqual(recorded.throughputTps, expectedTps, `生成速率应匹配 ${expectedTps} tok/s`);
assert(recorded.costCny > 0, "应自动计算出有效 CNY 成本");
assert(recorded.costUsd > 0, "应自动计算出有效 USD 成本");
assert.strictEqual(recorded.modelName, "Claude 3.7 Sonnet (Hybrid)");

console.log(`✅ 单次交互落盘成功：总输出 ${recorded.replyTokens} T (含思考 ${recorded.reasoningTokens} T) | 速率: ${recorded.throughputTps} tok/s | 成本: ¥${recorded.costCny}`);

// 验证统计聚合查询 (getTokenUsageStats)
const stats = getTokenUsageStats({ days: 1, groupId: 999888111 });
assert(stats.summary.total_turns >= 1);
assert(stats.summary.total_reasoning_tokens >= estThinkTokens, "汇总中应包含思考 Token 总量");
assert(stats.summary.avg_throughput_tps > 0, "汇总中应计算平均生成速率");
assert(stats.summary.total_cost_cny > 0, "汇总中应包含累计人民币成本");
assert(stats.summary.total_cost_usd > 0, "汇总中应包含累计美元成本");

// 验证流水记录查询 (getRecentTokenLogs)
const recent = getRecentTokenLogs(5);
const latestLog = recent.find(l => l.session_key === testSessionKey);
assert(latestLog, "流水记录应包含刚才写入的记录");
assert.strictEqual(latestLog.reasoning_tokens, estThinkTokens);
assert.strictEqual(latestLog.duration_ms, 2500);
assert.strictEqual(latestLog.throughput_tps, expectedTps);
assert(latestLog.cost_cny > 0);
assert.strictEqual(latestLog.model_name, "Claude 3.7 Sonnet (Hybrid)");
console.log("✅ getTokenUsageStats 与 getRecentTokenLogs 扩展字段聚合查询全部通过！");

// -------------------------------------------------------------
// 3. 真实出站拦截与思考推理剥离管线 (processOutboundMessage)
// -------------------------------------------------------------
console.log("\n--- 3. 验证出站拦截思考标签剥离与 Token 统计管线 (processOutboundMessage Pipeline) ---");

const complexAiOutput = `<think>
仔细分析群友的问题：这是一道数学脑筋急转弯，答案是8个人。
思考过程必须严格保密，不能泄露给群友。
</think>
<social_decision>
ACTION: REPLY
</social_decision>
<reply>答案是8个人哦！</reply>`;

const cleaned = processOutboundMessage("group:587071853", 10001, complexAiOutput, {
  durationMs: 1800,
  modelName: "gemini-2.5-pro"
});

assert(!cleaned.includes("<think>"), "出站消息绝对不能包含 <think> 标签");
assert(!cleaned.includes("仔细分析群友的问题"), "出站消息绝对不能泄露思考内容");
assert(!cleaned.includes("<social_decision>"), "出站消息绝对不能泄露社交决策");
assert.strictEqual(cleaned, "答案是8个人哦！", "出站纯净声音提取应完全精准");
console.log("✅ processOutboundMessage 思考标签安全剥离与出站净化测试通过！");

// 3.1 验证 <thinking> (Claude extended thinking) 剥离与 Token 自动提取
const claudeThinkingOutput = `<thinking>
需要深入分析量子纠缠的物理机制与爱因斯坦EPR佯谬。
</thinking>
<reply>这是量子纠缠的解释。</reply>`;
const cleanedClaude = processOutboundMessage("group:587071853", 10002, claudeThinkingOutput);
assert(!cleanedClaude.includes("<thinking>"), "出站消息绝对不能包含 <thinking> 标签");
assert(!cleanedClaude.includes("爱因斯坦EPR佯谬"), "出站消息不能泄露思考内容");
assert.strictEqual(cleanedClaude, "这是量子纠缠的解释。");
console.log("✅ Claude <thinking> 标签自动剥离与出站净化验证通过！");

// 3.2 验证当 replyText 已经剥离思考标签且传入显式 reasoningTokens 时，estimated_reply_tokens 为总输出 (visible + reasoning)
const visibleOnlyText = "这是纯净的可见回复内容";
const visibleTokens = estimateTokens(visibleOnlyText);
const explicitReasoning = 60;
const recordedVisible = recordTokenUsage({
  sessionKey: "group:999888222",
  promptText: "你好",
  replyText: visibleOnlyText,
  reasoningTokens: explicitReasoning,
  durationMs: 1000
});
assert.strictEqual(recordedVisible.reasoningTokens, explicitReasoning);
assert.strictEqual(recordedVisible.replyTokens, visibleTokens + explicitReasoning, "estimated_reply_tokens 必须包含可见回复与推理 Tokens 总和");
assert.strictEqual(recordedVisible.totalTokens, recordedVisible.promptTokens + recordedVisible.replyTokens);
console.log(`✅ 标准模型 API 规范对齐验证通过：总输出 ${recordedVisible.replyTokens} T = 可见 ${visibleTokens} T + 思考 ${explicitReasoning} T`);

// 3.3 验证用户自定义模型定价字典覆盖 (Custom Pricing Override)
const customModelRecord = recordTokenUsage({
  sessionKey: "group:999888333",
  promptText: "测试自定义模型价格",
  replyText: "这是自定义模型输出",
  modelName: "my-custom-model",
  customPricing: {
    exchangeRateUsdToCny: 8.0,
    models: {
      "my-custom-model": {
        name: "My Custom Model",
        inputPerM: 10.0,
        cachedInputPerM: 2.0,
        outputPerM: 20.0
      }
    }
  }
});
assert.strictEqual(customModelRecord.modelName, "My Custom Model");
assert(customModelRecord.costUsd > 0 && customModelRecord.costCny > 0);
console.log(`✅ 自定义定价覆盖与汇率生效验证通过：${customModelRecord.modelName} | 成本: ¥${customModelRecord.costCny} ($${customModelRecord.costUsd})`);

// -------------------------------------------------------------
// 4. Antigravity Loopback 配额探针与防爆熔断逻辑验证
// -------------------------------------------------------------
console.log("\n--- 4. 验证 Antigravity 本地环回配额探针与防爆熔断 (Quota Probe & Anti-Exhaustion) ---");

const rpcClient = new AgyConnectRpcClient();
const quotaHealth = await rpcClient.getCombinedQuotaHealth(true);
if (quotaHealth.success) {
  assert(Array.isArray(quotaHealth.groups), "应返回配额模型分组列表");
  assert(quotaHealth.groups.length >= 1, "应至少包含 Gemini 或 Claude 模型分组");
  assert(typeof quotaHealth.lowestRemainingPercent === "number", "应包含最低窗口余量百分比");
  assert(typeof quotaHealth.isThrottled === "boolean", "应包含限流防爆标志");
  assert(typeof quotaHealth.isExhausted === "boolean", "应包含耗尽标志");

  // 验证发现模块别名探针
  const discoveryQuota = await queryLanguageServerQuota();
  assert.strictEqual(discoveryQuota.success, true);
  console.log(`✅ Antigravity 配额探针探测成功！当前最低窗口余量: ${quotaHealth.lowestRemainingPercent}% | 防爆熔断: ${quotaHealth.isThrottled ? '已熔断' : '健康巡航'}`);
} else {
  console.log("ℹ️ 当前测试环境未连通 Antigravity Language Server，已安全降级测试");
}

// 4.1 验证探针异常安全降级：错误 CSRF 令牌绝不能误报为 100% 成功
const badClient = new AgyConnectRpcClient("http://127.0.0.1:1708", "invalid-csrf-token");
const badQuota = await badClient.getUserQuotaSummary();
assert.strictEqual(badQuota.success, false, "错误 CSRF 令牌时 success 必须为 false");
assert.notStrictEqual(badQuota.lowestRemainingPercent, 100, "探针异常绝不能虚假返回 100% 配额健康");
console.log("✅ 异常探针安全降级验证通过 (错误令牌不误报 100% 健康)");

// 4.2 验证速率限制 (429 / resource_exhausted) 触发防爆熔断
const mockRateLimitClient = new AgyConnectRpcClient();
mockRateLimitClient.callRpc = async () => {
  const err = new Error("resource_exhausted: quota exceeded (HTTP 429)");
  err.code = "resource_exhausted";
  throw err;
};
const rateLimitedQuota = await mockRateLimitClient.getUserQuotaSummary();
assert.strictEqual(rateLimitedQuota.success, false);
assert.strictEqual(rateLimitedQuota.isThrottled, true, "触发 resource_exhausted 时必须标记 isThrottled 为 true");
assert.strictEqual(rateLimitedQuota.isExhausted, true, "触发 resource_exhausted 时必须标记 isExhausted 为 true");
console.log("✅ 速率与配额超限 (Resource Exhausted) 智能熔断保护验证通过！");

// -------------------------------------------------------------
// 5. Web Server /api/antigravity/quota 接口端点验证
// -------------------------------------------------------------
console.log("\n--- 5. 验证 Web Server REST API /api/antigravity/quota ---");

const testPort = 5129;
const mockEventBus = new EventEmitter();
const mockDaemonApi = {
  getSnowLumaStatus: () => ({ connected: true, botQqId: 123456 }),
  getActiveSessions: () => [],
  getQuotaStatus: async (force) => await checkAntigravityQuota(force)
};

const web = createWebServer({
  config: {
    web: { port: testPort, adminToken: "test-token", cors: true },
    antigravity: { agentPreset: "tomoko" }
  },
  eventBus: mockEventBus,
  daemonApi: mockDaemonApi
});

await web.start();

const res = await fetch(`http://127.0.0.1:${testPort}/api/antigravity/quota`, {
  headers: { "Authorization": "Bearer test-token" }
});
assert.strictEqual(res.status, 200, "配额接口应返回 HTTP 200");
const resJson = await res.json();
assert.strictEqual(resJson.success, true);
assert(resJson.data);
assert(typeof resJson.data.lowestRemainingPercent === "number");
console.log("✅ Web API /api/antigravity/quota 响应结构与鉴权验证通过！");

// -------------------------------------------------------------
// 6. Antigravity 伴聊大脑物理用量 (IDE Token Monitor 对齐) 验证
// -------------------------------------------------------------
console.log("\n--- 6. 验证 Antigravity 伴聊大脑物理用量 (IDE Token Monitor 对齐) ---");
const { getAntigravityBrainTokenStats } = await import("../src/antigravity-discovery.mjs");
const brainStats = await getAntigravityBrainTokenStats();
assert(brainStats);
if (brainStats.success) {
  assert(typeof brainStats.totalTokens === "number", "totalTokens 必须为数字");
  assert(brainStats.totalTokens > 0, "物理用量必须大于 0");
  assert(typeof brainStats.cachedTokens === "number", "cachedTokens 必须为数字");
  assert(typeof brainStats.inputTokens === "number", "inputTokens 必须为数字");
  assert(typeof brainStats.outputTokens === "number", "outputTokens 必须为数字");
  assert(typeof brainStats.cacheHitRate === "number", "cacheHitRate 必须为数字");
  assert(Array.isArray(brainStats.trend), "trend 必须为数组");
  assert(Array.isArray(brainStats.recentSteps), "recentSteps 必须为数组");
  console.log(`✅ Antigravity 大脑物理用量探针验证成功: ${brainStats.title} | 总量: ${(brainStats.totalTokens / 1000000).toFixed(2)}M Tokens (KV Cache: ${(brainStats.cachedTokens / 1000000).toFixed(2)}M, 命中率: ${brainStats.cacheHitPercent}%) | 步数: ${brainStats.steps}`);
} else {
  console.log("ℹ️ 当前环境未发现运行中的伴聊会话 transcript (安全降级)");
}

// 6.1 验证 Web API /api/tokens/stats 与 /api/tokens/brain 携带 antigravityBrain
const statsRes = await fetch(`http://127.0.0.1:${testPort}/api/tokens/stats`, {
  headers: { "Authorization": "Bearer test-token" }
});
assert.strictEqual(statsRes.status, 200);
const statsJson = await statsRes.json();
assert.strictEqual(statsJson.success, true);
assert(statsJson.data.antigravityBrain !== undefined, "stats 必须携带 antigravityBrain 字段");

const brainRes = await fetch(`http://127.0.0.1:${testPort}/api/tokens/brain`, {
  headers: { "Authorization": "Bearer test-token" }
});
assert.strictEqual(brainRes.status, 200);
const brainJson = await brainRes.json();
assert.strictEqual(brainJson.success, true);
assert(brainJson.data !== undefined);
console.log("✅ Web API /api/tokens/stats 与 /api/tokens/brain 物理用量集成测试通过！");

await web.stop();
cleanTestTokenLogs();

console.log("\n🎉 Token 监测系统升级与配额防爆全项深度测试全部通过！");
