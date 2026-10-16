import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { 
  getCharacterState, 
  updateCharacterLocation, 
  getUserAffinity, 
  modifyUserAffinity, 
  deleteUserAffinity,
  saveSessionMemory, 
  getSessionMemory,
  deleteSessionMemory,
  pushInboxMessage,
  popInboxMessage,
  recordChatMessage,
  getRecentChatContext,
  clearChatMessages,
  recordSlang,
  getTopSlangs,
  syncCharacterStateForPersona,
  getSessionState,
  saveSessionState,
  deleteSessionState,
  cleanStaleInboxMessages
} from "../src/db.mjs";
import { getActivePersona, loadPersonaPrompt, PERSONAS } from "../src/personas.mjs";
import { processOutboundMessage, isDirectedAtAi } from "../src/bridge-daemon.mjs";

console.log("=== 1. 验证 Persona 预设与提示词加载 ===");
for (const key of ["tomoko", "dragon_girl", "little_whale", "haena"]) {
  const persona = getActivePersona(key);
  assert(persona, `Persona ${key} should exist`);
  assert(persona.displayName, `Persona ${key} must have displayName`);
  assert(persona.mentionRegex instanceof RegExp, `Persona ${key} must have mentionRegex`);
  assert(Array.isArray(persona.interestKeywords), `Persona ${key} must have interestKeywords`);
  
  const prompt = loadPersonaPrompt(key);
  assert(prompt && prompt.length > 50, `Persona prompt for ${key} should load from agents/*.md`);
  console.log(`✅ 人设 [${persona.displayName}] (${persona.name}) 预设与卡片加载成功 (${prompt.length} 字符)`);
}

console.log("\n=== 2. 验证 SQLite 接收队列 (push/pop 原子性) 与空队防幽灵重放 ===");
// 先排空可能存在的残留消息以保证单元测试独立性
while (popInboxMessage()) {}

const testPayload1 = { id: 101, text: "msg1", targetType: "group", targetId: 587071853 };
const testPayload2 = { id: 102, text: "msg2", targetType: "private", targetId: 2667946375 };
pushInboxMessage(testPayload1);
pushInboxMessage(testPayload2);

const popped1 = popInboxMessage();
const popped2 = popInboxMessage();
const poppedEmpty = popInboxMessage();

assert.deepStrictEqual(popped1, testPayload1, "First in must be first out");
assert.deepStrictEqual(popped2, testPayload2, "Second in must be second out");
assert.strictEqual(poppedEmpty, null, "Empty queue must return null");
console.log("✅ 消息队列 FIFO 原子出入队验证通过！");

console.log("\n=== 3. 验证 好感度 last_reason 保护、0点边界与多角色解耦 ===");
const testUid = 55443300 + Math.floor(Math.random() * 1000);
modifyUserAffinity(testUid, 5, "赠送麦茶");
const affBefore = getUserAffinity(testUid);
assert.strictEqual(affBefore.last_reason, "赠送麦茶");

// 不传 reason 或传空字符串时不应覆盖原 reason
modifyUserAffinity(testUid, 2, "");
const affAfterEmpty = getUserAffinity(testUid);
assert.strictEqual(affAfterEmpty.last_reason, "赠送麦茶", "Empty reason must not overwrite previous reason");
console.log("✅ 好感度 last_reason 保护逻辑验证通过！");

// 0 点边界测试：防止 0 || 30 导致的重置假初识缺陷
const zeroUid = 77000000 + Math.floor(Math.random() * 1000);
modifyUserAffinity(zeroUid, -30, "降至零点"); // 30 - 30 = 0
const affZero = getUserAffinity(zeroUid);
assert.strictEqual(affZero.affinity_points, 0, "Points should be exactly 0");
modifyUserAffinity(zeroUid, 5, "零点回升");
const affAfterZero = getUserAffinity(zeroUid);
assert.strictEqual(affAfterZero.affinity_points, 5, "0 points + 5 must equal 5, not 35");
console.log("✅ 好感度 0 点边界值防 falsy 穿透验证通过！");

