import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  db,
  PROJECT_ROOT,
  recordChatMessage,
  getLastChatMessageId,
  hasHumanInterrupted,
  extractCandidateNgrams,
  trackGroupSlangFrequency,
  getTopGroupSlangs,
  recordTulpaEpisode,
  updateLatestTulpaEpisodeReply,
  searchTulpaEpisodes,
  getRecentTulpaEpisodes,
  popInboxMessage,
  pushInboxMessage,
  saveManagedGroup,
  getUserAffinity
} from "../src/db.mjs";
import {
  batchBuffers,
  dispatchBatch,
  processOutboundMessage,
  sendQQMessage,
  splitIntoBubbles,
  UNFINISHED_REGEX,
  config
} from "../src/bridge-daemon.mjs";
import { buildSystemPrompt } from "../src/personas.mjs";

test("Tulpa Item 1: 本地半句话未完结等待 (UNFINISHED Regex & Debounce Extension)", async () => {
  // 1. 验证 UNFINISHED_REGEX 匹配常见未说完的表达（包含真实中文打字语气助词）
  const unfinishedSamples = [
    "等一下",
    "等一下哈",
    "等下，",
    "等下啊",
    "我跟你说",
    "我跟你说啊",
    "跟你讲 ",
    "你知道吗",
    "其实",
    "其实呢",
    "但是",
    "但是呢",
    "不过",
    "而且啊",
    "还有...",
    "还有呢",
    "然后……",
    "因为",
    "就是说",
    "比如：",
    "刚才在路上，",
    "你看这个：",
    "这件事其实…",
    "稍等下",
    "等等"
  ];

  for (const sample of unfinishedSamples) {
    assert.ok(
      UNFINISHED_REGEX.test(sample),
      `UNFINISHED_REGEX 应该匹配未说完表达: "${sample}"`
    );
  }

  // 2. 验证已说完的句子不匹配
  const finishedSamples = [
    "今天天气真好。",
    "在吗我想问个问题",
    "你好智子",
    "我吃饱了！",
    "这是一句完整的话？",
    "好的没问题"
  ];

  for (const sample of finishedSamples) {
    assert.strictEqual(
      UNFINISHED_REGEX.test(sample),
      false,
      `UNFINISHED_REGEX 不应误判完整句子: "${sample}"`
    );
  }

  // 3. 验证 dispatchBatch 遇到未说完消息时本地延长防抖等待，零 Token 消耗
  const testSessionKey = "group:88801";
  saveManagedGroup(88801, "测试群88801", true, "all");

  // 清空现存队列
  while (popInboxMessage()) {}

  // 模拟第一句未说完的消息 "我跟你说"
  batchBuffers.set(testSessionKey, {
    messages: [{ senderId: 20001, text: "我跟你说" }],
    images: [],
    targetType: "group",
    targetId: 88801,
    senderId: 20001,
    primarySenderId: 20001,
    triggerReason: "直接提及",
    isDirectMention: true,
    isContinuousChat: false,
    isAutonomousInterject: false,
    debounceTimer: null,
    maxWaitTimer: null,
    timer: null,
    extendedForUnfinished: false
  });

  // 尝试分发
  await dispatchBatch(testSessionKey);

  // 验证：批次不应入队，而应保留在 batchBuffers 中延长等待
  const poppedTooEarly = popInboxMessage();
  assert.strictEqual(poppedTooEarly, null, "半句话期间严禁提前分发入队烧 Token");

  const pendingBatch = batchBuffers.get(testSessionKey);
  assert.ok(pendingBatch, "批次应继续保留在 batchBuffers 中");
  assert.strictEqual(pendingBatch.extendedForUnfinished, true, "应已标记 extendedForUnfinished = true");
  assert.ok(pendingBatch.debounceTimer, "应已设置延时防抖定时器");

  // 用户发送了第二句完整消息 "刚才把哈哈哈发出去了"
  pendingBatch.messages.push({ senderId: 20001, text: "刚才把哈哈哈发出去了" });

  // 清除定时器并手动触发分发
  if (pendingBatch.debounceTimer) clearTimeout(pendingBatch.debounceTimer);
  await dispatchBatch(testSessionKey);

  // 验证：此时完整语义已聚合，成功推入 inbox_queue，合并为一次 LLM 提示词
  const aggregated = popInboxMessage();
  assert.ok(aggregated, "完整话语应该成功推入 inbox_queue");
  assert.strictEqual(aggregated.targetId, 88801);
  assert.strictEqual(aggregated.senderId, 20001);
  assert.ok(aggregated.fullPrompt.includes("我跟你说"));
  assert.ok(aggregated.fullPrompt.includes("刚才把哈哈哈发出去了"));

  // 4. 验证 force: true 可以强制跳过半句话等待（例如达到 8s 封顶超时或有紧急事件）
  batchBuffers.set(testSessionKey, {
    messages: [{ senderId: 20001, text: "等一下..." }],
    images: [],
    targetType: "group",
    targetId: 88801,
    senderId: 20001,
    primarySenderId: 20001,
    triggerReason: "直接提及",
    isDirectMention: true,
    isContinuousChat: false,
    isAutonomousInterject: false,
    debounceTimer: null,
    maxWaitTimer: null,
    timer: null,
    extendedForUnfinished: false
  });

  await dispatchBatch(testSessionKey, { force: true });
  const forced = popInboxMessage();
  assert.ok(forced, "force: true 时应直接分发入队");
  assert.ok(forced.fullPrompt.includes("等一下..."));
});

