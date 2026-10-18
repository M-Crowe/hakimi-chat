import assert from "node:assert";
import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCharacterState,
  updateCharacterLocation,
  initManagedGroups,
  getManagedGroups,
  getManagedGroup,
  saveManagedGroup,
  deleteManagedGroup,
  toggleGroupEnabled,
  setUserAffinity,
  getUserAffinity,
  deleteUserAffinity,
  getAllSessionMemories,
  saveSessionMemory,
  deleteSessionMemory,
  getAllSlangs,
  createSlang,
  updateSlang,
  deleteSlang,
  recordTokenUsage,
  getTokenUsageStats,
  getRecentTokenLogs,
  estimateTokens,
  recordChatMessage,
  getRecentChatMessages,
  cleanTestTokenLogs
} from "../src/db.mjs";

import {
  getAllPersonas,
  getActivePersona,
  loadPersonaPrompt,
  savePersonaPrompt
} from "../src/personas.mjs";

import { createWebServer } from "../src/web-server.mjs";
import { cleanImagesFifo } from "../src/bridge-daemon.mjs";
import { EventEmitter } from "node:events";

console.log("=== 开始哈基米聊天系统 (Hakimi Chat System) 全模块综合自动化测试 ===");

// 1. 测试 SQLite 数据层：群组管理 CRUD 与独立启闭
console.log("\n--- 1. 验证群组管理中心 (Group Management) ---");
initManagedGroups([587071853, 999888777]);
let groups = getManagedGroups();
assert(groups.length >= 2, "初始群组初始化应至少有 2 个群");
const testGid = 88812345;
saveManagedGroup(testGid, "测试交流群", true, "strict");
let group = getManagedGroup(testGid);
assert.strictEqual(group.group_name, "测试交流群", "群名称应为'测试交流群'");
assert.strictEqual(group.enabled, true, "群应为启用状态");
assert.strictEqual(group.trigger_policy, "strict", "群策略应为'strict'");

// 切换独立开关
toggleGroupEnabled(testGid, false);
group = getManagedGroup(testGid);
assert.strictEqual(group.enabled, false, "群独立开关应切换为 false");

// 更新策略
saveManagedGroup(testGid, "测试修改群", true, "all");
group = getManagedGroup(testGid);
assert.strictEqual(group.group_name, "测试修改群");
assert.strictEqual(group.enabled, true);
assert.strictEqual(group.trigger_policy, "all");

// 验证省略 group_name 时安全保留既有名称 (防覆盖 Bug)
saveManagedGroup(testGid, "", false, "strict");
group = getManagedGroup(testGid);
assert.strictEqual(group.group_name, "测试修改群", "省略 group_name 时既有群名必须安全保留");
assert.strictEqual(group.enabled, false);
assert.strictEqual(group.trigger_policy, "strict");

// 删除群
deleteManagedGroup(testGid);
assert.strictEqual(getManagedGroup(testGid), null, "群删除后应返回 null");
console.log("✅ 群组白名单 CRUD、独立启闭开关与触发策略验证全部通过！");

// 2. 测试 Token 估算与双轨统计
console.log("\n--- 2. 验证 Token 消耗与用量监测 (Token Monitoring) ---");
// 2.1 验证校准后的 CJK (1.65) 与英文/符号估算
const cjkOnly = "哈基米";
const estCjk = estimateTokens(cjkOnly);
assert.strictEqual(estCjk, Math.ceil(3 * 1.65), "3个汉字应为 ceil(3 * 1.65) = 5 Tokens");

const mixedText = "Hello World! 你好";
const estMixed = estimateTokens(mixedText);
// words: 2 * 1.3 = 2.6, symbols: 1 * 0.5 = 0.5, cjk: 2 * 1.65 = 3.3. Total = 6.4 -> 7
assert.strictEqual(estMixed, Math.ceil(2 * 1.65 + 2 * 1.3 + 1 * 0.5));

const punctOnly = "...!?,@#";
const estPunct = estimateTokens(punctOnly);
assert.strictEqual(estPunct, Math.ceil(8 * 0.5), "纯标点符号应计算符号系数 0.5，且不计入单词数");

const structuredPrompt = "[系统设定与人设卡规范: 你是智子...]\n【最近滚动历史】\n来自群友(12345)的最新发言: \"吃了吗？\"";
const structuredReply = "麦茶和单机，还没吃晚餐呢";
const estPrefix = estimateTokens("[系统设定与人设卡规范: 你是智子...]\n【最近滚动历史】");
const tokenPrefixRow = recordTokenUsage({
  sessionKey: "group:88812345",
  groupId: 88812345,
  persona: "tomoko",
  promptText: structuredPrompt,
  replyText: structuredReply
});
assert.strictEqual(tokenPrefixRow.cachedTokens, estPrefix, "结构化前缀缓存应精确匹配最新发言前的系统与历史文本 Token");
assert(tokenPrefixRow.cacheHitRate > 0.5, "长前缀人设历史在总提示词中应占比超过 50%");
assert.strictEqual(tokenPrefixRow.totalTokens, tokenPrefixRow.cachedTokens + (tokenPrefixRow.newTokens - tokenPrefixRow.replyTokens) + tokenPrefixRow.replyTokens, "总Token数应与新旧分轨吻合");

