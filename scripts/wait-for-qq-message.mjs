import fs from "node:fs";
import path from "node:path";
import { popInboxMessage, cleanStaleInboxMessages, PROJECT_ROOT } from "../src/db.mjs";

const INBOX_PATH = path.resolve(PROJECT_ROOT, "data/inbox.json");

function pruneInboxJson(msgId = null) {
  if (!fs.existsSync(INBOX_PATH)) return;
  try {
    const list = JSON.parse(fs.readFileSync(INBOX_PATH, "utf-8"));
    if (Array.isArray(list)) {
      const now = Date.now();
      // 过滤指定消费完成的 ID 以及超过 5 分钟 (300,000ms) 的陈旧条目
      const filtered = list.filter(m => {
        if (msgId && m.id === msgId) return false;
        if (m.id && typeof m.id === "number" && (now - m.id > 300000)) return false;
        return true;
      });
      if (filtered.length !== list.length) {
        fs.writeFileSync(INBOX_PATH, JSON.stringify(filtered, null, 2), "utf-8");
      }
    }
  } catch {}
}

function popMessage() {
  // 1. 优先从 SQLite 数据库原子队列中单条出队，消除并发竞态
  try {
    const dbMsg = popInboxMessage();
    if (dbMsg) {
      pruneInboxJson(dbMsg.id);
      return dbMsg;
    }
    // SQLite 正常可用且队列为空时直接返回 null，不回退读取遗留文件造成旧消息重放
    return null;
  } catch (err) {
    // 2. 仅在 SQLite 发生异常时，降级从 inbox.json 兜底出队
    if (fs.existsSync(INBOX_PATH)) {
      try {
        const list = JSON.parse(fs.readFileSync(INBOX_PATH, "utf-8"));
        if (Array.isArray(list) && list.length > 0) {
          const msg = list.shift();
          fs.writeFileSync(INBOX_PATH, JSON.stringify(list, null, 2), "utf-8");
          return msg;
        }
      } catch {}
    }
  }
  return null;
}

async function wait() {
  // 启动自愈：消费前主动剔除积压超过 5 分钟的历史陈旧消息
  try {
    cleanStaleInboxMessages(300);
    pruneInboxJson();
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