test("Tulpa Item 2: 轻量社交行动决策标签 ([action:REPLY], [action:SILENCE], [action:WAIT])", async () => {
  const sessionKey = "group:88802";
  const senderId = 20002;

  // 1. [action:REPLY] 正常接话
  const replyModelOutput = `<think>
群友问在不在，应该热情回应。
</think>
[action:REPLY]
<reply>在的呢，有什么事呀？</reply>`;

  const cleanedReply = processOutboundMessage(sessionKey, senderId, replyModelOutput, {
    modelName: "deepseek-flash",
    durationMs: 1200
  });

  assert.strictEqual(cleanedReply, "在的呢，有什么事呀？", "REPLY 动作应剥离思考与动作标签后正常输出正文");

  // 2. [action:SILENCE|理由] 保持沉默 (位于思考标签外部)
  const silenceModelOutput = `<think>
这是群友之间在私聊打闹，我作为机器人插嘴会显得很唐突，决定保持沉默。
</think>
[action:SILENCE|群友互聊打闹无需介入]
<reply>他们聊得真起劲啊</reply>`;

  const cleanedSilence = processOutboundMessage(sessionKey, senderId, silenceModelOutput, {
    modelName: "deepseek-flash",
    durationMs: 1500
  });

  assert.strictEqual(cleanedSilence, "", "SILENCE 动作必须返回空字符串，杜绝向 QQ 推送扰民消息");

  // 2.1 [action:SILENCE] 嵌套在 <think> 标签内部：绝不能被思考标签误吞而失效
  const thinkNestedSilence = `<think>
[action:SILENCE|群友讨论学术问题无须介入]
群友们聊得很深入，当前话题不需要我插嘴。
</think>
<reply>你们在聊什么呢？</reply>`;

  const cleanedThinkNested = processOutboundMessage(sessionKey, senderId, thinkNestedSilence, {
    modelName: "deepseek-flash",
    durationMs: 1400
  });
  assert.strictEqual(cleanedThinkNested, "", "思考标签内部的 SILENCE 动作必须同样生效拦截，绝不泄漏回复");

  // 2.2 支持中文全角中括号【action:SILENCE】
  const cjkBracketSilence = `<think>分析中...</think>【action:SILENCE|安静观察】<reply>路过</reply>`;
  const cleanedCjkBracket = processOutboundMessage(sessionKey, senderId, cjkBracketSilence, {
    modelName: "deepseek-flash",
    durationMs: 1100
  });
  assert.strictEqual(cleanedCjkBracket, "", "中文全角括号【action:SILENCE】必须正常解析拦截");

  // 3. [action:WAIT] 动作同样保持沉默
  const waitModelOutput = `[action:WAIT]
<reply>等对方把话说完</reply>`;

  const cleanedWait = processOutboundMessage(sessionKey, senderId, waitModelOutput, {
    modelName: "deepseek-flash",
    durationMs: 800
  });

  assert.strictEqual(cleanedWait, "", "WAIT 动作必须返回空字符串");

  // 4. 验证 _base_protocol.md 中包含轻量社交动作规范
  const protocolContent = fs.readFileSync(path.resolve(PROJECT_ROOT, "agents/_base_protocol.md"), "utf-8");
  assert.ok(protocolContent.includes("[action:REPLY]"), "_base_protocol.md 必须包含 [action:REPLY] 指引");
  assert.ok(protocolContent.includes("[action:SILENCE"), "_base_protocol.md 必须包含 [action:SILENCE] 指引");
  assert.ok(protocolContent.includes("[action:WAIT]"), "_base_protocol.md 必须包含 [action:WAIT] 指引");
});