const stats = getTokenUsageStats({ days: 1, groupId: 88812345 });
assert(stats.summary.total_turns >= 1, "今日应有统计轮次");
assert(stats.summary.total_tokens >= tokenPrefixRow.totalTokens, "总 Token 应包含刚才记录的交互");
assert(stats.summary.total_cached_saved !== undefined, "应包含上下文缓存节省量");
assert(stats.summary.avg_cache_hit_rate !== undefined, "应包含平均缓存命中率");

const recentLogs = getRecentTokenLogs(10);
assert(recentLogs.length > 0);
assert(recentLogs[0].cached_tokens !== undefined, "日志流水应包含 cached_tokens");
assert(recentLogs[0].cache_hit_rate !== undefined, "日志流水应包含 cache_hit_rate");
console.log(`✅ Token 估算 (${tokenPrefixRow.promptTokens} + ${tokenPrefixRow.replyTokens} = ${tokenPrefixRow.totalTokens} Tokens，缓存命中: ${tokenPrefixRow.cachedTokens} T / ${(tokenPrefixRow.cacheHitRate * 100).toFixed(1)}%) 与聚合统计验证通过！`);

// 3. 测试 人格与时空控制台
console.log("\n--- 3. 验证 人格与时空控制台 (Persona & Spatio-temporal Console) ---");
const personaList = getAllPersonas("tomoko");
assert(personaList.length >= 4, "至少应包含 tomoko, dragon_girl, little_whale, haena");
const tomoko = personaList.find(p => p.key === "tomoko");
assert.strictEqual(tomoko.displayName, "智子");
assert.strictEqual(tomoko.isActive, true);

// 时空迁移
updateCharacterLocation("秋叶原电玩店", "在试玩区体验最新主机", "周围很多人在围观", "兴奋");
const charState = getCharacterState();
assert.strictEqual(charState.location, "秋叶原电玩店");
assert.strictEqual(charState.action, "在试玩区体验最新主机");
assert.strictEqual(charState.mood, "兴奋");

// Markdown 人设卡读写
const cardContent = loadPersonaPrompt("tomoko");
assert(cardContent.length > 50, "智子人设卡内容应非空");
console.log("✅ 人格预设列表、卡片热重载与时空身位迁移落盘验证通过！");

// 4. 测试 Web Server REST APIs & WebSocket
console.log("\n--- 4. 验证 Web Server REST APIs 与 WebSocket 推流 ---");

const testPort = 5121; // 使用独立测试端口
const testAdminToken = "test-hakimi-token";
const testConfig = {
  web: { port: testPort, adminToken: testAdminToken },
  antigravity: { agentPreset: "tomoko" },
  snowLuma: { wsUrl: "ws://127.0.0.1:3000", botQqId: 485599240 }
};

const eventBus = new EventEmitter();
const mockSessions = new Map([
  ["group:587071853", { cascadeId: "cas-12345", turnCount: 3, isActive: true, activeRemainingSec: 80, isSleeping: false }]
]);
const mockBatchBuffers = new Map([
  ["group:999888777", { timer: setTimeout(() => {}, 8000), messages: [] }]
]);

const mockDaemonApi = {
  getSnowLumaStatus: () => ({ connected: true, botQqId: 485599240, wsUrl: "ws://127.0.0.1:3000" }),
  getActiveSessions: () => Array.from(mockSessions.values()),
  sendQQMessage: async (targetType, targetId, message) => true,
  deleteGroup: (groupId) => {
    deleteManagedGroup(groupId);
    const key = `group:${groupId}`;
    if (mockBatchBuffers.has(key)) {
      clearTimeout(mockBatchBuffers.get(key).timer);
      mockBatchBuffers.delete(key);
    }
    mockSessions.delete(key);
    return true;
  },
  toggleGroup: (groupId, enabled) => {
    const row = toggleGroupEnabled(groupId, enabled);
    if (!enabled) {
      const key = `group:${groupId}`;
      if (mockBatchBuffers.has(key)) {
        clearTimeout(mockBatchBuffers.get(key).timer);
        mockBatchBuffers.delete(key);
      }
    }
    return row;
  },
  resetSession: (sessionKey) => {
    if (mockBatchBuffers.has(sessionKey)) {
      clearTimeout(mockBatchBuffers.get(sessionKey).timer);
      mockBatchBuffers.delete(sessionKey);
    }
    mockSessions.set(sessionKey, { cascadeId: null, turnCount: 0 });
  },
  resetAllSessions: () => {
    for (const b of mockBatchBuffers.values()) {
      clearTimeout(b.timer);
    }
    mockBatchBuffers.clear();
    mockSessions.clear();
  },
  switchPersona: (presetName) => {
    const p = getActivePersona(presetName);
    testConfig.antigravity.agentPreset = p.name;
    for (const s of mockSessions.values()) {
      s.cascadeId = null;
      s.turnCount = 0;
    }
    updateCharacterLocation(p.defaultLocation, p.defaultAction, p.defaultDetail || "", p.defaultMood || "自然");
    eventBus.emit("broadcast", { type: "state_change", data: getCharacterState() });
    eventBus.emit("broadcast", { type: "persona_switch", data: { activePreset: p.name, persona: p } });
    return true;
  },
  reloadConfig: () => {},
  getLogBuffer: () => [{ time: "15:30:00", level: "info", text: "测试日志" }],
  broadcastEvent: (type, data) => eventBus.emit("broadcast", { type, data })
};

