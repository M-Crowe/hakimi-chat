import fs from "node:fs";

let [targetType, targetId, message, senderId] = process.argv.slice(2);

// 如果包含更多的切片（由于 PowerShell 换行切开了参数），自动将它们拼接回 message
if (process.argv.length > 5) {
  // 如果最后一个参数是纯数字 QQ 号
  const lastArg = process.argv[process.argv.length - 1];
  if (/^\d+$/.test(lastArg)) {
    senderId = lastArg;
    message = process.argv.slice(4, -1).join("\n");
  } else {
    message = process.argv.slice(4).join("\n");
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
  console.error("用法: node scripts/send-qq.mjs <group|private> <targetId> <message> [senderId]");
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
      sessionKey: `${targetType}:${targetId}`
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