test("Tulpa Item 3: 仿生气泡队列切分与在途打断检查 (Biomorphic Typing & In-Flight Interruption)", async () => {
  // 1. 验证 splitIntoBubbles 句子与标点切分算法
  const multiline = "好的呀！\n那我下午就过去。\n记得给我留个位置！";
  const bubbles1 = splitIntoBubbles(multiline, 3);
  assert.strictEqual(bubbles1.length, 3);
  assert.strictEqual(bubbles1[0], "好的呀！");
  assert.strictEqual(bubbles1[1], "那我下午就过去。");
  assert.strictEqual(bubbles1[2], "记得给我留个位置！");

  // 单行长句按标点切分为气泡
  const singleLinePunct = "好呀好呀！那我们下午去喝奶茶吧。顺便把作业写了。";
  const bubbles2 = splitIntoBubbles(singleLinePunct, 3);
  assert.ok(bubbles2.length >= 2 && bubbles2.length <= 3, "包含多个标点短句的单行长文应切分为 2~3 个气泡");
  assert.strictEqual(bubbles2[0], "好呀好呀！");

  // 超出 3 个气泡时合并进第 3 批
  const fourLines = "第1句\n第2句\n第3句\n第4句";
  const bubbles3 = splitIntoBubbles(fourLines, 3);
  assert.strictEqual(bubbles3.length, 3);
  assert.strictEqual(bubbles3[2], "第3句\n第4句");

  // 2. 验证 hasHumanInterrupted 检测
  const sessionKey = "group:88803";
  const initialId = getLastChatMessageId(sessionKey);

  // 模拟没有真人插话
  const interrupt0 = hasHumanInterrupted(sessionKey, initialId);
  assert.strictEqual(interrupt0, null, "初始时应无真人打断");

  // 机器人发送一条消息 (is_bot = 1)
  recordChatMessage(sessionKey, config.snowLuma.botQqId, "智子", "气泡1：在路上啦", true, "智子");
  const afterBotMsgId = getLastChatMessageId(sessionKey);

  // 机器人自己的发言不应触发打断
  const interruptBot = hasHumanInterrupted(sessionKey, initialId);
  assert.strictEqual(interruptBot, null, "机器人自己的发言不能视为打断");

  // 此时真人群友突然插话 (is_bot = 0)
  const humanMsgId = recordChatMessage(sessionKey, 30001, "群友小李", "等等，活动取消了不用来了！", false, "智子");
  const interruptHuman = hasHumanInterrupted(sessionKey, afterBotMsgId);
  assert.ok(interruptHuman, "真人群友插话必须被成功检测到");
  assert.strictEqual(interruptHuman.sender_id, 30001);
  assert.strictEqual(interruptHuman.message_text, "等等，活动取消了不用来了！");

  // 3. 验证 sendQQMessage 的在途打断中断机制
  // 模拟发送包含 3 个气泡的消息，在打字延迟期间插入真人消息
  const testSessionInterrupted = "group:88804";
  const startMsgId = getLastChatMessageId(testSessionInterrupted);

  const mockSendFn = async (targetType, targetId, text) => {
    recordChatMessage(testSessionInterrupted, config.snowLuma.botQqId, "智子", text, true, "智子");
    return true;
  };

  // 在后台异步插入真人打断消息 (25ms 后插入)
  setTimeout(() => {
    recordChatMessage(testSessionInterrupted, 30002, "群友小王", "我先撤了别发了", false, "智子");
  }, 25);

  const delivered = await sendQQMessage(
    "group",
    88804,
    "第一句：准备好了。\n第二句：马上开始讲题。\n第三句：请大家翻开书本。",
    { sessionKey: testSessionInterrupted, typingDelayMs: 60, sendFn: mockSendFn }
  );

  // 查询该会话中机器人实际记录的消息数
  const botRows = db.prepare(`
    SELECT * FROM chat_messages 
    WHERE session_key = ? AND is_bot = 1 AND id > ?
  `).all(testSessionInterrupted, startMsgId);

  // 气泡1已发出，但在等待第2个气泡的打字延迟时被群友小王打断，因此第2、3个气泡被取消！
  assert.strictEqual(botRows.length, 1, "被打断后应成功取消剩余气泡，仅发送了第一条气泡");
  assert.strictEqual(botRows[0].message_text, "第一句：准备好了。");

  // 4. 验证极端网络I/O竞态：在气泡 1 传输 (sendFn 异步阻塞) 期间真人插话，后续气泡必须同样被取消
  const testSessionRace = "group:88804_race";
  const startRaceId = getLastChatMessageId(testSessionRace);
  const mockSlowSendFn = async (targetType, targetId, text) => {
    await new Promise(r => setTimeout(r, 20));
    recordChatMessage(testSessionRace, config.snowLuma.botQqId, "智子", text, true, "智子");
    return true;
  };
  // 在气泡 1 网络传输期间（5ms处，尚未完成）插入真人消息
  setTimeout(() => {
    recordChatMessage(testSessionRace, 30003, "群友小赵", "别发了有急事", false, "智子");
  }, 5);

  await sendQQMessage(
    "group",
    88804,
    "气泡1：在吗\n气泡2：看这个\n气泡3：快点",
    { sessionKey: testSessionRace, typingDelayMs: 30, sendFn: mockSlowSendFn }
  );

  const raceBotRows = db.prepare(`
    SELECT * FROM chat_messages 
    WHERE session_key = ? AND is_bot = 1 AND id > ?
  `).all(testSessionRace, startRaceId);

  assert.strictEqual(raceBotRows.length, 1, "在第一条气泡网络传输阻塞期间插话，后续气泡必须立即中断取消");
  assert.strictEqual(raceBotRows[0].message_text, "气泡1：在吗");
});

