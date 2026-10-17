import fs from "node:fs";

let customClient = process.env.CLIENT || (process.env.DSH_HOME ? "dsh" : null);
let customModel = process.env.MODEL_NAME || null;
const cleanArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith("--client=")) {
    customClient = arg.slice(9).trim();
  } else if (arg === "--client" && i + 1 < process.argv.length) {
    customClient = process.argv[++i].trim();
  } else if (arg.startsWith("--model=")) {
    customModel = arg.slice(8).trim();
  } else if (arg === "--model" && i + 1 < process.argv.length) {
    customModel = process.argv[++i].trim();
  } else {
    cleanArgs.push(arg);
  }
}

let [targetType, targetId, message, senderId] = cleanArgs;

// 如果包含更多的切片（由于 PowerShell 换行切开了参数），自动将它们拼接回 message
if (cleanArgs.length > 4) {
  // 如果最后一个参数是纯数字 QQ 号
  const lastArg = cleanArgs[cleanArgs.length - 1];
  if (/^\d+$/.test(lastArg)) {
    senderId = lastArg;
    message = cleanArgs.slice(2, -1).join("\n");
  } else {
    message = cleanArgs.slice(2).join("\n");
  }
}

// 支持从 stdin 读取 (当 message 为 '-' 或 '@stdin' 时) 或处理纯转义 \n
if (message === "-" || message === "@stdin") {
  try {
    message = fs.readFileSync(0, "utf-8");
  } catch {}
}

if (message) {
  message = message.replace(/\\n/g, "\n");
}

if (!targetType || !targetId || !message) {
  console.error("用法: node scripts/send-qq.mjs <group|private> <targetId> <message> [senderId] [--client=dsh] [--model=deepseek-flash]");
  process.exit(1);
}

let port = 34567;
try {
  const cfg = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf-8"));
  if (cfg.daemon?.internalHttpPort) port = cfg.daemon.internalHttpPort;
} catch {}

try {
  const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetType,
      targetId: Number(targetId),
      message,
      senderId: senderId ? Number(senderId) : undefined,
      sessionKey: `${targetType}:${targetId}`,
      client: customClient || undefined,
      modelName: customModel || undefined
    })
  });
  const data = await res.json();
  if (data.success) {
    console.log("SUCCESS");
  } else {
    console.error("FAILED:", data);
    process.exit(1);
  }
} catch (err) {
  console.error("ERROR:", err.message);
  process.exit(1);
}
