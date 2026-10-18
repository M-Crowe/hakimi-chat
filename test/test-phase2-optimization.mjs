import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { 
  db, 
  initDatabase, 
  getDatabasePath, 
  checkpointDatabase, 
  recordChatMessage, 
  trimChatMessages, 
  resetMessageInsertCounters, 
  getMessageInsertCount,
  pruneOldRecords,
  PROJECT_ROOT
} from "../src/db.mjs";
import { createWebServer } from "../src/web-server.mjs";
import { discoverLanguageServer, getCachedLanguageServer, clearDiscoveryCache } from "../src/antigravity-discovery.mjs";
import { AgyConnectRpcClient } from "../src/connect-rpc-client.mjs";

console.log("=== 开始 Phase 2 架构重构与性能调优专项测试 ===\n");

// 为彻底杜绝多测试进程并发写入 shared state.db 导致 WAL 截断被锁 (SQLITE_BUSY / 无法 TRUNCATE)，
// 采用专属隔离数据库文件执行修剪与 WAL 截断测试
const isolatedDbPath = path.resolve(PROJECT_ROOT, "data", `test-checkpoint-${process.pid}.db`);
function cleanupIsolatedDb() {
  try {
    if (getDatabasePath() === isolatedDbPath) {
      initDatabase();
    }
  } catch {}
  for (const ext of ["", "-wal", "-shm"]) {
    const f = `${isolatedDbPath}${ext}`;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

// 确保初始干净并切换至隔离数据库
cleanupIsolatedDb();
initDatabase(isolatedDbPath);

// 注册退出钩子，异常退出时也能清理临时文件
process.on("exit", () => {
  cleanupIsolatedDb();
});

// -------------------------------------------------------------
// 1. 验证 SQLite 写放大消除与节流修剪机制 (Throttle & Write Amplification Elimination)
// -------------------------------------------------------------
console.log("--- 1. 验证 SQLite 消息写入节流修剪与消除写放大 ---");
const testSession = "group:perf_test_999";

// 清理测试用旧数据
db.prepare("DELETE FROM chat_messages WHERE session_key = ?").run(testSession);
resetMessageInsertCounters();

// 批量插入 39 条消息，应仅执行 INSERT，不触发修剪子查询 (count 递增至 39)
for (let i = 1; i <= 39; i++) {
  recordChatMessage(testSession, 12345, "测试用户", `性能消息 #${i}`, false);
}
assert.strictEqual(getMessageInsertCount(testSession), 39, "前 39 次插入计数器应递增至 39");

const countAfter39 = db.prepare("SELECT COUNT(*) as count FROM chat_messages WHERE session_key = ?").get(testSession).count;
assert.strictEqual(countAfter39, 39, "39 条消息应全部写入，无提前截断");

// 第 40 次插入应触发批量修剪并重置计数器为 0
recordChatMessage(testSession, 12345, "测试用户", "第40条消息触发节流修剪", false);
assert.strictEqual(getMessageInsertCount(testSession), 0, "第 40 次写入后计数器应归零重置");

// 验证 options 灵活传参与 forceTrim：第 7 参数传入 options 对象直接生效
recordChatMessage(testSession, 12345, "测试用户", "单次消息", false, "智子", { forceTrim: true });
assert.strictEqual(getMessageInsertCount(testSession), 0, "forceTrim 应立即修剪并归零计数器");

// 验证 trimChatMessages 边界：插入超过 200 条，验证修剪截断
db.prepare("DELETE FROM chat_messages WHERE session_key = ?").run(testSession);
for (let i = 1; i <= 210; i++) {
  // bypass throttling by direct insert for setup
  db.prepare("INSERT INTO chat_messages (session_key, sender_id, sender_name, message_text) VALUES (?, ?, ?, ?)").run(testSession, 12345, "用户", `消息${i}`);
}
const countBeforeTrim = db.prepare("SELECT COUNT(*) as count FROM chat_messages WHERE session_key = ?").get(testSession).count;
assert.strictEqual(countBeforeTrim, 210, "准备 210 条测试消息");

const trimmedChanges = trimChatMessages(testSession, 200);
assert.strictEqual(trimmedChanges, 10, "trimChatMessages 应修剪超出 200 条的 10 条超限记录");
const countAfterTrim = db.prepare("SELECT COUNT(*) as count FROM chat_messages WHERE session_key = ?").get(testSession).count;
assert.strictEqual(countAfterTrim, 200, "修剪后单群应严格保留 200 条最新消息");

// 清理测试数据
db.prepare("DELETE FROM chat_messages WHERE session_key = ?").run(testSession);
console.log("✅ recordChatMessage 节流批量修剪 (40条阈值) 与写放大消除验证通过！");


// -------------------------------------------------------------
// 2. 验证 SQLite WAL Checkpoint (TRUNCATE) 截断与紧凑维护
// -------------------------------------------------------------
console.log("\n--- 2. 验证 SQLite WAL Checkpoint (TRUNCATE) 截断紧凑维护 ---");
const checkpointRes = checkpointDatabase("TRUNCATE");
assert(checkpointRes !== null, "checkpointDatabase 必须返回执行结果对象");
assert.strictEqual(typeof checkpointRes.busy, "number", "busy 应为数字");
assert.strictEqual(checkpointRes.busy, 0, "独立数据库上 busy 应严格为 0 (消除跨进程并发锁冲突)");
assert.strictEqual(typeof checkpointRes.log, "number", "log 应为数字");
assert.strictEqual(typeof checkpointRes.checkpointed, "number", "checkpointed 应为数字");

// 验证 WAL 文件存在或已截断为 0 字节 (完全隔离的独立库，无外部并发连接干扰截断)
const dbPath = getDatabasePath();
assert.strictEqual(dbPath, isolatedDbPath, "当前应处于独立测试数据库上下文中");
const walPath = `${dbPath}-wal`;
if (fs.existsSync(walPath)) {
  const stat = fs.statSync(walPath);
  console.log(`[*] 当前 ${path.basename(walPath)} 文件大小: ${stat.size} 字节 (已成功紧凑截断)`);
  assert(stat.size <= 32768, "WAL 文件截断后应极为紧凑 (0~32KB 内)");
}
console.log("✅ checkpointDatabase(TRUNCATE) 执行与紧凑截断验证通过！");


// -------------------------------------------------------------
// 3. 验证 WebSocket 广播监听器泄漏修复 (Listener Leak on Stop)
// -------------------------------------------------------------
console.log("\n--- 3. 验证 Web Server eventBus 监听器生命周期与防泄漏 ---");
const testEventBus = new EventEmitter();
const initialListenerCount = testEventBus.listenerCount("broadcast");

const fakeConfig = {
  web: { port: 5198, adminToken: "test-token-phase2" },
  antigravity: { agentPreset: "tomoko" },
  snowLuma: { wsUrl: "ws://127.0.0.1:3001" },
  pricing: {}
};

const serverInstance = createWebServer({
  config: fakeConfig,
  eventBus: testEventBus,
  daemonApi: { getLogBuffer: () => [] }
});

const afterInitCount = testEventBus.listenerCount("broadcast");
assert.strictEqual(afterInitCount, initialListenerCount + 1, "createWebServer 后 broadcast 监听器数量应 +1");

await serverInstance.stop();
const afterStopCount = testEventBus.listenerCount("broadcast");
assert.strictEqual(afterStopCount, initialListenerCount, "server.stop() 后 broadcast 监听器应完全注销，恢复初始计数 (0 泄漏)");

console.log(`✅ Web Server stop() 自动注销 onBroadcast 监听器，杜绝内存泄漏验证通过！ (初始: ${initialListenerCount} -> 创建: ${afterInitCount} -> 停止: ${afterStopCount})`);


// -------------------------------------------------------------
// 4. 验证 异步进程探测与内存 TTL 缓存 (Async Non-Blocking Process Discovery & Caching)
// -------------------------------------------------------------
console.log("\n--- 4. 验证 异步进程探测与内存 TTL 缓存 ---");

// 保存当前环境变量以做隔离测试
const origAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
const origToken = process.env.ANTIGRAVITY_CSRF_TOKEN;

// 4.1 环境变量直连模式校验
assert.strictEqual(typeof discoverLanguageServer, "function");
clearDiscoveryCache();
assert.strictEqual(getCachedLanguageServer(), null, "清理缓存后 getCachedLanguageServer 应返回 null");

// 4.2 真实 Windows PowerShell CIM + netstat 异步探测路径深度测试（移除环境变量触发真正执行）
delete process.env.ANTIGRAVITY_LS_ADDRESS;
delete process.env.ANTIGRAVITY_CSRF_TOKEN;
clearDiscoveryCache();

const t0 = Date.now();
const realResult = await discoverLanguageServer({ forceRefresh: true });
const durReal = Date.now() - t0;
assert(realResult && realResult.address, "真实异步探测必须返回 address");
console.log(`[*] 真实进程非阻塞扫描耗时: ${durReal}ms | 探测结果: ${realResult.address}`);

// 4.3 验证内存缓存二次命中 (<5ms，0 阻塞事件循环)
const t1 = Date.now();
const cachedResult = await discoverLanguageServer();
const durCache = Date.now() - t1;
assert.strictEqual(cachedResult.address, realResult.address, "缓存命中应返回相同 address");
assert.strictEqual(cachedResult.csrfToken, realResult.csrfToken, "缓存命中应返回相同 csrfToken");
assert(durCache < 10, `缓存命中耗时应极短 (实际: ${durCache}ms < 10ms)`);
assert.notStrictEqual(getCachedLanguageServer(), null, "getCachedLanguageServer 应返回有效缓存");
console.log(`[*] 第二次命中缓存耗时: ${durCache}ms (0 阻塞事件循环)`);

// 4.4 恢复环境变量
if (origAddr) process.env.ANTIGRAVITY_LS_ADDRESS = origAddr;
if (origToken) process.env.ANTIGRAVITY_CSRF_TOKEN = origToken;
clearDiscoveryCache();

console.log("✅ 异步进程探测与内存 TTL 缓存全链路验证通过！");


// -------------------------------------------------------------
// 5. 验证 数据库初始化解耦与 start.ps1 脚本清理
// -------------------------------------------------------------
console.log("\n--- 5. 验证 数据库初始化解耦与 start.ps1 清理 ---");
assert.strictEqual(typeof initDatabase, "function", "必须导出 initDatabase 函数");
assert.strictEqual(typeof getDatabasePath, "function", "必须导出 getDatabasePath 函数");
assert(getDatabasePath().length > 0, "getDatabasePath 必须返回非空路径");

// 校验重新 initDatabase 切换内存数据库不崩溃且句柄安全
const prevDb = db;
const memDb = initDatabase(":memory:");
assert.notStrictEqual(memDb, prevDb, "initDatabase(:memory:) 应成功创建独立内存库");
assert.strictEqual(getDatabasePath(), ":memory:");

// 恢复原有主数据库
initDatabase();
assert.strictEqual(getDatabasePath(), path.join(path.resolve(PROJECT_ROOT, "data"), "state.db"));

// 校验 start.ps1 彻底移除了 test-db.mjs 反模式
const startPs1Content = fs.readFileSync(path.resolve(PROJECT_ROOT, "start.ps1"), "utf-8");
assert(!startPs1Content.includes("test/test-db.mjs"), "start.ps1 中不得包含 test/test-db.mjs 反模式");
assert(startPs1Content.includes("src/db.mjs --init"), "start.ps1 必须使用 src/db.mjs --init 正式建表初始化入口");

// 清理隔离测试数据库文件
cleanupIsolatedDb();

console.log("✅ 数据库初始化解耦与 start.ps1 启动初始化入口升级验证通过！");

console.log("\n🎉 Phase 2 架构重构与性能调优专项测试全面深度通过！");