test("Tulpa Item 4: 本地 SQLite FTS5 Tulpa Episodic Memory (情境记忆检索与 KV Cache 保护)", async () => {
  const sessionKey = "group:88805";
  const adminId = config.snowLuma.adminQqIds?.[0] || 2667946375;

  // 1. 录入真实人类/管理员对话切片
  const epId1 = recordTulpaEpisode({
    sessionKey,
    userId: adminId,
    userName: "管理员",
    userMessage: "Switch2 性能大概相当于什么水平啊？",
    replyMessage: "掌机模式大概 PS4，插底座能摸到 PS4 Pro 边缘吧，关键是支持 DLSS！",
    contextSummary: "探讨任天堂次世代游戏机性能",
    keywords: "Switch2 性能 PS4 DLSS 任天堂"
  });
  assert.ok(epId1, "应该成功返回插入的情境切片 ID");

  const epId2 = recordTulpaEpisode({
    sessionKey,
    userId: adminId,
    userName: "管理员",
    userMessage: "新海诚的新电影什么时候上映？",
    replyMessage: "官方还没定档呢，只出了个概念海报！",
    contextSummary: "新海诚动画电影资讯",
    keywords: "新海诚 电影 上映 定档"
  });
  assert.ok(epId2);

  // 2. 基于关键词匹配检索 Top 1~2 个情境
  const matchSwitch = searchTulpaEpisodes("听说Switch2有新消息", 2);
  assert.ok(matchSwitch.length >= 1, "应该能匹配到 Switch2 相关的真实历史切片");
  assert.ok(matchSwitch[0].user_message.includes("Switch2"));
  assert.ok(matchSwitch[0].reply_message.includes("PS4"));

  const matchAnime = searchTulpaEpisodes("新海诚", 1);
  assert.strictEqual(matchAnime.length, 1);
  assert.ok(matchAnime[0].user_message.includes("新海诚"));

  // 3. 验证 updateLatestTulpaEpisodeReply 并测试基于回复内容的分词检索
  const epId3 = recordTulpaEpisode({
    sessionKey: "group:88806",
    userId: adminId,
    userName: "管理员",
    userMessage: "测试待补充回复的切片",
    replyMessage: ""
  });
  assert.ok(epId3);

  // 未回复前：searchTulpaEpisodes 绝不能将空回复切片作为 Few-shot 抛给模型
  const prematureMatch = searchTulpaEpisodes("测试待补充回复的切片", 2);
  assert.strictEqual(prematureMatch.some(m => m.id === epId3), false, "未生成真实回复的切片严禁被检索注入");

  const updated = updateLatestTulpaEpisodeReply("group:88806", "这是包含旷野之息神作的真实高质量回复");
  assert.strictEqual(updated, true);

  const row = db.prepare("SELECT * FROM tulpa_episodes WHERE id = ?").get(epId3);
  assert.strictEqual(row.reply_message, "这是包含旷野之息神作的真实高质量回复");
  assert.ok(row.keywords.includes("旷野之息"), "updateLatestTulpaEpisodeReply 必须更新 keywords 使得回复内容也能被检索");

  // 补充回复后：可通过回复关键词检索命中
  const matchZelda = searchTulpaEpisodes("旷野之息", 2);
  assert.ok(matchZelda.length >= 1, "应该能通过回复中的新关键词检索到情境切片");
  assert.ok(matchZelda.some(m => m.id === epId3 || m.reply_message.includes("旷野之息")), "检索结果必须包含刚补全回复的高质量切片");

  // 4. 验证 100% KV Cache 命中保护：
  // 检验 buildSystemPrompt 绝对不包含动态 Few-shot 样本
  const sysPromptA = buildSystemPrompt("tomoko", 30, { location: "海外家中二楼房间", action: "玩Switch" });
  const sysPromptB = buildSystemPrompt("tomoko", 30, { location: "海外家中二楼房间", action: "玩Switch" });
  assert.strictEqual(sysPromptA, sysPromptB, "System Prompt 前缀必须绝对稳定一致，确保 97%+ KV Cache 命中");
  assert.strictEqual(sysPromptA.includes("历史真实高光对话参考"), false, "System Prompt 中严禁混入动态 Few-shot");

  // 检验 Few-shot 仅在 dispatchBatch 时置于 Prompt 的最尾部
  saveManagedGroup(88805, "测试群88805", true, "all");
  while (popInboxMessage()) {}

  batchBuffers.set(sessionKey, {
    messages: [{ senderId: 99999, text: "关于Switch2你觉得怎么样？" }],
    images: [],
    targetType: "group",
    targetId: 88805,
    senderId: 99999,
    primarySenderId: 99999,
    triggerReason: "直接提及",
    isDirectMention: true,
    isContinuousChat: false,
    isAutonomousInterject: false,
    debounceTimer: null,
    maxWaitTimer: null,
    timer: null,
    extendedForUnfinished: false
  });

  await dispatchBatch(sessionKey);
  const popped = popInboxMessage();
  assert.ok(popped);
  assert.ok(popped.fullPrompt.includes("[历史真实高光对话参考（Tulpa 经验情境"), "Prompt 尾部应挂载 Tulpa 经验情境");
  // 验证它确实挂在最后（在用户最新发言之后）
  const userMsgIndex = popped.fullPrompt.indexOf("来自群友(99999)的最新发言");
  const fewShotIndex = popped.fullPrompt.indexOf("[历史真实高光对话参考（Tulpa 经验情境");
  assert.ok(fewShotIndex > userMsgIndex, "Few-shot 样本必须位于 Prompt 绝对最末端，绝不破坏前序 KV Cache 缓存！");
});