// 动态 BotName 记录测试
const testSession = `group:test_${Date.now()}`;
recordChatMessage(testSession, 999, "白龙娘", "吾乃龙娘", true, "白龙娘");
const ctx = getRecentChatContext(testSession, 5);
assert(ctx.includes("白龙娘: 吾乃龙娘"), `Expected '白龙娘: 吾乃龙娘' in context, got: ${ctx}`);
console.log("✅ 动态 BotName 记录与解耦验证通过！");

console.log("\n=== 4. 验证 出站消息过滤逻辑 (真实 bridge-daemon 核心管线) ===");

// 4.1 测试数学符号不被吞噬
const mathMsg = `<reply>如果 x < 10 且 y > 5，那么结果是正确的。</reply>`;
const cleanedMath = processOutboundMessage("test:1", 1, mathMsg);
assert.strictEqual(cleanedMath, "如果 x < 10 且 y > 5，那么结果是正确的。");
console.log("✅ 数学符号 < 和 > 安全保留测试通过！");

// 4.2 测试思考标签剥离（含未闭合思考标签截断）与 MEMORY_SNAPSHOT 提前落盘
const complexMsg = `<think>我在思考怎么回</think><social_decision>ACTION: REPLY</social_decision><reply>今天天气真好！[af:+3|夸天气]</reply><MEMORY_SNAPSHOT>今天聊了天气非常开心</MEMORY_SNAPSHOT>`;
const cleanedComplex = processOutboundMessage("test:mem", 1, complexMsg);
assert.strictEqual(cleanedComplex, "今天天气真好！");
assert.strictEqual(getSessionMemory("test:mem"), "今天聊了天气非常开心");

const unclosedThinkMsg = `<think>思考中途被截断...无法生成下文`;
const cleanedUnclosed = processOutboundMessage("test:think", 1, unclosedThinkMsg);
assert.strictEqual(cleanedUnclosed, "", "Unclosed think block should be safely stripped");
console.log("✅ 思考标签剥离与 MEMORY_SNAPSHOT 提前安全归档通过！");

// 4.3 验证决策槽内黑话与时空状态的跨槽全局提取
const slangUid = 66000000 + Math.floor(Math.random() * 1000);
const decisionWithTags = `<social_decision>
ACTION: REPLY
[slang:电子榨菜|吃饭配饭视频]
[state:秋叶原女仆咖啡厅|喝咖啡聊天|店内热闹]
[af:+4|共鸣二次元]
</social_decision>
<reply>确实是不可或缺的电子榨菜呢！</reply>`;
const cleanedWithTags = processOutboundMessage("test:tags", slangUid, decisionWithTags);
assert.strictEqual(cleanedWithTags, "确实是不可或缺的电子榨菜呢！");
assert.strictEqual(getCharacterState().location, "秋叶原女仆咖啡厅");
assert.strictEqual(getUserAffinity(slangUid).affinity_points, 34);
assert(getTopSlangs(10).some(s => s.word === "电子榨菜"), "Slang from social_decision must be recorded");
console.log("✅ social_decision 决策槽内内联标签 ([slang], [state], [af]) 全局提取入库通过！");

// 4.4 测试 DIVE / [SILENT]
const diveMsg = `<social_decision>ACTION: DIVE\ndive_minutes: 5</social_decision><reply>[SILENT]</reply>`;
const cleanedDive = processOutboundMessage("test:dive", 1, diveMsg);
assert.strictEqual(cleanedDive, "");
console.log("✅ DIVE / [SILENT] 静默截断通过！");

