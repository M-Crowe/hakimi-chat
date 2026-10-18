import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { 
  db,
  PROJECT_ROOT,
  recordChatMessage, 
  updateChatMessageImages, 
  getUserAffinity,
  modifyUserAffinity,
  pushInboxMessage,
  popInboxMessage,
  cleanStaleInboxMessages,
  saveManagedGroup
} from "../src/db.mjs";
import { 
  batchBuffers, 
  handleOneBotMessage, 
  dispatchBatch, 
  processOutboundMessage,
  config 
} from "../src/bridge-daemon.mjs";

test("Phase 1: 消除 data/inbox.json 双写，仅依赖 SQLite inbox_queue 原子队列", async () => {
  const inboxJsonPath = path.resolve(PROJECT_ROOT, "data/inbox.json");
  // 确保测试前 inbox.json 状态确定
  if (fs.existsSync(inboxJsonPath)) {
    fs.writeFileSync(inboxJsonPath, "[]", "utf-8");
  }

  // 清空现存队列
  while (popInboxMessage()) {}

  // 模拟 dispatchBatch 发送一条测试批次
  const testSessionKey = "group:99901";
  saveManagedGroup(99901, "测试群", true, "normal");

  batchBuffers.set(testSessionKey, {
    messages: [{ senderId: 10001, text: "测试消息1" }],
    images: [],
    targetType: "group",
    targetId: 99901,
    senderId: 10001,
    primarySenderId: 10001,
    triggerReason: "测试",
    isDirectMention: true,
    isContinuousChat: false,
    isAutonomousInterject: false,
    debounceTimer: null,
    maxWaitTimer: null,
    timer: null
  });

  await dispatchBatch(testSessionKey);

  // 1. 验证 SQLite inbox_queue 成功接收到聚合批次
  const popped = popInboxMessage();
  assert.ok(popped, "SQLite inbox_queue 应该出队一条消息");
  assert.strictEqual(popped.targetId, 99901);
  assert.strictEqual(popped.senderId, 10001);
  assert.ok(popped.fullPrompt.includes("[群友(10001)]: 测试消息1"));

  // 2. 验证 data/inbox.json 没有被双写追加
  if (fs.existsSync(inboxJsonPath)) {
    const jsonContent = fs.readFileSync(inboxJsonPath, "utf-8");
    assert.strictEqual(jsonContent, "[]", "data/inbox.json 不应被双写写入任何数据");
  }
});

test("Phase 1: 群聊滑动窗口防抖聚合隔离，防止跨说话人串味与防抖饿死", async () => {
  const testGroupId = 99902;
  const testSessionKey = `group:${testGroupId}`;
  saveManagedGroup(testGroupId, "测试群2", true, "normal");

  // 清除旧缓冲
  if (batchBuffers.has(testSessionKey)) {
    const b = batchBuffers.get(testSessionKey);
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    if (b.maxWaitTimer) clearTimeout(b.maxWaitTimer);
    batchBuffers.delete(testSessionKey);
  }

  const userA = 10001;
  const userB = 10002;

  // 1. User A 发送直接 @ 机器人的消息
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userA,
    sender: { card: "群友A", nickname: "UserA" },
    message: [
      { type: "at", data: { qq: config.snowLuma.botQqId } },
      { type: "text", data: { text: "你好智子" } }
    ]
  });

  const batchAfterA = batchBuffers.get(testSessionKey);
  assert.ok(batchAfterA, "User A 的消息应该成功创建批处理缓冲");
  assert.strictEqual(batchAfterA.primarySenderId, userA);
  assert.strictEqual(batchAfterA.messages.length, 1);
  assert.strictEqual(batchAfterA.messages[0].text, "你好智子");
  const firstDebounceTimer = batchAfterA.debounceTimer;
  assert.ok(firstDebounceTimer, "应该已设置防抖计时器");

  // 2. User B 发送普通闲聊消息（未提及机器人）
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userB,
    sender: { card: "群友B", nickname: "UserB" },
    message: [
      { type: "text", data: { text: "今天天气不错" } }
    ]
  });

  const batchAfterB = batchBuffers.get(testSessionKey);
  assert.strictEqual(batchAfterB.primarySenderId, userA, "批处理归属人仍应为 User A");
  assert.strictEqual(batchAfterB.messages.length, 1, "User B 的普通发言严禁追加到 User A 的批处理中");
  assert.strictEqual(batchAfterB.debounceTimer, firstDebounceTimer, "User B 的发言严禁重置 User A 的防抖计时器");

  // 3. User A 连续发送第二句话
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userA,
    sender: { card: "群友A", nickname: "UserA" },
    message: [
      { type: "text", data: { text: "在吗我想问个问题" } }
    ]
  });

  assert.strictEqual(batchAfterA.messages.length, 2, "User A 自己的后续发言应该追加进批次");
  assert.strictEqual(batchAfterA.messages[1].text, "在吗我想问个问题");
  assert.notStrictEqual(batchAfterA.debounceTimer, firstDebounceTimer, "User A 自己的发言应该刷新防抖计时器");

  // 4. 清理定时器
  if (batchAfterA.debounceTimer) clearTimeout(batchAfterA.debounceTimer);
  if (batchAfterA.maxWaitTimer) clearTimeout(batchAfterA.maxWaitTimer);
  batchBuffers.delete(testSessionKey);
});