const webServer = createWebServer({
  config: testConfig,
  eventBus,
  daemonApi: mockDaemonApi
});

await webServer.start();
console.log(`✅ Web Server 已在端口 ${testPort} 启动！`);

// 4.1 测试免密访问
const unauthResp = await fetch(`http://127.0.0.1:${testPort}/api/groups`);
assert.strictEqual(unauthResp.status, 200, "免密系统应直接返回 200 成功");

// 4.2 测试登录端点 (免密开放)
const loginResp = await fetch(`http://127.0.0.1:${testPort}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({})
});
const loginData = await loginResp.json();
assert.strictEqual(loginData.success, true, "免密登录接口应直接成功");

const authHeaders = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${testAdminToken}`
};

// 4.3 测试群组 API 与部分更新 (Partial PUT)
saveManagedGroup(77766655, "初始测试群", true, "strict");
const putPartialResp = await fetch(`http://127.0.0.1:${testPort}/api/groups/77766655`, {
  method: "PUT",
  headers: authHeaders,
  body: JSON.stringify({ name: "仅修改名称" })
});
const putPartialData = await putPartialResp.json();
assert.strictEqual(putPartialData.data.group_name, "仅修改名称");
assert.strictEqual(putPartialData.data.enabled, true, "既有 enabled 应被保留");
assert.strictEqual(putPartialData.data.trigger_policy, "strict", "既有 trigger_policy 应被保留");

// 4.4 测试守护进程 API 联动：删除群时清理批处理缓冲与会话
const delGroupResp = await fetch(`http://127.0.0.1:${testPort}/api/groups/999888777`, {
  method: "DELETE",
  headers: authHeaders
});
const delGroupData = await delGroupResp.json();
assert.strictEqual(delGroupData.success, true);
assert.strictEqual(mockBatchBuffers.has("group:999888777"), false, "删除群应自动清理挂起的批处理缓冲");

// 4.5 测试人设热切换：切断 Cascade 会话并迁移时空位置
const switchResp = await fetch(`http://127.0.0.1:${testPort}/api/personas/switch`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "dragon_girl" })
});
const switchData = await switchResp.json();
assert.strictEqual(switchData.success, true);
assert.strictEqual(mockSessions.get("group:587071853").cascadeId, null, "切换人设必须重置各群已有 cascadeId");
assert.strictEqual(getCharacterState().location, "云端水晶龙巢", "切换人设必须自动迁移至新人设默认时空位置");

// 4.6 测试系统状态 API (含图片缓存统计)
const statusResp = await fetch(`http://127.0.0.1:${testPort}/api/system/status`, { headers: authHeaders });
const statusData = await statusResp.json();
assert.strictEqual(statusData.data.projectName, "哈基米聊天系统");
assert.strictEqual(statusData.data.snowLuma.connected, true);
assert(typeof statusData.data.cachedImageCount === "number", "系统状态应包含 cachedImageCount");
assert.strictEqual(statusData.data.cachedImagesMax, 15, "系统状态应包含 cachedImagesMax: 15");

// 4.6.1 测试图片缓存 API 与 FIFO 滚动淘汰 (保留最新 15 张)
const imagesResp = await fetch(`http://127.0.0.1:${testPort}/api/system/images`, { headers: authHeaders });
const imagesData = await imagesResp.json();
assert.strictEqual(imagesData.success, true);
assert.strictEqual(imagesData.max, 15);
assert(Array.isArray(imagesData.files));

