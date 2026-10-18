import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer } from "../src/web-server.mjs";
import { EventEmitter } from "node:events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const configPath = path.resolve(PROJECT_ROOT, "config.json");
const configExamplePath = path.resolve(PROJECT_ROOT, "config.example.json");

let createdTempConfig = false;
if (!fs.existsSync(configPath)) {
  fs.copyFileSync(configExamplePath, configPath);
  createdTempConfig = true;
}

console.log("=== 开始验证系统配置 API 与热重载机制 (Config API & Hot Reload Test) ===");

const eventBus = new EventEmitter();
let reloaded = false;
let updatedConfig = null;

const dummyDaemonApi = {
  getConfig: () => {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  },
  updateConfig: (patch) => {
    const cur = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (patch.chatBehavior) {
      cur.chatBehavior = { ...(cur.chatBehavior || {}), ...patch.chatBehavior };
    }
    fs.writeFileSync(configPath, JSON.stringify(cur, null, 2), "utf-8");
    updatedConfig = cur;
    return cur;
  },
  reloadConfig: () => {
    reloaded = true;
  },
  getLogBuffer: () => [],
  cleanImages: () => ({ deleted: 0, count: 0 })
};

const rawCfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const originalChatBehavior = JSON.parse(JSON.stringify(rawCfg.chatBehavior || {}));

const webServer = createWebServer({
  config: { ...rawCfg, web: { port: 5128, adminToken: "test-token", cors: true } },
  eventBus,
  daemonApi: dummyDaemonApi
});

webServer.server.listen(5128, async () => {
  try {
    // 1. 测试 GET /api/system/config
    const getRes = await fetch("http://127.0.0.1:5128/api/system/config", {
      headers: { "Authorization": "Bearer test-token" }
    });
    const getData = await getRes.json();
    if (!getData.success || !getData.data?.chatBehavior) {
      throw new Error("GET /api/system/config 响应失败或缺失 chatBehavior");
    }
    console.log("✅ GET /api/system/config 获取成功，默认吃瓜阈值:", getData.data.chatBehavior.ambientTriggerThreshold);

    // 2. 测试 POST /api/system/config
    const postRes = await fetch("http://127.0.0.1:5128/api/system/config", {
      method: "POST",
      headers: {
        "Authorization": "Bearer test-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chatBehavior: {
          ambientTriggerThreshold: 12,
          interestCooldownSeconds: 45
        }
      })
    });
    const postData = await postRes.json();
    if (!postData.success) {
      throw new Error("POST /api/system/config 保存失败");
    }
    if (!reloaded) {
      throw new Error("POST /api/system/config 未触发 reloadConfig()");
    }
    console.log("✅ POST /api/system/config 成功修改配置并触发热重载！");

    // 3. 验证文件已持久化
    const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (saved.chatBehavior?.ambientTriggerThreshold !== 12 || saved.chatBehavior?.interestCooldownSeconds !== 45) {
      throw new Error("config.json 未正确落盘");
    }
    console.log("✅ config.json 文件持久化验证通过！");

    // 4. 恢复初始配置
    if (createdTempConfig) {
      try { fs.unlinkSync(configPath); } catch {}
    } else {
      saved.chatBehavior = originalChatBehavior;
      fs.writeFileSync(configPath, JSON.stringify(saved, null, 2), "utf-8");
    }
    console.log("✅ 现场清理完毕，初始配置已还原！");

    await webServer.stop();
    console.log("🎉 系统配置 API 与热重载测试全部通过！");
  } catch (err) {
    console.error("❌ 测试失败:", err);
    await webServer.stop().catch(() => {});
    process.exit(1);
  }
});
