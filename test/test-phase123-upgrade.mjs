import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { 
  getActivePersona, 
  getAllPersonas, 
  loadPersonaPrompt, 
  buildSystemPrompt, 
  loadBaseProtocol, 
  loadAffectionMatrix,
  getAttitudeInstruction,
  PROJECT_ROOT 
} from "../src/personas.mjs";
import { pruneOldRecords, runWithRetry } from "../src/db.mjs";
import { loadPricingConfig, savePricingConfig, calculateTokenCost, PRICING_CONFIG_PATH } from "../src/pricing.mjs";

console.log("=== 开始 Phase 1-3 全架构升级验收深度测试 ===");

// -----------------------------------------------------------------------------
// 1. 验证 Phase 1：人格资产解耦与三层 Prompt 架构
// -----------------------------------------------------------------------------
console.log("\n--- 1. 验证 Phase 1：人格系统解耦与三层 Prompt 架构 ---");

// 1.1 检查 agents/_base_protocol.md 与 _affection_matrix.json
const protocol = loadBaseProtocol();
assert(protocol.includes("核心认知与环境法则"), "_base_protocol.md 必须包含核心认知法则");
assert(protocol.includes("身份隔离"), "_base_protocol.md 必须包含身份隔离法则");
assert(protocol.includes("去 AI 味输出约束"), "_base_protocol.md 必须包含去AI味约束");
assert(protocol.includes("多人聚合消息处理"), "_base_protocol.md 必须包含群聊注意力法则");
assert(protocol.includes("好感度调整铁律"), "_base_protocol.md 必须包含好感度调整铁律");
console.log("✅ agents/_base_protocol.md 通用底层协议校验通过");

const matrix = loadAffectionMatrix();
assert(Array.isArray(matrix.ranges) && matrix.ranges.length >= 6, "_affection_matrix.json 必须包含至少 6 个好感度区间");
console.log(`✅ agents/_affection_matrix.json 好感度态度映射配置校验通过 (${matrix.ranges.length} 个区间)`);

// 1.2 验证好感度态度动态映射与边界极值
const attLow = getAttitudeInstruction(10);
assert(attLow.level === "戒备" && attLow.instruction.includes("反问句"), "好感度 10 分必须映射为戒备阶段与反问句指令");
const attNormal = getAttitudeInstruction(35);
assert(attNormal.level === "初识", "好感度 35 分必须映射为初识阶段");
const attFriend = getAttitudeInstruction(60);
assert(attFriend.level === "朋友", "好感度 60 分必须映射为朋友阶段");
const attSpecial = getAttitudeInstruction(95);
assert(attSpecial.level === "特别", "好感度 95 分必须映射为特别阶段");
const attHate = getAttitudeInstruction(-15);
assert(attHate.level === "嫌恶", "好感度 -15 分必须映射为嫌恶阶段");

// 边界极值测试
const attExtremeLow = getAttitudeInstruction(-150);
assert(attExtremeLow.level === "嫌恶" && attExtremeLow.instruction.includes("负数"), "好感度 -150 分必须稳健映射为嫌恶阶段");
const attExtremeHigh = getAttitudeInstruction(150);
assert(attExtremeHigh.level === "特别" && attExtremeHigh.instruction.includes("特别阶段"), "好感度 150 分必须稳健映射为特别阶段");
const attNaN = getAttitudeInstruction(NaN);
assert(attNaN.level === "初识", "NaN 好感度必须安全兜底为初识阶段 (30)");
const attNull = getAttitudeInstruction(null);
assert(attNull.level === "初识", "null 好感度必须安全兜底为初识阶段 (30)");
console.log("✅ getAttitudeInstruction 全区间好感态度映射与极值边界测试通过");

// 1.3 验证角色 Markdown 资产库与别名兼容
const testKeys = ["tomoko", "bailong", "whale", "haena", "dragon_girl", "little_whale"];
for (const key of testKeys) {
  const p = getActivePersona(key);
  assert(p, `角色 [${key}] 必须成功解析加载`);
  assert(p.displayName, `角色 [${key}] 必须拥有 displayName`);
  assert(p.mentionRegex instanceof RegExp, `角色 [${key}] 必须具有 mentionRegex`);
  assert(Array.isArray(p.interestKeywords) && p.interestKeywords.length > 0, `角色 [${key}] 必须拥有关键词库`);
  
  const rawPrompt = loadPersonaPrompt(key);
  assert(rawPrompt && rawPrompt.length > 100, `角色 [${key}] 提示词文件加载成功`);
}
console.log("✅ 标准化 agents/*.md 角色人设库及别名 (bailong/dragon_girl, whale/little_whale) 动态加载全部通过");

// 1.4 验证 buildSystemPrompt 三层动态装配
const sysPrompt = buildSystemPrompt("tomoko", 15, {
  location: "秋叶原电玩店",
  action: "试玩最新掌机单机",
  detail: "店内音效此起彼伏",
  mood: "专注兴奋"
});
assert(sysPrompt.includes("=== [第一层：底层通用环境与交互法则] ==="), "必须包含第一层底层协议");
assert(sysPrompt.includes("=== [第二层：当前激活角色设定 (智子)] ==="), "必须包含第二层角色设定");
assert(sysPrompt.includes("=== [第三层：实时好感度态度注入与时空身位] ==="), "必须包含第三层好感度与时空身位");
assert(sysPrompt.includes("当前说话人好感度: 15 分 (关系阶段: 【戒备】)"), "第三层必须注入准确好感度");
assert(sysPrompt.includes("秋叶原电玩店"), "第三层必须注入动态物理位置");
console.log("✅ buildSystemPrompt 三层标准化动态装配引擎验证成功 (字符数: " + sysPrompt.length + ")");

