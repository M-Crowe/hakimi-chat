import { popInboxMessage, cleanStaleInboxMessages } from "../src/db.mjs";

function popMessage() {
  try {
    return popInboxMessage();
  } catch (err) {
    console.error("❌ [popMessage SQLite 异常]:", err?.message || err);
    return null;
  }
}

async function wait() {
  // 启动自愈：消费前主动剔除积压超过 5 分钟的历史陈旧消息
  try {
    cleanStaleInboxMessages(300);
  } catch {}

  const start = Date.now();
  // 最多挂起等待 5 分钟，有消息立即退出返回，降低空转频率
  while (Date.now() - start < 300000) {
    const msg = popMessage();
    if (msg) {
      console.log("NEW_QQ_MESSAGE:" + JSON.stringify(msg));
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log("HEARTBEAT_TIMEOUT");
  process.exit(0);
}

wait();
