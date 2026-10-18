#!/usr/bin/env node

/**
 * 哈基米聊天系统 (Hakimi Launcher)
 * 跨平台生命周期与进程守护总管
 * - 原生 Node.js 编写，零额外第三方依赖
 * - 端口自动检测与占用释放 (34567, 5120, 34568)
 * - 进程生命周期守护、2秒退避自愈与 30s/5次 熔断机制
 * - 优雅退出与跨平台进程树级联清理 (tree-kill)
 * - 控制台日志分流染色 ([Launcher] 黄色 / [Node] 青色 / [WeChat] 绿色) 与毫秒级时间戳
 * - 本地日志轮转 (logs/hakimi.log，10MB 上限，最多 5 个备份)
 * - 微信日志流实时同步至 Web 控制台 (Port 5120)
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");

// -------------------------------------------------------------
// 1. Python 环境与路径解析
// -------------------------------------------------------------
export function findPythonPath(projectRoot = PROJECT_ROOT) {
  const venvCandidates = [".venv-wechat", ".venv", "venv"];
  if (process.platform === "win32") {
    for (const venvDir of venvCandidates) {
      const venvPy = path.join(projectRoot, venvDir, "Scripts", "python.exe");
      if (fs.existsSync(venvPy)) return venvPy;
    }
    try {
      // 必须实际执行测试，排除 WindowsApps 0 字节应用商店占位符 (会报 exit 9009)
      execSync("python -c \"import sys; sys.exit(0)\"", { stdio: "ignore" });
      return "python";
    } catch {
      return null;
    }
  } else {
    for (const venvDir of venvCandidates) {
      const venvPy = path.join(projectRoot, venvDir, "bin", "python");
      if (fs.existsSync(venvPy)) return venvPy;
    }
    try {
      execSync("python3 -c \"import sys; sys.exit(0)\"", { stdio: "ignore" });
      return "python3";
    } catch {
      try {
        execSync("python -c \"import sys; sys.exit(0)\"", { stdio: "ignore" });
        return "python";
      } catch {
        return null;
      }
    }
  }
}

// -------------------------------------------------------------
// 2. 本地日志轮转与控制台染色 (RotatingLogger)
// -------------------------------------------------------------
export class RotatingLogger {
  constructor({
    logDir = path.resolve(PROJECT_ROOT, "logs"),
    logFile = "hakimi.log",
    maxBytes = 10 * 1024 * 1024, // 10MB
    maxBackups = 5,
    silent = false,
    syncToWeb = true,
    webPort = 5120
  } = {}) {
    this.logDir = logDir;
    this.logFilePath = path.join(logDir, logFile);
    this.maxBytes = maxBytes;
    this.maxBackups = maxBackups;
    this.silent = silent;
    this.syncToWeb = syncToWeb;
    this.webPort = webPort;
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  formatTimestamp(date = new Date()) {
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    const ms = pad(date.getMilliseconds(), 3);
    return `${y}-${m}-${d} ${h}:${min}:${s}.${ms}`;
  }

  stripAnsi(str) {
    return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  }

  getTagColor(tag) {
    switch (tag) {
      case "Launcher":
        return "\x1b[33m"; // 黄色 (Yellow)
      case "Node":
        return "\x1b[36m"; // 青色 (Cyan)
      case "WeChat":
        return "\x1b[32m"; // 绿色 (Green)
      default:
        return "\x1b[37m"; // 白色
    }
  }

  log(tag, message, level = "info") {
    const timeStr = this.formatTimestamp();
    const cleanMsg = typeof message === "string" ? message : String(message);

    // 过滤掉 wechatauto 底层高频重复的无障碍热激活/物化探测噪音日志
    if (/UIA\s*树已物化|热激活\s*UIA|gate\s*RVA/i.test(cleanMsg)) {
      return;
    }

    // 1. 控制台彩色输出
    if (!this.silent) {
      const color = this.getTagColor(tag);
      const coloredTag = `${color}[${tag}]\x1b[0m`;
      const timeTag = `\x1b[90m[${timeStr}]\x1b[0m`;
      const line = `${timeTag} ${coloredTag} ${cleanMsg}`;
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
    }

    // 2. 写入文件（纯文本，剥离 ANSI 颜色代码）
    this.writeToFile(`[${timeStr}] [${tag}] [${level.toUpperCase()}] ${this.stripAnsi(cleanMsg)}\n`);

    // 3. 微信日志流同步至 Node Web 控制台看板 (Port 5120)
    if (tag === "WeChat" && this.syncToWeb) {
      this.forwardLogToWeb(cleanMsg, level);
    }
  }

  writeToFile(text) {
    try {
      this.ensureDir();
      this.rotateIfNeeded();
      fs.appendFileSync(this.logFilePath, text, "utf-8");
    } catch {}
  }

  rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const stat = fs.statSync(this.logFilePath);
      if (stat.size >= this.maxBytes) {
        // Hakimi.log.5 删除，4->5, 3->4, ..., log->1
        const oldestBackup = `${this.logFilePath}.${this.maxBackups}`;
        if (fs.existsSync(oldestBackup)) {
          fs.unlinkSync(oldestBackup);
        }
        for (let i = this.maxBackups - 1; i >= 1; i--) {
          const src = `${this.logFilePath}.${i}`;
          const dst = `${this.logFilePath}.${i + 1}`;
          if (fs.existsSync(src)) {
            fs.renameSync(src, dst);
          }
        }
        fs.renameSync(this.logFilePath, `${this.logFilePath}.1`);
      }
    } catch {}
  }

  forwardLogToWeb(line, level = "info") {
    try {
      const payload = JSON.stringify({
        level,
        text: `[WeChat] ${line}`,
        message: `[WeChat] ${line}`,
        time: new Date().toLocaleTimeString()
      });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.webPort,
          path: "/api/system/logs",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          },
          agent: this.httpAgent,
          timeout: 1000
        },
        (res) => {
          res.resume();
        }
      );
      req.on("error", () => {});
      req.on("timeout", () => {
        req.destroy();
      });
      req.write(payload);
      req.end();
    } catch {}
  }
}

// -------------------------------------------------------------
// 3. 端口检测与释放管理 (PortManager)
// -------------------------------------------------------------
export class PortManager {
  static async isPortAvailable(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, host);
    });
  }

  static findPidsByPort(port) {
    const pids = new Set();
    const isWin = process.platform === "win32";
    try {
      if (isWin) {
        const output = execSync("netstat -ano -p tcp", { stdio: ["pipe", "pipe", "ignore"] }).toString();
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
          if (!line.includes("LISTENING")) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const localAddr = parts[1];
            const portMatch = localAddr.match(/:(\d+)$/);
            if (portMatch && parseInt(portMatch[1], 10) === Number(port)) {
              const pid = parseInt(parts[parts.length - 1], 10);
              if (pid > 0 && pid !== process.pid) {
                pids.add(pid);
              }
            }
          }
        }
      } else {
        try {
          const output = execSync(`lsof -ti :${port}`, { stdio: ["pipe", "pipe", "ignore"] }).toString();
          for (const line of output.split(/\r?\n/)) {
            const pid = parseInt(line.trim(), 10);
            if (pid > 0 && pid !== process.pid) pids.add(pid);
          }
        } catch {
          // Fallback to ss if lsof is missing
          try {
            const ssOut = execSync(`ss -tlnp "sport = :${port}"`, { stdio: ["pipe", "pipe", "ignore"] }).toString();
            for (const match of ssOut.matchAll(/pid=(\d+)/g)) {
              const pid = parseInt(match[1], 10);
              if (pid > 0 && pid !== process.pid) pids.add(pid);
            }
          } catch {}
        }
      }
    } catch {}
    return Array.from(pids);
  }

  static killPidSync(pid) {
    if (!pid || pid === process.pid) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      } else {
        try {
          execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`, { stdio: "ignore" });
        } catch {}
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    } catch {}
  }

  static async killPid(pid) {
    PortManager.killPidSync(pid);
  }

  static async cleanPort(port, logger = null) {
    const isFree = await PortManager.isPortAvailable(port);
    if (isFree) return true;

    const pids = PortManager.findPidsByPort(port);
    if (pids.length > 0) {
      for (const pid of pids) {
        if (logger) {
          logger.log("Launcher", `检测到端口 ${port} 被旧进程占用 (PID: ${pid})，正在强制释放...`, "warn");
        }
        await PortManager.killPid(pid);
      }
    } else if (logger) {
      logger.log("Launcher", `检测到端口 ${port} 被占用但无法直接解析 PID，正在尝试释放...`, "warn");
    }

    // 等待端口释放（最多 1.5 秒）
    for (let i = 0; i < 15; i++) {
      const free = await PortManager.isPortAvailable(port);
      if (free) return true;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (logger) {
      logger.log("Launcher", `❌ 端口 ${port} 释放失败，仍处于占用状态！`, "error");
    }
    return false;
  }

  static async cleanAll(ports = [34567, 5120, 34568], logger = null) {
    let allClean = true;
    for (const port of ports) {
      const ok = await PortManager.cleanPort(port, logger);
      if (!ok) allClean = false;
    }
    return allClean;
  }
}

// -------------------------------------------------------------
// 4. 子进程生命周期守护者 (ProcessSupervisor)
// -------------------------------------------------------------
export class ProcessSupervisor {
  constructor({
    name,
    tag,
    command,
    args = [],
    cwd = PROJECT_ROOT,
    env = process.env,
    logger = null,
    autoRestart = true,
    restartBackoffMs = 2000,
    maxCrashes = 5,
    crashWindowMs = 30000,
    portToClean = null,
    onCrash = null,
    onCircuitBreaker = null
  }) {
    this.name = name;
    this.tag = tag;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.logger = logger;
    this.autoRestart = autoRestart;
    this.restartBackoffMs = restartBackoffMs;
    this.maxCrashes = maxCrashes;
    this.crashWindowMs = crashWindowMs;
    this.portToClean = portToClean;
    this.onCrash = onCrash;
    this.onCircuitBreaker = onCircuitBreaker;

    this.child = null;
    this.crashTimestamps = [];
    this.isCircuitBroken = false;
    this.isShuttingDown = false;
    this.restartTimer = null;
  }

  start() {
    if (this.isShuttingDown || this.isCircuitBroken) return;

    this.logger?.log("Launcher", `正在拉起子服务 [${this.name}]...`);

    try {
      this.child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...this.env, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      this.logger?.log("Launcher", `启动子服务 [${this.name}] 失败: ${err.message}`, "error");
      this.handleCrash(-1, null);
      return;
    }

    this.attachStreams(this.child);

    let hasExited = false;
    const onExitOrError = (code, signal, err) => {
      if (hasExited) return;
      hasExited = true;
      const pid = this.child?.pid;
      this.child = null;
      if (this.isShuttingDown) return;

      if (err) {
        this.logger?.log("Launcher", `子服务 [${this.name}] 发生致命启动/运行时错误: ${err.message}`, "error");
      } else {
        this.logger?.log(
          "Launcher",
          `子服务 [${this.name}] (PID: ${pid}) 已退出 (code: ${code}, signal: ${signal})`,
          code === 0 ? "info" : "warn"
        );
      }

      if (this.autoRestart) {
        this.handleCrash(code ?? -1, signal);
      }
    };

    this.child.on("error", (err) => {
      this.logger?.log(this.tag, `子进程错误: ${err.message}`, "error");
      onExitOrError(-1, null, err);
    });

    this.child.on("exit", (code, signal) => {
      onExitOrError(code, signal, null);
    });
  }

  attachStreams(child) {
    if (!child) return;

    const pipeLines = (stream, level) => {
      if (!stream) return;
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        this.logger?.log(this.tag, line, level);
      });
    };

    pipeLines(child.stdout, "info");
    pipeLines(child.stderr, "warn");
  }

  handleCrash(code, signal) {
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t <= this.crashWindowMs);
    this.crashTimestamps.push(now);

    if (this.crashTimestamps.length > this.maxCrashes) {
      this.isCircuitBroken = true;
      this.logger?.log(
        "Launcher",
        `🚨 [熔断告警] 子服务 [${this.name}] 在 ${Math.round(this.crashWindowMs / 1000)} 秒内连续崩溃 ${this.crashTimestamps.length} 次！已触发熔断保护，暂停自动重试以防资源耗尽。`,
        "error"
      );
      if (this.onCircuitBreaker) {
        this.onCircuitBreaker(this);
      }
      return;
    }

    this.logger?.log(
      "Launcher",
      `子服务 [${this.name}] 将在 ${this.restartBackoffMs / 1000} 秒后尝试自愈重启... (30秒内崩溃: ${this.crashTimestamps.length}/${this.maxCrashes})`,
      "warn"
    );

    if (this.onCrash) {
      this.onCrash(this, code, signal);
    }

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (!this.isShuttingDown && !this.isCircuitBroken) {
        if (this.portToClean) {
          await PortManager.cleanPort(this.portToClean, this.logger);
        }
        this.start();
      }
    }, this.restartBackoffMs);
  }

  async stop() {
    this.isShuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child && this.child.pid) {
      const pid = this.child.pid;
      this.child = null;
      await PortManager.killPid(pid);
    }
  }
}

// -------------------------------------------------------------
// 5. 命令行参数解析 (CLI Parser)
// -------------------------------------------------------------
export function parseCliArgs(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    return { mode: "help" };
  }
  if (args.includes("--all")) {
    return { mode: "all" };
  }
  if (args.includes("--qq")) {
    return { mode: "qq" };
  }
  if (args.includes("--wechat")) {
    return { mode: "wechat" };
  }
  if (args.includes("--switch")) {
    return { mode: "switch" };
  }
  return { mode: null };
}

// -------------------------------------------------------------
// 6. 主守护控制总管 (HakimiLauncher)
// -------------------------------------------------------------
export class HakimiLauncher {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || PROJECT_ROOT;
    this.ports = options.ports || [34567, 5120, 34568];
    this.logger =
      options.logger ||
      new RotatingLogger({
        logDir: path.join(this.projectRoot, "logs"),
        silent: options.silent || false
      });
    this.supervisors = [];
    this.isShuttingDown = false;
  }

  ensureNodeDependencies() {
    const nodeModulesPath = path.join(this.projectRoot, "node_modules");
    const wsModulePath = path.join(nodeModulesPath, "ws");
    if (!fs.existsSync(nodeModulesPath) || !fs.existsSync(wsModulePath)) {
      this.logger.log("Launcher", "📦 检测到尚未安装 Node.js 核心依赖包，正在自动执行 npm install...", "warn");
      try {
        execSync("npm install", {
          cwd: this.projectRoot,
          stdio: "inherit"
        });
        this.logger.log("Launcher", "✅ Node.js 核心依赖安装成功！");
      } catch {
        this.logger.log("Launcher", "⚠️ npm 默认源安装较慢或失败，尝试国内镜像加速安装...", "warn");
        try {
          execSync("npm install --registry=https://registry.npmmirror.com", {
            cwd: this.projectRoot,
            stdio: "inherit"
          });
          this.logger.log("Launcher", "✅ 镜像源安装成功！");
        } catch (err) {
          this.logger.log("Launcher", `❌ npm 依赖安装失败: ${err.message}`, "error");
        }
      }
    }

    // 检查 SQLite 数据区初始化
    const dbPath = path.join(this.projectRoot, "data", "state.db");
    const dbScriptPath = path.join(this.projectRoot, "src", "db.mjs");
    if (!fs.existsSync(dbPath) && fs.existsSync(dbScriptPath)) {
      try {
        this.logger.log("Launcher", "正在初始化本地持久化数据库 (data/state.db)...");
        execSync(`"${process.execPath}" --experimental-sqlite "${dbScriptPath}" --init`, {
          cwd: this.projectRoot,
          stdio: "ignore"
        });
        this.logger.log("Launcher", "✅ 本地数据库初始化完成");
      } catch {}
    }
  }

  ensureWechatEnvironment() {
    const venvPath = path.join(this.projectRoot, ".venv-wechat");
    const venvPy = process.platform === "win32"
      ? path.join(venvPath, "Scripts", "python.exe")
      : path.join(venvPath, "bin", "python");

    const hasUv = (() => {
      try {
        execSync(process.platform === "win32" ? "where uv" : "which uv", { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

    let py = findPythonPath(this.projectRoot);

    // 只要本地还没有 .venv-wechat 且系统有 uv，无条件优先使用 uv 秒级初始化项目专属虚拟环境 (Python 3.12)
    if (!fs.existsSync(venvPy) && hasUv) {
      this.logger.log("Launcher", "⚡ 检测到系统已安装 uv，正在为微信伴聊初始化 .venv-wechat 虚拟环境 (Python 3.12)...", "warn");
      try {
        execSync("uv venv .venv-wechat --python 3.12", { cwd: this.projectRoot, stdio: "inherit" });
        if (fs.existsSync(venvPy)) {
          py = venvPy;
          this.logger.log("Launcher", "✅ .venv-wechat 虚拟环境创建成功！");
        }
      } catch (err) {
        this.logger.log("Launcher", `⚠️ uv venv 创建跳过: ${err.message}`, "warn");
      }
    }

    if (!py) {
      return { ready: false, reason: "NOT_FOUND" };
    }

    // 测试核心依赖是否齐全 (win32gui, PIL)
    try {
      execSync(`"${py}" -c "import win32gui, PIL"`, { stdio: "ignore" });
      return { ready: true, py };
    } catch {
      // 依赖不齐全，尝试自动安装
      const reqPath = path.join(this.projectRoot, "requirements-wechat.txt");
      if (fs.existsSync(reqPath)) {
        this.logger.log("Launcher", "📦 检测到微信服务缺少必要 Python 库，正在自动安装 (requirements-wechat.txt)...", "warn");
        try {
          if (hasUv && fs.existsSync(venvPy)) {
            // 精确指定虚拟环境 python.exe 路径，绝不碰 WindowsApps
            execSync(`uv pip install -r "${reqPath}" --python "${venvPy}"`, {
              cwd: this.projectRoot,
              stdio: "inherit"
            });
          } else if (hasUv) {
            execSync(`uv pip install -r "${reqPath}"`, {
              cwd: this.projectRoot,
              stdio: "inherit"
            });
          } else {
            // 标准 pip 安装
            execSync(`"${py}" -m pip install -r "${reqPath}" -i https://pypi.tuna.tsinghua.edu.cn/simple`, {
              cwd: this.projectRoot,
              stdio: "inherit"
            });
          }
          return { ready: true, py };
        } catch (err) {
          this.logger.log("Launcher", `⚠️ 微信 Python 依赖自动安装未完全成功: ${err.message}`, "warn");
          return { ready: false, reason: "INSTALL_FAILED" };
        }
      }
      return { ready: false, reason: "MISSING_MODULES" };
    }
  }

  async initEnvironment() {
    this.logger.log("Launcher", "===================================================");
    this.logger.log("Launcher", "🚀 哈基米聊天系统 (Hakimi Launcher) 守护总管启动中");
    this.logger.log("Launcher", "===================================================");

    // 1. 检查并确保 Node.js 基础依赖环境
    this.ensureNodeDependencies();

    // 2. 检查并自动清理端口占用
    this.logger.log("Launcher", `正在检查并清理服务端口占用 (${this.ports.join(", ")})...`);
    await PortManager.cleanAll(this.ports, this.logger);
    this.logger.log("Launcher", "✅ 所有服务端口检查就绪");
  }

  async runDesktopSwitcher() {
    if (process.platform !== "win32") {
      this.logger.log("Launcher", "⚠️ 微信虚拟桌面隔离仅支持 Windows 系统平台！", "warn");
      return;
    }

    const py = findPythonPath(this.projectRoot);
    if (!py) {
      this.logger.log("Launcher", "❌ [错误] 未检测到 Python 环境，无法调起桌面穿梭器。请先安装 Python 3.10+ 并勾选 Add to PATH。", "error");
      return;
    }

    const scriptPath = path.join(this.projectRoot, "scripts", "desktop-switcher.py");
    this.logger.log("Launcher", "正在启动微信虚拟桌面穿梭器...");
    const child = spawn(py, [scriptPath], {
      cwd: this.projectRoot,
      stdio: "inherit"
    });

    return new Promise((resolve) => {
      child.on("exit", (code) => {
        this.logger.log("Launcher", `穿梭器运行完毕 (code: ${code})`);
        resolve(code);
      });
    });
  }

  setupGracefulShutdown() {
    const handleSignal = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      this.logger.log("Launcher", `收到 ${signal} 退出信号，正在优雅关闭所有子服务并释放端口...`, "warn");

      if (this.win32Rl) {
        try { this.win32Rl.close(); } catch {}
        this.win32Rl = null;
      }

      for (const supervisor of this.supervisors) {
        await supervisor.stop();
      }

      await PortManager.cleanAll(this.ports, this.logger);
      this.logger.log("Launcher", "🛑 守护总管已安全退出");
      process.exit(0);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGHUP", () => handleSignal("SIGHUP"));

    // 捕获 process.exit 事件，确保任何意外退出或中断时，同步彻底级联杀死全部子进程树
    process.on("exit", () => {
      for (const supervisor of this.supervisors) {
        if (supervisor.child?.pid) {
          PortManager.killPidSync(supervisor.child.pid);
        }
      }
    });

    if (process.platform === "win32" && process.stdin.isTTY) {
      this.win32Rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      this.win32Rl.on("SIGINT", () => handleSignal("SIGINT"));
    }
  }

  async startServices(mode = "all") {
    await this.initEnvironment();
    this.setupGracefulShutdown();

    const nodeExec = process.execPath;
    let wechatLaunched = false;

    // 1. WeChat 微信子进程
    if (mode === "all" || mode === "wechat") {
      if (process.platform === "win32") {
        const wechatEnv = this.ensureWechatEnvironment();
        if (wechatEnv.ready) {
          const wechatSupervisor = new ProcessSupervisor({
            name: "WeChat-Service",
            tag: "WeChat",
            command: wechatEnv.py,
            args: ["-u", path.join(this.projectRoot, "scripts", "wechat-service.py")],
            cwd: this.projectRoot,
            logger: this.logger,
            portToClean: 34568
          });
          this.supervisors.push(wechatSupervisor);
          wechatSupervisor.start();
          wechatLaunched = true;
        } else {
          if (mode === "wechat") {
            this.logger.log("Launcher", "❌ [错误] 无法启动微信服务: 未检测到可用的 Python 运行环境或依赖安装失败。", "error");
            this.logger.log("Launcher", "💡 推荐安装 uv (免手动装 Python): powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"", "warn");
            this.logger.log("Launcher", "   或安装 Python 3.10+ (勾选 Add to PATH) 并执行: pip install -r requirements-wechat.txt", "warn");
            return;
          } else {
            this.logger.log("Launcher", "⚠️ [提示] 未检测到 Python 微信运行环境，微信伴聊子服务已自动跳过。", "warn");
            this.logger.log("Launcher", "💡 系统已平滑降级为纯 QQ/Web 模式。", "warn");
            this.logger.log("Launcher", "💡 强烈建议安装 uv (免手动装 Python): powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"", "warn");
            this.logger.log("Launcher", "   安装 uv 后重新双击 start.bat，启动器将全自动完成 Python 3.12 虚拟环境搭建与拉起！", "warn");
          }
        }
      } else {
        this.logger.log("Launcher", "⚠️ 检测到非 Windows 系统，微信虚拟桌面服务跳过，仅运行 Node 核心。", "warn");
      }
    }

    // 2. Node.js QQ 伴聊大脑核心
    if (mode === "all" || mode === "qq") {
      const nodeSupervisor = new ProcessSupervisor({
        name: "Node-Core",
        tag: "Node",
        command: nodeExec,
        args: ["--experimental-sqlite", path.join(this.projectRoot, "src", "bridge-daemon.mjs")],
        cwd: this.projectRoot,
        logger: this.logger,
        portToClean: 34567
      });
      this.supervisors.push(nodeSupervisor);
      nodeSupervisor.start();
    }

    this.logger.log("Launcher", "===================================================");
    this.logger.log("Launcher", "✅ 哈基米服务矩阵全部拉起，进程守护巡航中");
    this.logger.log("Launcher", "• Web 运维看板: http://127.0.0.1:5120");
    this.logger.log("Launcher", "• 内部 IPC 网关: http://127.0.0.1:34567");
    if (wechatLaunched) {
      this.logger.log("Launcher", "• 微信守护 API: http://127.0.0.1:34568/health");
    } else {
      this.logger.log("Launcher", "• 微信守护状态: 未启用 (当前运行纯 QQ/Web 模式)");
    }
    this.logger.log("Launcher", "• 日志轮转路径: logs/hakimi.log (10MB 自动轮转保留5份)");
    this.logger.log("Launcher", "• 退出服务: 按 Ctrl+C 即可级联退出并释放所有端口");
    this.logger.log("Launcher", "===================================================");
  }
}

// -------------------------------------------------------------
// 7. 交互式终端菜单展示 (Interactive Menu)
// -------------------------------------------------------------
export async function promptMenu() {
  console.log("\n===================================================");
  console.log("    哈基米聊天系统 (Hakimi Launcher) 控制总管");
  console.log("===================================================");
  console.log("请选择启动模式:");
  console.log("  [1] 全量伴聊模式 (Node.js QQ + Python 微信4.1) [默认]");
  console.log("  [2] 仅 QQ 模式 (Node.js QQ 核心)");
  console.log("  [3] 切换微信虚拟桌面 (穿梭器)");
  console.log("  [4] 退出");
  console.log("===================================================");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.on("SIGINT", () => {
      rl.close();
      console.log("\n已取消操作。");
      process.exit(0);
    });

    rl.question("请输入选项 [1-4] (直接回车默认选择 [1]): ", (answer) => {
      rl.close();
      const choice = (answer || "1").trim();
      if (choice === "1") resolve("all");
      else if (choice === "2") resolve("qq");
      else if (choice === "3") resolve("switch");
      else if (choice === "4") resolve("exit");
      else {
        console.log("⚠️ 无效输入，默认进入全量伴聊模式 [1]");
        resolve("all");
      }
    });
  });
}

// -------------------------------------------------------------
// 8. 命令行入口执行
// -------------------------------------------------------------
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectExecution) {
  const { mode: cliMode } = parseCliArgs();

  if (cliMode === "help") {
    console.log(`
哈基米伴聊系统 (Hakimi Launcher) 命令行使用说明:
  node scripts/launcher.mjs [选项]

选项:
  --all      全量启动 (Node.js QQ + Python 微信4.1) [默认]
  --qq       仅启动 QQ 核心服务 (Port 34567, 5120)
  --wechat   仅启动微信后台守护服务 (Port 34568)
  --switch   调起微信虚拟桌面穿梭器
  --help, -h 显示此帮助信息
`);
    process.exit(0);
  }

  (async () => {
    let selectedMode = cliMode;

    if (!selectedMode) {
      if (process.stdin.isTTY) {
        selectedMode = await promptMenu();
      } else {
        selectedMode = "all";
      }
    }

    if (selectedMode === "exit") {
      console.log("已退出。");
      process.exit(0);
    }

    const launcher = new HakimiLauncher();

    if (selectedMode === "switch") {
      await launcher.runDesktopSwitcher();
      process.exit(0);
    }

    await launcher.startServices(selectedMode);
  })().catch((err) => {
    console.error("启动失败:", err);
    process.exit(1);
  });
}