console.log("\n=== 5. 验证 isDirectedAtAi 语义与上下文适格过滤 ===");
// 普通群聊且无上下文适格时，群友闲聊不应误触发
assert.strictEqual(isDirectedAtAi("今天吃了什么", false), false);
assert.strictEqual(isDirectedAtAi("你吃过饭了吗", false), false, "Pronoun questions without active window must NOT trigger AI");
assert.strictEqual(isDirectedAtAi("你吃过饭了吗", true), true, "Pronoun questions within active window MUST trigger AI");
assert.strictEqual(isDirectedAtAi("智子你在干嘛呢", false), true, "Direct persona mention must trigger AI");
assert.strictEqual(isDirectedAtAi("妹子你好", false), false, "Generic '妹子' must NOT trigger AI");
console.log("✅ isDirectedAtAi 上下文适格与人设语义定向测试通过！");

console.log("\n=== 6. 验证 SQLite session_states 持久化自愈（会话状态跨重启恢复） ===");
const sessKey = "group:888999111";
const futureActive = Date.now() + 120000;
const futureSleep = Date.now() + 300000;
saveSessionState(sessKey, {
  activeUntil: futureActive,
  activeSpeaker: 12345678,
  sleepUntil: futureSleep,
  messageCounter: 4,
  turnCount: 5,
  lastPrompt: "你好智子"
});

const restoredSess = getSessionState(sessKey);
assert(restoredSess, "Session state should be saved and queryable");
assert.strictEqual(restoredSess.sessionKey, sessKey);
assert.strictEqual(restoredSess.activeUntil, futureActive, "activeUntil must survive and match");
assert.strictEqual(restoredSess.activeSpeaker, 12345678, "activeSpeaker must survive and match");
assert.strictEqual(restoredSess.sleepUntil, futureSleep, "sleepUntil must survive and match");
assert.strictEqual(restoredSess.turnCount, 5, "turnCount must survive and match");
assert.strictEqual(restoredSess.lastPrompt, "你好智子", "lastPrompt must survive and match");
deleteSessionState(sessKey);
assert.strictEqual(getSessionState(sessKey), null, "Deleted session must return null");
console.log("✅ session_states 会话状态持久化与自愈恢复验证通过！");

console.log("\n=== 7. 验证 inbox_queue 启动 TTL 自愈清理 ===");
while (popInboxMessage()) {}

const freshPayload = { id: 991, text: "fresh_msg" };
pushInboxMessage(freshPayload);

// 测试传入字符串格式的 TTL 及默认参数
const cleanedFresh = cleanStaleInboxMessages("300");
assert.strictEqual(cleanedFresh, 0, "Fresh messages (< 300s) must NOT be deleted");

const poppedFresh = popInboxMessage();
assert.deepStrictEqual(poppedFresh, freshPayload, "Fresh message must still be in queue");
assert.strictEqual(popInboxMessage(), null);

// 测试边界：过期消息清理
pushInboxMessage({ id: 992, text: "stale_msg" }, "2020-01-01 00:00:00");
const cleanedExpired = cleanStaleInboxMessages(300);
assert(cleanedExpired >= 1, "Expired message should be pruned by TTL cleanup");
assert.strictEqual(popInboxMessage(), null, "Pruned queue should be empty");

// 测试异常/负数参数防御
assert.doesNotThrow(() => cleanStaleInboxMessages(-10));
assert.doesNotThrow(() => cleanStaleInboxMessages("invalid"));

console.log("✅ inbox_queue 启动 TTL 自愈清理机制验证通过！");

// 善后清理测试产生的临时数据，避免污染生产数据库 state.db
deleteUserAffinity(testUid);
deleteUserAffinity(zeroUid);
deleteUserAffinity(slangUid);
deleteUserAffinity(1);
clearChatMessages("test:1");
clearChatMessages("test:mem");
clearChatMessages("test:think");
clearChatMessages("test:tags");
clearChatMessages("test:dive");
clearChatMessages(testSession);
deleteSessionMemory("test:mem");
deleteSessionState("test:dive");
deleteSessionState(testSession);
// 恢复智子初始身位
syncCharacterStateForPersona("tomoko");

console.log("\n🎉 所有测试全面通过，全阶段架构验证圆满成功！");