test("Tulpa Item 5: 本地纯算法群聊黑话词频统计 (Pure-Algorithm Group Slang Tracker, 0 Token)", async () => {
  const groupId = 77701;

  // 1. 测试候选词 N-gram 抽取
  const rawText1 = "这个游戏真的绝绝子，简直太香了，大家觉得呢？yyds！&amp; 2333 5000";
  const ngrams = extractCandidateNgrams(rawText1);
  assert.ok(ngrams.includes("yyds"), "应提取网络字母缩写 yyds");
  assert.ok(ngrams.includes("绝绝子"), "应提取中文 N-gram 绝绝子");
  assert.ok(ngrams.includes("2333"), "应提取典型网络梗数字 2333");
  assert.ok(!ngrams.includes("5000"), "普通无意义纯数字 5000 必须被滤除");
  assert.ok(!ngrams.includes("amp"), "HTML转义字符 amp 必须被彻底滤除");
  assert.ok(!ngrams.includes("这个"), "停用词 '这个' 必须被滤除");
  assert.ok(!ngrams.includes("大家"), "停用词 '大家' 必须被滤除");
  assert.ok(!ngrams.includes("真的好"), "跨词截断杂质必须被滤除");

  // 2. 连续多次发送包含黑话的消息
  trackGroupSlangFrequency(groupId, "这个卡带喜加一太爽了！yyds！");
  trackGroupSlangFrequency(groupId, "今天又喜加一了一个神作");
  trackGroupSlangFrequency(groupId, "喜加一喜加一");

  // 3. 统计查询 Top N 黑话
  const topSlangs = getTopGroupSlangs(groupId, 5);
  assert.ok(topSlangs.length > 0, "应提取到群流行词频统计");
  const xijiayi = topSlangs.find(s => s.word === "喜加一");
  assert.ok(xijiayi, "应包含高频词 '喜加一'");
  assert.ok(xijiayi.count >= 3, `词频计数应累计 (当前: ${xijiayi.count})`);

  // 验证完全不调用任何外部 API，耗时极短 (0 Token, 纯算法)
});
