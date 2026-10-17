import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { calculateTokenCost } from "./pricing.mjs";

/**
 * 自动发现本地正在运行的 Antigravity Language Server 端口和 CSRF Token
 */
export function discoverLanguageServer() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    let addr = process.env.ANTIGRAVITY_LS_ADDRESS.trim();
    if (!addr.startsWith("http://") && !addr.startsWith("https://")) {
      addr = `http://${addr}`;
    }
    return {
      address: addr,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN.trim()
    };
  }

  try {
    const psCmd = `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name = 'language_server.exe'\\") | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
    const out = execSync(psCmd, { encoding: "utf-8" }).trim();
    if (!out) return null;

    let proc = JSON.parse(out);
    if (Array.isArray(proc)) proc = proc[0];

    const cmdLine = proc.CommandLine || "";
    const pid = proc.ProcessId;

    const tokenMatch = cmdLine.match(/--csrf_token\s+([^\s]+)/);
    const csrfToken = tokenMatch ? tokenMatch[1] : "";

    // 查找该 pid 监听的所有 127.0.0.1 端口
    const netstatOut = execSync(`netstat -ano | findstr ${pid} | findstr LISTENING`, { encoding: "utf-8" });
    const matches = [...netstatOut.matchAll(/127\.0\.0\.1:(\d+)/g)];
    const ports = matches.map(m => m[1]);

    // 6714 通常为 ConnectRPC 服务端口，如果有 6714 则优先选 6714，否则选最大的端口
    let selectedPort = ports.find(p => p === "6714") || ports[ports.length - 1];

    if (selectedPort && csrfToken) {
      return {
        address: `http://127.0.0.1:${selectedPort}`,
        csrfToken
      };
    }
  } catch (err) {
    console.warn("[Auto-Discovery] 自动探测 Antigravity Language Server 异常:", err.message);
  }

  return {
    address: "http://127.0.0.1:6714",
    csrfToken: ""
  };
}

/**
 * 直接探测本地 Antigravity Language Server 配额与防爆健康看板
 */
export async function queryLanguageServerQuota(forceRefresh = true) {
  const { AgyConnectRpcClient } = await import("./connect-rpc-client.mjs");
  const client = new AgyConnectRpcClient();
  return await client.getCombinedQuotaHealth(forceRefresh);
}

/**
 * 实时同步 Antigravity 伴聊大脑物理 Token 交互指标（完全对齐 IDE Token Monitor）
 * 包含：物理总用量、KV Cache 上下文命中率、物理新输入、回复与思考输出、物理执行步数与每日趋势
 */
export async function getAntigravityBrainTokenStats({ days = 7, conversationId = null } = {}) {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  if (!homeDir) return { success: false, reason: "no_home_dir" };

  const agyBase = path.join(homeDir, ".gemini", "antigravity");
  const dbPath = path.join(agyBase, "conversation_summaries.db");
  const brainDir = path.join(agyBase, "brain");

  if (!fs.existsSync(dbPath) || !fs.existsSync(brainDir)) {
    return { success: false, reason: "antigravity_dir_not_found" };
  }

  let db = null;
  let targetConversation = null;
  const companionSessions = [];

  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT conversation_id, title, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 100").all();

    for (const r of rows) {
      const tPath = path.join(brainDir, r.conversation_id, ".system_generated", "logs", "transcript.jsonl");
      if (!fs.existsSync(tPath)) continue;

      const isMatch = /hajimi|哈基米|tomoko|智子|伴聊|One-Click/i.test(r.title || "");
      if (isMatch) {
        companionSessions.push(r);
      }
    }

    if (conversationId) {
      targetConversation = rows.find(r => r.conversation_id === conversationId) || null;
    }
    if (!targetConversation && companionSessions.length > 0) {
      targetConversation = companionSessions[0];
    }
    if (!targetConversation && rows.length > 0) {
      // 降级选择最新有 transcript 的会话
      for (const r of rows) {
        const tPath = path.join(brainDir, r.conversation_id, ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(tPath)) {
          targetConversation = r;
          break;
        }
      }
    }
  } catch (err) {
    console.warn("[AntigravityBrain] 读取 conversation_summaries 异常:", err.message);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }

  if (!targetConversation) {
    return { success: false, reason: "no_companion_session_found" };
  }

  const logPath = path.join(brainDir, targetConversation.conversation_id, ".system_generated", "logs", "transcript.jsonl");
  if (!fs.existsSync(logPath)) {
    return { success: false, reason: "transcript_not_found" };
  }

  return new Promise((resolve) => {
    const fileStream = fs.createReadStream(logPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    let steps = 0;
    const trendMap = new Map();
    const recentSteps = [];

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.input_tokens === "number") {
          steps++;
          const inp = obj.input_tokens || 0;
          const cache = obj.cache_read_tokens || 0;
          const out = obj.output_tokens || 0;
          const tot = inp + cache + out;
          totalInput += inp;
          totalCache += cache;
          totalOutput += out;

          const date = (obj.created_at || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
          if (!trendMap.has(date)) {
            trendMap.set(date, { date, turns: 0, tokens: 0, prompt_tokens: 0, reply_tokens: 0, cached_tokens: 0 });
          }
          const day = trendMap.get(date);
          day.turns++;
          day.tokens += tot;
          day.prompt_tokens += inp;
          day.reply_tokens += out;
          day.cached_tokens += cache;

          let toolName = null;
          if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
            toolName = obj.tool_calls.map(t => t.name).join(", ");
          }

          if (recentSteps.length >= 20) recentSteps.shift();
          recentSteps.push({
            step_index: obj.step_index,
            created_at: obj.created_at,
            input_tokens: inp,
            cache_read_tokens: cache,
            output_tokens: out,
            total_tokens: tot,
            tool_name: toolName
          });
        }
      } catch {}
    });

    rl.on("close", () => {
      const totalPhysical = totalInput + totalCache + totalOutput;
      const totalPrompt = totalInput + totalCache;
      const hitRate = totalPrompt > 0 ? (totalCache / totalPrompt) : 0;
      const trend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date));

      const cost = calculateTokenCost({
        modelName: "gemini-2.5-pro",
        promptTokens: totalInput,
        replyTokens: totalOutput,
        cachedTokens: totalCache
      });

      resolve({
        success: true,
        conversationId: targetConversation.conversation_id,
        title: targetConversation.title,
        lastModified: targetConversation.last_modified_time,
        steps,
        totalTokens: totalPhysical,
        cachedTokens: totalCache,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheHitRate: Number(hitRate.toFixed(4)),
        cacheHitPercent: Number((hitRate * 100).toFixed(1)),
        costCny: cost.costCny,
        costUsd: cost.costUsd,
        modelName: cost.modelName,
        trend,
        recentSteps: recentSteps.reverse(),
        companionSessions: companionSessions.map(s => ({
          conversationId: s.conversation_id,
          title: s.title,
          lastModified: s.last_modified_time
        }))
      });
    });

    rl.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

