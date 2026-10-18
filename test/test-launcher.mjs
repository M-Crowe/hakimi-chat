import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import {
  PROJECT_ROOT,
  findPythonPath,
  RotatingLogger,
  PortManager,
  ProcessSupervisor,
  parseCliArgs,
  HakimiLauncher
} from "../scripts/launcher.mjs";

test("1. Python 路径解析 (findPythonPath)", () => {
  const pyPath = findPythonPath(PROJECT_ROOT);
  assert(typeof pyPath === "string" && pyPath.length > 0, "Python 路径应为非空字符串");
  if (process.platform === "win32") {
    assert(pyPath.includes("python"), "Windows 下 Python 路径应包含 python");
  }
});

test("2. CLI 命令行参数解析 (parseCliArgs)", () => {
  assert.strictEqual(parseCliArgs(["--help"]).mode, "help");
  assert.strictEqual(parseCliArgs(["-h"]).mode, "help");
  assert.strictEqual(parseCliArgs(["--all"]).mode, "all");
  assert.strictEqual(parseCliArgs(["--qq"]).mode, "qq");
  assert.strictEqual(parseCliArgs(["--wechat"]).mode, "wechat");
  assert.strictEqual(parseCliArgs(["--switch"]).mode, "switch");
  assert.strictEqual(parseCliArgs([]).mode, null);
});

test("3. RotatingLogger 格式化、染色与日志文件轮转", async () => {
  const testLogDir = path.join(os.tmpdir(), `hakimi-test-log-${Date.now()}`);
  const maxBytes = 250; // 小体积以便快速触发轮转
  const maxBackups = 3;

  const logger = new RotatingLogger({
    logDir: testLogDir,
    logFile: "test.log",
    maxBytes,
    maxBackups,
    silent: true,
    syncToWeb: false
  });

  // 验证颜色定义
  assert.strictEqual(logger.getTagColor("Launcher"), "\x1b[33m");
  assert.strictEqual(logger.getTagColor("Node"), "\x1b[36m");
  assert.strictEqual(logger.getTagColor("WeChat"), "\x1b[32m");

  // 验证剥离 ANSI
  const colored = "\x1b[33m[Test]\x1b[0m Hello";
  assert.strictEqual(logger.stripAnsi(colored), "[Test] Hello");

  // 验证时间戳格式 (毫秒)
  const ts = logger.formatTimestamp();
  assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/.test(ts), `时间戳格式应含毫秒: ${ts}`);

  // 写入多条日志以触发轮转
  for (let i = 0; i < 20; i++) {
    logger.log("Launcher", `Log message line ${i}: ${"x".repeat(30)}`);
  }

  const logFile = path.join(testLogDir, "test.log");
  const logFile1 = path.join(testLogDir, "test.log.1");

  assert(fs.existsSync(logFile), "当前日志文件 test.log 应存在");
  assert(fs.existsSync(logFile1), "轮转日志文件 test.log.1 应存在");

  // 清理测试目录
  fs.rmSync(testLogDir, { recursive: true, force: true });
});

test("4. PortManager 端口检测与清理", async () => {
  const testPort = 39876;
  const isFreeInitially = await PortManager.isPortAvailable(testPort);
  assert(isFreeInitially, `端口 ${testPort} 初始应处于空闲状态`);

  // 启动一个测试 TCP 监听服务占用端口
  const server = net.createServer();
  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  const isFreeWhileBound = await PortManager.isPortAvailable(testPort);
  assert.strictEqual(isFreeWhileBound, false, `端口 ${testPort} 被占用后应检测为不可用`);

  // 释放端口并关闭
  await new Promise((resolve) => server.close(resolve));
  const isFreeAfterClose = await PortManager.isPortAvailable(testPort);
  assert.strictEqual(isFreeAfterClose, true, `端口 ${testPort} 关闭后应恢复可用`);
});

test("5. ProcessSupervisor 熔断机制 (30秒连续崩溃超5次熔断)", async () => {
  let circuitBroken = false;
  let crashCount = 0;

  const supervisor = new ProcessSupervisor({
    name: "CrashTest",
    tag: "Launcher",
    command: process.execPath,
    args: ["-e", "process.exit(1)"], // 立即崩溃
    autoRestart: true,
    restartBackoffMs: 20, // 快速回退以便加速测试
    maxCrashes: 5,
    crashWindowMs: 5000,
    logger: null,
    onCrash: () => {
      crashCount++;
    },
    onCircuitBreaker: () => {
      circuitBroken = true;
    }
  });

  supervisor.start();

  // 等待熔断发生
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (circuitBroken) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });

  assert.strictEqual(circuitBroken, true, "连续崩溃超限后应触发熔断");
  assert.strictEqual(supervisor.isCircuitBroken, true, "Supervisor 内部熔断标记应置为 true");
  assert(crashCount >= 5, "崩溃计数应达到熔断阈值");

  await supervisor.stop();
});