// 创建 20 张模拟图片测试 FIFO 滚动
const testImgDir = path.resolve("./data/images");
if (!fs.existsSync(testImgDir)) fs.mkdirSync(testImgDir, { recursive: true });
for (let i = 1; i <= 20; i++) {
  const p = path.join(testImgDir, `test_dummy_${String(i).padStart(2, "0")}.jpg`);
  fs.writeFileSync(p, `dummy image content ${i}`);
  const mtime = new Date(Date.now() - (25 - i) * 1000);
  try { fs.utimesSync(p, mtime, mtime); } catch {}
}
const fifoRes = cleanImagesFifo(15, testImgDir);
assert(fifoRes.count <= 15, "FIFO 清理后剩余图片文件数应不超过 15 张");
assert(fifoRes.deleted >= 5, "FIFO 清理应淘汰超过 15 张的较旧文件");

// 测试一键清空图片缓存 API
const cleanResp = await fetch(`http://127.0.0.1:${testPort}/api/system/clean-images`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ keepLatest: 0 })
});
const cleanData = await cleanResp.json();
assert.strictEqual(cleanData.success, true);
assert.strictEqual(cleanData.count, 0, "一键清空后图片缓存数应为 0");

// 4.6.2 测试 /images 路由免密直读
const dummyImgPath = path.join(testImgDir, "secure_test.png");
fs.writeFileSync(dummyImgPath, "dummy image binary content");
try {
  const directImgResp = await fetch(`http://127.0.0.1:${testPort}/images/secure_test.png`);
  assert.strictEqual(directImgResp.status, 200, "/images 免密直接读取应返回 200");
} finally {
  try { fs.unlinkSync(dummyImgPath); } catch {}
}

// 4.7 测试本地离线静态资源托管 (vendor/ scripts)
const vueAssetResp = await fetch(`http://127.0.0.1:${testPort}/vendor/vue.global.prod.js`);
assert.strictEqual(vueAssetResp.status, 200, "本地离线 Vue 脚本应正确托管返回 200");
const chartAssetResp = await fetch(`http://127.0.0.1:${testPort}/vendor/chart.umd.min.js`);
assert.strictEqual(chartAssetResp.status, 200, "本地离线 Chart.js 脚本应正确托管返回 200");

// 4.8 测试对讲机发信 API
const sendResp = await fetch(`http://127.0.0.1:${testPort}/api/messages/send`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ targetType: "group", targetId: 587071853, message: "测试对讲机广播" })
});
const sendData = await sendResp.json();
assert.strictEqual(sendData.success, true, "对讲机发信应调用成功");

// 4.9 测试好感度 API
const affResp = await fetch(`http://127.0.0.1:${testPort}/api/affinity`, { headers: authHeaders });
const affData = await affResp.json();
assert(Array.isArray(affData.rows), "好感度排行榜应返回数组");

// 4.10 测试黑话词典 API
const createSlangResp = await fetch(`http://127.0.0.1:${testPort}/api/slangs`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ word: "赛博摸鱼", meaning: "在代码审查时偷看动漫" })
});
const createSlangData = await createSlangResp.json();
assert(createSlangData.data?.word === "赛博摸鱼", "黑话添加应成功");

// 5. 测试 WebSocket 连接与多事件广播
console.log("\n--- 5. 验证 WebSocket 实时推流连接 ---");
const wsUrl = `ws://127.0.0.1:${testPort}/ws?token=${testAdminToken}`;
const wsClient = new WebSocket(wsUrl);

const wsConnectedPromise = new Promise((resolve, reject) => {
  wsClient.on("open", () => resolve(true));
  wsClient.on("error", (err) => reject(err));
});
await wsConnectedPromise;
assert.strictEqual(wsClient.readyState, WebSocket.OPEN, "WebSocket 应成功建立连接");

// 验证消息广播接收
const broadcastPromise = new Promise((resolve) => {
  wsClient.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "social_decision" && msg.data?.action === "INTERJECT") {
        resolve(msg);
      }
    } catch {}
  });
});

// 触发一条社交决策广播
eventBus.emit("broadcast", {
  type: "social_decision",
  data: {
    time: "15:40:00",
    sessionKey: "group:587071853",
    action: "INTERJECT",
    diveMinutes: 0,
    rawDecision: "群友聊到怪猎荒野，探头搭话"
  }
});

const receivedMsg = await broadcastPromise;
assert.strictEqual(receivedMsg.data.action, "INTERJECT", "WebSocket 应接收到实时社交决策广播");
console.log("✅ WebSocket 认证、连接与实时广播测试通过！");

wsClient.close();
webServer.server.close();

// 清理测试创建的数据并恢复初始人设
deleteManagedGroup(77766655);
deleteManagedGroup(999888777);
cleanTestTokenLogs();
mockDaemonApi.switchPersona("tomoko");

console.log("\n🎉 哈基米聊天系统 (Hakimi Chat System) 六大模块全部测试通过，验证圆满成功！");