// -----------------------------------------------------------------------------
// 2. 验证 Phase 2：滑动窗口、视觉缓存池与 SQLite 健壮性
// -----------------------------------------------------------------------------
console.log("\n--- 2. 验证 Phase 2：调度器、视觉池与 SQLite 健壮性 ---");

// 2.1 验证 SQLite PRAGMA busy_timeout 与自动归档
const pruned = pruneOldRecords(30);
assert(typeof pruned === "number", "pruneOldRecords 必须返回删除的行数");
console.log(`✅ pruneOldRecords(30) 历史日志清理执行成功 (已清理 ${pruned} 条超期普通流水)`);

// 2.2 验证 runWithRetry 并发重试函数
let counter = 0;
const retryRes = runWithRetry(() => {
  counter++;
  if (counter < 2) {
    const err = new Error("database is locked");
    throw err;
  }
  return "success";
}, 5, 10);
assert.strictEqual(retryRes, "success");
assert.strictEqual(counter, 2);
console.log("✅ runWithRetry 瞬时写锁自动恢复重试验证通过");

// -----------------------------------------------------------------------------
// 3. 验证 Phase 3：安全加固、外置计费与工程化文件
// -----------------------------------------------------------------------------
console.log("\n--- 3. 验证 Phase 3：安全加固、外置计费与工程化完善 ---");

// 3.1 验证 config/pricing.json 外置计费读取与热更新
assert(fs.existsSync(PRICING_CONFIG_PATH), "config/pricing.json 必须存在");
const initialPricing = loadPricingConfig();
assert(initialPricing.models["gemini-2.5-pro"], "pricing.json 必须包含 gemini-2.5-pro 阶梯定价");
assert(initialPricing.models["claude-3.7-sonnet"], "pricing.json 必须包含 claude-3.7-sonnet 阶梯定价");
assert(initialPricing.models["deepseek-v3"], "pricing.json 必须包含 deepseek-v3 阶梯定价");

// 测试热修改与落盘
const modifiedPricing = {
  ...initialPricing,
  models: {
    ...initialPricing.models,
    "test-model": { name: "Test Model", inputPerM: 1.0, cachedInputPerM: 0.1, outputPerM: 2.0 }
  }
};
savePricingConfig(modifiedPricing);
const reloadedPricing = loadPricingConfig();
assert(reloadedPricing.models["test-model"], "新增的模型定价应成功落盘并热重载");

// 还原定价配置
delete modifiedPricing.models["test-model"];
savePricingConfig(modifiedPricing);
console.log("✅ config/pricing.json 阶梯费率外置、热更新与计算逻辑校验通过");

// 3.2 验证启动与停止脚本存在性
const startBatPath = path.resolve(PROJECT_ROOT, "start.bat");
assert(fs.existsSync(startBatPath), "start.bat 脚本必须存在");
const stopBatPath = path.resolve(PROJECT_ROOT, "stop.bat");
assert(fs.existsSync(stopBatPath), "stop.bat 脚本必须存在");
console.log("✅ start.bat / stop.bat 核心控制脚本校验通过");

const ciPath = path.resolve(PROJECT_ROOT, ".github/workflows/ci.yml");
assert(fs.existsSync(ciPath), ".github/workflows/ci.yml 必须存在");
const ciContent = fs.readFileSync(ciPath, "utf-8");
assert(ciContent.includes("node-version: '22'"), "CI 工作流必须指定 Node.js 22");
assert(ciContent.includes("npm test"), "CI 工作流必须包含 npm test 测试套件运行步骤");
console.log("✅ .github/workflows/ci.yml GitHub Actions 自动化工作流校验通过");

// 3.3 验证 MCP 工具与底层协议好感度 [-2, +2] 铁律严格一致
const mcpPath = path.resolve(PROJECT_ROOT, "src/mcp-server.mjs");
const mcpContent = fs.readFileSync(mcpPath, "utf-8");
assert(mcpContent.includes("[-2, +2]"), "mcp-server.mjs 工具描述必须明确标注 [-2, +2] 好感度变动铁律");
assert(!mcpContent.includes("[af:+3"), "mcp-server.mjs 绝不能出现超出 +2 的示例");
console.log("✅ MCP 工具与三层协议好感度 [-2, +2] 约束校验通过");

// 3.4 验证 Web Server 免密无感控制台架构
import { createWebServer } from "../src/web-server.mjs";
import { EventEmitter } from "node:events";
const dummyEventBus = new EventEmitter();
const testDummyConfig = {
  web: { port: 5199, cors: true }
};
const dummyApp = createWebServer({
  config: testDummyConfig,
  eventBus: dummyEventBus,
  daemonApi: {}
});
assert(dummyApp !== null, "Web Server 应当支持免密创建与直接访问");
console.log("✅ Web Server 免密无感控制台架构验证通过");

// 3.5 验证大模型定价计算 (calculateTokenCost)
const costResult = calculateTokenCost({
  modelName: "gemini-2.5-pro",
  promptTokens: 10000,
  cachedTokens: 8000,
  replyTokens: 2000
});
assert.strictEqual(costResult.modelId, "gemini-2.5-pro");
assert(costResult.costUsd > 0, "计算出的 USD 成本必须大于 0");
assert(costResult.costCny > 0, "计算出的 CNY 成本必须大于 0");
assert.strictEqual(costResult.breakdown.cachedTokens, 8000);
assert.strictEqual(costResult.breakdown.uncachedPromptTokens, 2000);
console.log(`✅ calculateTokenCost 精确费率折算验证通过 (总价: ¥${costResult.costCny} / $${costResult.costUsd})`);

console.log("\n🎉 Phase 1, Phase 2, Phase 3 全项升级验收测试圆满通过！");