test("6. 微信日志流同步至 Web 控制台看板 (Port 5120)", async () => {
  const testWebPort = 35129;
  let receivedLog = null;

  // 启动 Mock Web 控制台 HTTP Server
  const mockWebServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/api/system/logs" && req.method === "POST") {
        receivedLog = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404).end();
      }
    });
  });

  await new Promise((resolve) => mockWebServer.listen(testWebPort, "127.0.0.1", resolve));

  const testLogDir = path.join(os.tmpdir(), `hakimi-wechat-log-${Date.now()}`);
  const logger = new RotatingLogger({
    logDir: testLogDir,
    silent: true,
    syncToWeb: true,
    webPort: testWebPort
  });

  logger.log("WeChat", "测试微信日志同步内容：群聊监听正常");

  // 等待 HTTP 推送完成
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (receivedLog) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });

  assert(receivedLog, "Mock Web Server 应收到推流日志");
  assert(receivedLog.text.includes("测试微信日志同步内容"), "推流内容应包含原始日志文本");
  assert.strictEqual(receivedLog.level, "info");

  await new Promise((resolve) => mockWebServer.close(resolve));
  fs.rmSync(testLogDir, { recursive: true, force: true });
});

test("7. 文件归档与根目录脚本布局健全性验证", () => {
  // 检查根目录 start.bat 与 stop.bat
  assert(fs.existsSync(path.join(PROJECT_ROOT, "start.bat")), "根目录 start.bat 应存在");
  assert(fs.existsSync(path.join(PROJECT_ROOT, "stop.bat")), "根目录 stop.bat 应存在");

  // 检查归档目录 scripts/legacy/
  const legacyDir = path.join(PROJECT_ROOT, "scripts", "legacy");
  assert(fs.existsSync(path.join(legacyDir, "start-wechat-bot.bat")), "归档 start-wechat-bot.bat 应存在");
  assert(fs.existsSync(path.join(legacyDir, "switch-desktop.bat")), "归档 switch-desktop.bat 应存在");
  assert(fs.existsSync(path.join(legacyDir, "start.ps1")), "归档 start.ps1 应存在");

  // 检查 package.json 中的 scripts 配置
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
  assert.strictEqual(pkg.scripts["start"], "node scripts/launcher.mjs");
  assert.strictEqual(pkg.scripts["start:all"], "node scripts/launcher.mjs --all");
  assert.strictEqual(pkg.scripts["start:qq"], "node scripts/launcher.mjs --qq");
  assert.strictEqual(pkg.scripts["start:wechat"], "node scripts/launcher.mjs --wechat");
  assert.strictEqual(pkg.scripts["switch:desktop"], "node scripts/launcher.mjs --switch");
});

test("8. ProcessSupervisor 启动不存在程序 (ENOENT) 错误捕获与自愈/熔断", async () => {
  let crashed = false;
  let circuitBroken = false;

  const supervisor = new ProcessSupervisor({
    name: "NonexistentCommandTest",
    tag: "Launcher",
    command: "this_cmd_definitely_does_not_exist_xyz_999",
    args: [],
    autoRestart: true,
    restartBackoffMs: 20,
    maxCrashes: 3,
    crashWindowMs: 5000,
    logger: null,
    onCrash: () => {
      crashed = true;
    },
    onCircuitBreaker: () => {
      circuitBroken = true;
    }
  });

  supervisor.start();

  // 等待熔断发生，验证不会陷入挂起假死
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (circuitBroken) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });

  assert.strictEqual(crashed, true, "ENOENT 错误应触发崩溃处理");
  assert.strictEqual(circuitBroken, true, "ENOENT 连续失败后应正常触发熔断");
  assert.strictEqual(supervisor.child, null, "退出后 child 句柄应重置为 null");

  await supervisor.stop();
});

test("9. PortManager cleanPort 在真实端口被占用时的释放与检测", async () => {
  const testPort = 39877;
  const isFree = await PortManager.isPortAvailable(testPort);
  assert(isFree, `端口 ${testPort} 初始应可用`);

  // 占用端口
  const server = net.createServer();
  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  assert.strictEqual(await PortManager.isPortAvailable(testPort), false, "端口绑定后应不可用");

  // 手动关闭 server 并测试 cleanPort
  await new Promise((resolve) => server.close(resolve));
  const cleaned = await PortManager.cleanPort(testPort);
  assert.strictEqual(cleaned, true, "已关闭端口 cleanPort 应返回 true");
  assert.strictEqual(await PortManager.isPortAvailable(testPort), true, "cleanPort 后端口应恢复可用");
});

test("10. RotatingLogger 过滤 wechatauto 底层无障碍扫描噪音", () => {
  const testLogDir = path.join(process.cwd(), "test", "fixtures", "noise_logs");
  if (fs.existsSync(testLogDir)) fs.rmSync(testLogDir, { recursive: true, force: true });
  fs.mkdirSync(testLogDir, { recursive: true });

  const logger = new RotatingLogger({
    logDir: testLogDir,
    logFile: "test_noise.log",
    silent: true,
    syncToWeb: false
  });

  logger.log("WeChat", "2026-10-18 14:51:45 [wechatauto] [INFO] [accessibility.py:579] UIA 树已物化，已记录 gate RVA: Weixin.dll+0xb3959d8");
  logger.log("WeChat", "2026-10-18 14:51:47 [wechatauto] [INFO] [accessibility.py:571] 热激活 UIA: PID=31436 Weixin.dll+0xb3959d8: 0 -> 1");
  logger.log("WeChat", "正常业务消息：收到来自群聊的消息");

  const logFile = path.join(testLogDir, "test_noise.log");
  const content = fs.readFileSync(logFile, "utf-8");

  assert(!content.includes("UIA 树已物化"), "无障碍物化日志应被成功过滤");
  assert(!content.includes("热激活 UIA"), "热激活日志应被成功过滤");
  assert(content.includes("正常业务消息"), "正常业务消息日志应被保留记录");

  fs.rmSync(testLogDir, { recursive: true, force: true });
});


