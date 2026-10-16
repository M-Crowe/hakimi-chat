import { execSync } from "node:child_process";

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