test("Phase 1: 群聊缓冲期间若另一位群友直接 @bot，应立即提前提交前序批次并为新用户建立批次", async () => {
  const testGroupId = 99903;
  const testSessionKey = `group:${testGroupId}`;
  saveManagedGroup(testGroupId, "测试群3", true, "normal");

  // 清空现存队列
  while (popInboxMessage()) {}

  const userA = 10001;
  const userC = 10003;

  // 1. User A 发送直接 @ 消息
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userA,
    sender: { card: "群友A" },
    message: [
      { type: "at", data: { qq: config.snowLuma.botQqId } },
      { type: "text", data: { text: "UserA 第一句" } }
    ]
  });

  assert.ok(batchBuffers.has(testSessionKey));

  // 2. User C 直接 @ 机器人
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userC,
    sender: { card: "群友C" },
    message: [
      { type: "at", data: { qq: config.snowLuma.botQqId } },
      { type: "text", data: { text: "UserC 紧急呼叫" } }
    ]
  });

  // User A 的批次应该已经被提前 dispatch 到 inbox_queue
  const poppedA = popInboxMessage();
  assert.ok(poppedA, "User A 的批次应该已经出库入队");
  assert.strictEqual(poppedA.senderId, userA);
  assert.ok(poppedA.fullPrompt.includes("UserA 第一句"));

  // 当前 batchBuffers 中应该已经变成了 User C 的批次
  const batchC = batchBuffers.get(testSessionKey);
  assert.ok(batchC, "应该为 User C 创建了独立的新批次");
  assert.strictEqual(batchC.primarySenderId, userC);
  assert.strictEqual(batchC.messages[0].text, "UserC 紧急呼叫");

  // 清理定时器
  if (batchC.debounceTimer) clearTimeout(batchC.debounceTimer);
  if (batchC.maxWaitTimer) clearTimeout(batchC.maxWaitTimer);
  batchBuffers.delete(testSessionKey);
});

test("Phase 1: 定时看群巡逻 (senderId: 0) 好感度防误触与隔离", async () => {
  const adminId = config.snowLuma.adminQqIds?.[0] || 2667946375;
  const initialAdminAffinity = getUserAffinity(adminId);

  const testGroupId = 99904;
  const testSessionKey = `group:${testGroupId}`;
  saveManagedGroup(testGroupId, "测试群4", true, "normal");

  // 1. 模拟定时看群巡逻批次设置 senderId: 0
  const systemSenderId = 0;
  batchBuffers.set(testSessionKey, {
    messages: [{ senderId: systemSenderId, text: "[日常看群]" }],
    targetType: "group",
    targetId: testGroupId,
    senderId: systemSenderId,
    primarySenderId: systemSenderId,
    triggerReason: "定时随机看群",
    isDirectMention: false,
    isContinuousChat: false,
    isAutonomousInterject: true,
    isPatrolWake: true,
    debounceTimer: null,
    maxWaitTimer: null,
    timer: null
  });

  while (popInboxMessage()) {}

  await dispatchBatch(testSessionKey);

  const patrolPayload = popInboxMessage();
  assert.ok(patrolPayload);
  assert.strictEqual(patrolPayload.senderId, 0, "巡逻消息的 senderId 必须为 0");
  assert.strictEqual(patrolPayload.aff.affinity_points, 30, "巡逻消息好感度应为初始中立 30");

  // 2. 模拟巡逻回复附带好感度变动标签（例如 [af:+2|共鸣]）
  const fakeAiReply = "<social_decision>\nACTION: INTERJECT\n[af:+2|测试巡逻不能改好感]\n</social_decision>\n<reply>测试冒泡</reply>";
  const outboundResult = processOutboundMessage(testSessionKey, 0, fakeAiReply);
  assert.ok(outboundResult.includes("测试冒泡"), "出站消息净化后应包含正文内容");

  // 验证管理员的好感度丝毫没有被篡改
  const afterAdminAffinity = getUserAffinity(adminId);
  assert.strictEqual(afterAdminAffinity.affinity_points, initialAdminAffinity.affinity_points, "定时巡逻绝不能修改管理员好感度");

  // 验证直接调用 getUserAffinity(0) 与 modifyUserAffinity(0) 也具有绝对防御性，绝不写库
  const affZero = getUserAffinity(0);
  assert.strictEqual(affZero.affinity_points, 30);
  const modZero = modifyUserAffinity(0, 2, "测试直接操作0");
  assert.strictEqual(modZero.newPoints, 30);

  // 验证用户 0 的记录没有被写入 user_affinity
  const rowZero = db.prepare("SELECT * FROM user_affinity WHERE user_id = 0").get();
  assert.strictEqual(rowZero, undefined, "user_id = 0 绝不能落入 user_affinity 真实好感表");
});

test("Phase 1: 消息提前快速记入 SQLite 历史 & 多模态图片异步更新", async () => {
  const testSessionKey = "group:99905";

  // 1. recordChatMessage 瞬时返回插入 ID
  const msgId = recordChatMessage(testSessionKey, 10005, "群友5", "这是一条测试图文消息", false, "智子", []);
  assert.ok(msgId, "recordChatMessage 应该返回插入的消息自增 ID");

  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(msgId);
  assert.strictEqual(row.message_text, "这是一条测试图文消息");
  assert.strictEqual(row.images, "[]");

  // 2. updateChatMessageImages 异步回填图片列表
  const mockImages = [
    { path: "images/test1.jpg", file: "test1.jpg", url: "/images/test1.jpg" }
  ];
  updateChatMessageImages(msgId, mockImages);

  const updatedRow = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(msgId);
  assert.ok(updatedRow.images.includes("test1.jpg"), "图片列表应已成功回填入库");
});

test("Phase 1: 密集并发场景（用户A、B、C相继@机器人）队列交替与FIFO写锁稳定性", async () => {
  const testGroupId = 99906;
  const testSessionKey = `group:${testGroupId}`;
  saveManagedGroup(testGroupId, "测试并发群", true, "normal");

  // 清空现存队列与缓冲
  while (popInboxMessage()) {}
  if (batchBuffers.has(testSessionKey)) {
    const b = batchBuffers.get(testSessionKey);
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    if (b.maxWaitTimer) clearTimeout(b.maxWaitTimer);
    batchBuffers.delete(testSessionKey);
  }

  const userA = 10010;
  const userB = 10020;
  const userC = 10030;

  // 1. User A 发送 @
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userA,
    sender: { card: "UserA" },
    message: [
      { type: "at", data: { qq: config.snowLuma.botQqId } },
      { type: "text", data: { text: "来自A的第1句" } }
    ]
  });

  // 2. User A 连续发送第2句
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userA,
    sender: { card: "UserA" },
    message: [
      { type: "text", data: { text: "来自A的第2句" } }
    ]
  });

  // 3. 此时 User B 紧接着直接 @ 机器人
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userB,
    sender: { card: "UserB" },
    message: [
      { type: "at", data: { qq: config.snowLuma.botQqId } },
      { type: "text", data: { text: "来自B的紧急提问" } }
    ]
  });

  // 4. 此时 User C 也紧接着直接 @ 机器人
  await handleOneBotMessage({
    message_type: "group",
    group_id: testGroupId,
    user_id: userC,
    sender: { card: "UserC" },
    message: [
      { type: "at", data: { qq: config.snowLuma.botQqId } },
      { type: "text", data: { text: "来自C的呼叫" } }
    ]
  });

  // 验证 inbox_queue 中严格出队两条前序批次 (A 和 B)，保持 FIFO 顺序
  const poppedA = popInboxMessage();
  assert.ok(poppedA, "User A 的批次应成功入队并被取出");
  assert.strictEqual(poppedA.senderId, userA);
  assert.ok(poppedA.fullPrompt.includes(`[群友(${userA})]: 来自A的第1句`));
  assert.ok(poppedA.fullPrompt.includes(`[群友(${userA})]: 来自A的第2句`));

  const poppedB = popInboxMessage();
  assert.ok(poppedB, "User B 的批次应成功入队并被取出");
  assert.strictEqual(poppedB.senderId, userB);
  assert.ok(poppedB.fullPrompt.includes(`[群友(${userB})]: 来自B的紧急提问`));

  // 5. 验证 User C 的批次当前正驻留在 batchBuffers 等待防抖
  const currentBatch = batchBuffers.get(testSessionKey);
  assert.ok(currentBatch, "当前缓冲池应保留最新的 User C 批次");
  assert.strictEqual(currentBatch.primarySenderId, userC);
  assert.strictEqual(currentBatch.messages[0].text, "来自C的呼叫");

  // 手动触发 dispatchBatch 消费 User C
  await dispatchBatch(testSessionKey);
  const poppedC = popInboxMessage();
  assert.ok(poppedC, "User C 的批次应已出队");
  assert.strictEqual(poppedC.senderId, userC);
  assert.ok(poppedC.fullPrompt.includes(`[群友(${userC})]: 来自C的呼叫`));

  // 清理
  assert.strictEqual(popInboxMessage(), null);
});
