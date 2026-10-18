import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";

import {
  getCharacterState,
  updateCharacterLocation,
  getManagedGroups,
  getManagedGroup,
  saveManagedGroup,
  deleteManagedGroup,
  toggleGroupEnabled,
  allocateWechatGroupId,
  getAllUserAffinities,
  setUserAffinity,
  deleteUserAffinity,
  getAllSessionMemories,
  saveSessionMemory,
  deleteSessionMemory,
  getAllSlangs,
  createSlang,
  updateSlang,
  deleteSlang,
  getTokenUsageStats,
  getRecentTokenLogs,
  getRecentChatMessages,
  clearChatMessages,
  syncCharacterStateForPersona,
  cleanTestAffinities,
  clearAllAffinities,
  cleanTestTokenLogs,
  getAntigravityBrainTokenStats
} from "./db.mjs";

import {
  getAllPersonas,
  getActivePersona,
  loadPersonaPrompt,
  savePersonaPrompt
} from "./personas.mjs";
import { loadPricingConfig, savePricingConfig } from "./pricing.mjs";
import { getDshBrainTokenStats, getDshSessions, isDshAvailable } from "./dsh-discovery.mjs";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 启动 Hakimi Web 统一全栈管理服务 (Port 5120)
 */
export function createWebServer({ config, eventBus, daemonApi }) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // 支持环境变量覆盖
  if (process.env.HAKIMI_ADMIN_TOKEN && config.web) {
    config.web.adminToken = process.env.HAKIMI_ADMIN_TOKEN;
  }
  if (process.env.ONEBOT_WS_URL && config.snowLuma) {
    config.snowLuma.wsUrl = process.env.ONEBOT_WS_URL;
  }

  const webPort = config.web?.port || 5120;
  const initialActivePreset = config.antigravity?.agentPreset || "tomoko";
  syncCharacterStateForPersona(initialActivePreset);

  // 中间件配置
  app.use(express.json({ limit: "5mb" }));

  // CORS 允许
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // 免密访问中间件
  app.use((req, res, next) => next());

  // -----------------------------------------------------------
  // 1. 认证接口 (Authentication - 免密开放)
  // -----------------------------------------------------------
  app.post("/api/auth/login", (req, res) => {
    return res.json({ success: true, token: "", message: "免密访问" });
  });

  // -----------------------------------------------------------
  // 2. 群组管理中心 (Group Management)
  // -----------------------------------------------------------
  app.get("/api/groups", (req, res) => {
    try {
      const groups = getManagedGroups();
      res.json({ success: true, data: groups });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/groups", async (req, res) => {
    try {
      const { groupId, name, enabled = true, triggerPolicy = "all", platform = "qq" } = req.body || {};
      let targetGid = Number(groupId);
      const targetName = (name !== undefined && name !== null) ? String(name).trim() : "";
      const targetPlatform = platform === "wechat" ? "wechat" : "qq";

      if (targetPlatform === "wechat") {
        if (!targetName) {
          return res.status(400).json({ success: false, error: "请填写微信群名称" });
        }
        if (!targetGid) {
          targetGid = allocateWechatGroupId(targetName);
        }
      } else {
        if (!targetGid) {
          return res.status(400).json({ success: false, error: "缺少 groupId" });
        }
      }

      const group = saveManagedGroup(targetGid, targetName, enabled, triggerPolicy, targetPlatform);

      if (targetPlatform === "wechat") {
        daemonApi?.reloadWechatGroupMaps?.();
        daemonApi?.syncWechatGroup?.(enabled ? "add" : "remove", targetName);
      }

      daemonApi?.broadcastEvent?.("group_change", { action: "create", group });
      res.json({ success: true, data: group });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put("/api/groups/:id", async (req, res) => {
    try {
      const groupId = Number(req.params.id);
      const existing = getManagedGroup(groupId);
      if (!existing) {
        return res.status(404).json({ success: false, error: "群组不存在" });
      }
      const { name, enabled, triggerPolicy, platform } = req.body || {};
      const targetName = (name !== undefined && name !== "") ? name : existing.group_name;
      const targetEnabled = typeof enabled === "boolean" ? enabled : existing.enabled;
      const targetPolicy = triggerPolicy === "strict" ? "strict" : (triggerPolicy === "all" ? "all" : existing.trigger_policy);
      const targetPlatform = platform || existing.platform || ((groupId >= 990000 && groupId <= 999999) ? "wechat" : "qq");

      const group = saveManagedGroup(groupId, targetName, targetEnabled, targetPolicy, targetPlatform);

      if (targetPlatform === "wechat") {
        daemonApi?.reloadWechatGroupMaps?.();
        daemonApi?.syncWechatGroup?.(targetEnabled ? "add" : "remove", targetName);
      }

      daemonApi?.broadcastEvent?.("group_change", { action: "update", group });
      res.json({ success: true, data: group });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete("/api/groups/:id", async (req, res) => {
    try {
      const groupId = Number(req.params.id);
      const existing = getManagedGroup(groupId);
      if (daemonApi?.deleteGroup) {
        daemonApi.deleteGroup(groupId);
      } else {
        deleteManagedGroup(groupId);
      }
      if (existing?.platform === "wechat" || (groupId >= 990000 && groupId <= 999999)) {
        daemonApi?.reloadWechatGroupMaps?.();
        daemonApi?.syncWechatGroup?.("remove", existing?.group_name);
      }
      daemonApi?.broadcastEvent?.("group_change", { action: "delete", groupId });
      res.json({ success: true, message: `群 ${groupId} 已从白名单移除` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/groups/:id/toggle", async (req, res) => {
    try {
      const groupId = Number(req.params.id);
      const { enabled } = req.body || {};
      const targetEnabled = typeof enabled === "boolean" ? enabled : !getManagedGroup(groupId)?.enabled;
      let group;
      if (daemonApi?.toggleGroup) {
        group = daemonApi.toggleGroup(groupId, targetEnabled);
      } else {
        group = toggleGroupEnabled(groupId, targetEnabled);
      }
      if (group?.platform === "wechat" || (groupId >= 990000 && groupId <= 999999)) {
        daemonApi?.reloadWechatGroupMaps?.();
        daemonApi?.syncWechatGroup?.(group.enabled ? "add" : "remove", group.group_name);
      }
      daemonApi?.broadcastEvent?.("group_change", { action: "toggle", group });
      res.json({ success: true, data: group });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 3. 人格与时空控制台 (Persona & Spatio-temporal Console)
  // -----------------------------------------------------------
  app.get("/api/personas", (req, res) => {
    try {
      const activePreset = config.antigravity?.agentPreset || "tomoko";
      const personas = getAllPersonas(activePreset);
      res.json({ success: true, activePreset, data: personas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/personas/switch", (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ success: false, error: "缺少 persona 名称" });
      
      if (daemonApi?.switchPersona) {
        daemonApi.switchPersona(name);
      } else {
        if (config.antigravity) config.antigravity.agentPreset = name;
        syncCharacterStateForPersona(name);
      }
      const activePreset = config.antigravity?.agentPreset || name;
      const persona = getActivePersona(activePreset);
      const newState = getCharacterState(activePreset);
      daemonApi?.broadcastEvent?.("persona_switch", { activePreset, persona });
      daemonApi?.broadcastEvent?.("state_change", newState);
      res.json({ success: true, activePreset, persona, data: newState, message: `已成功切换为 [${persona.displayName}]` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/personas/:name/card", (req, res) => {
    try {
      const name = req.params.name;
      const content = loadPersonaPrompt(name);
      res.json({ success: true, name, content });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put("/api/personas/:name/card", (req, res) => {
    try {
      const name = req.params.name;
      const { content } = req.body || {};
      if (typeof content !== "string") {
        return res.status(400).json({ success: false, error: "缺少 card content" });
      }
      savePersonaPrompt(name, content);
      res.json({ success: true, message: `人设卡 [${name}.md] 已成功更新并支持热重载！` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/character/state", (req, res) => {
    try {
      const activePreset = req.query.persona || config.antigravity?.agentPreset || "tomoko";
      const state = syncCharacterStateForPersona(activePreset);
      const persona = getActivePersona(activePreset);
      res.json({ success: true, persona: persona.displayName, activePreset, data: state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put("/api/character/state", (req, res) => {
    try {
      const { location, action, detail, mood, persona: reqPersona } = req.body || {};
      if (!location || !action) {
        return res.status(400).json({ success: false, error: "地点与行为不能为空" });
      }
      const activePreset = reqPersona || config.antigravity?.agentPreset || "tomoko";
      updateCharacterLocation(location, action, detail || "", mood || "自然", activePreset);
      const newState = getCharacterState(activePreset);
      daemonApi?.broadcastEvent?.("state_change", newState);
      res.json({ success: true, data: newState, message: "时空身位已更新" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 4. 实时消息看板与推流 (Live Feed & Intercom)
  // -----------------------------------------------------------
  app.get("/api/messages", (req, res) => {
    try {
      const limit = Number(req.query.limit) || 100;
      const sessionKey = req.query.sessionKey || (req.query.groupId ? `group:${req.query.groupId}` : null);
      const messages = getRecentChatMessages(limit, sessionKey);
      res.json({ success: true, data: messages });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/messages/send", async (req, res) => {
    try {
      const { targetType = "group", targetId, message } = req.body || {};
      if (!targetId || !message || !message.trim()) {
        return res.status(400).json({ success: false, error: "缺少 targetId 或 message" });
      }
      const ok = await daemonApi?.sendQQMessage(targetType, Number(targetId), message.trim());
      res.json({ success: ok, message: ok ? "消息已送达" : "发送失败，请检查 SnowLuma 状态" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/messages/clear", (req, res) => {
    try {
      const { sessionKey } = req.body || {};
      clearChatMessages(sessionKey || null);
      res.json({ success: true, message: "聊天记录已清理" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/sessions/reset", (req, res) => {
    try {
      const { sessionKey, groupId } = req.body || {};
      const key = sessionKey || (groupId ? `group:${groupId}` : null);
      if (key) {
        daemonApi?.resetSession(key);
        res.json({ success: true, message: `会话 ${key} 已切断重置` });
      } else {
        daemonApi?.resetAllSessions();
        res.json({ success: true, message: "所有群会话切片已全部重置" });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 5. 好感度与记忆资产库 (Affinity & Memory Vault)
  // -----------------------------------------------------------
  app.get("/api/affinity", (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const offset = Number(req.query.offset) || 0;
      const search = req.query.search || "";
      const sortBy = req.query.sortBy || "points_desc";
      const result = getAllUserAffinities(limit, offset, search, sortBy);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put("/api/affinity/:userId", (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const { points, reason } = req.body || {};
      const row = setUserAffinity(userId, points, reason);
      daemonApi?.broadcastEvent?.("affinity_change", row);
      res.json({ success: true, data: row });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete("/api/affinity/:userId", (req, res) => {
    try {
      const userId = Number(req.params.userId);
      deleteUserAffinity(userId);
      res.json({ success: true, message: `用户 ${userId} 好感记录已删除` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/affinity/clean-test-data", (req, res) => {
    try {
      const adminQqIds = config.snowLuma?.adminQqIds || [];
      const result = cleanTestAffinities(adminQqIds);
      res.json({
        success: true,
        message: `已成功清理 ${result.deletedCount} 条测试垃圾数据，保留 ${result.remaining} 条真实群友记录`,
        ...result
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/affinity/clear-all", (req, res) => {
    try {
      clearAllAffinities();
      res.json({ success: true, message: "所有用户好感度档案已清空" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });


  app.get("/api/memories", (req, res) => {
    try {
      const memories = getAllSessionMemories();
      res.json({ success: true, data: memories });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put("/api/memories/:sessionKey", (req, res) => {
    try {
      const sessionKey = decodeURIComponent(req.params.sessionKey);
      const { memoryText } = req.body || {};
      saveSessionMemory(sessionKey, memoryText || "");
      res.json({ success: true, message: "记忆快照已更新" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete("/api/memories/:sessionKey", (req, res) => {
    try {
      const sessionKey = decodeURIComponent(req.params.sessionKey);
      deleteSessionMemory(sessionKey);
      res.json({ success: true, message: "长期记忆已清除" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/slangs", (req, res) => {
    try {
      const search = req.query.search || "";
      const slangs = getAllSlangs(search);
      res.json({ success: true, data: slangs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/slangs", (req, res) => {
    try {
      const { word, meaning } = req.body || {};
      if (!word) return res.status(400).json({ success: false, error: "缺少黑话词汇" });
      const item = createSlang(word, meaning);
      res.json({ success: true, data: item });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put("/api/slangs/:id", (req, res) => {
    try {
      const id = Number(req.params.id);
      const { word, meaning, count } = req.body || {};
      const item = updateSlang(id, word, meaning, count);
      res.json({ success: true, data: item });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete("/api/slangs/:id", (req, res) => {
    try {
      const id = Number(req.params.id);
      deleteSlang(id);
      res.json({ success: true, message: "黑话条目已删除" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 6. Token 消耗与用量监测 (Token Monitoring)
  // -----------------------------------------------------------
  app.get("/api/tokens/stats", async (req, res) => {
    try {
      const days = Number(req.query.days) || 7;
      const groupId = req.query.groupId ? Number(req.query.groupId) : null;
      const persona = req.query.persona || null;
      const client = req.query.client || null;
      const conversationId = req.query.conversationId || null;
      const dshSessionId = req.query.dshSessionId || null;
      const stats = getTokenUsageStats({ days, groupId, persona, client });
      const brainStats = await getAntigravityBrainTokenStats({ days, conversationId });
      const dshStats = await getDshBrainTokenStats({ days, sessionId: dshSessionId });
      res.json({
        success: true,
        days,
        data: {
          ...stats,
          antigravityBrain: brainStats,
          dshBrain: dshStats
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/tokens/brain", async (req, res) => {
    try {
      const days = Number(req.query.days) || 7;
      const clientType = String(req.query.client || "antigravity").toLowerCase().trim();
      const conversationId = req.query.conversationId || null;
      const dshSessionId = req.query.dshSessionId || req.query.sessionId || null;

      if (clientType === "dsh") {
        const dshStats = await getDshBrainTokenStats({ days, sessionId: dshSessionId });
        return res.json({ success: true, data: dshStats });
      }

      if (clientType === "all" || clientType === "both") {
        const brainStats = await getAntigravityBrainTokenStats({ days, conversationId });
        const dshStats = await getDshBrainTokenStats({ days, sessionId: dshSessionId });
        return res.json({
          success: true,
          data: {
            antigravity: brainStats,
            dsh: dshStats
          }
        });
      }

      const brainStats = await getAntigravityBrainTokenStats({ days, conversationId });
      res.json({ success: true, data: brainStats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6.1 DSH (DeepSeek Harness) 专用用量与会话接口
  app.get("/api/dsh/stats", async (req, res) => {
    try {
      const days = Number(req.query.days) || 7;
      const sessionId = req.query.sessionId || null;
      const dshStats = await getDshBrainTokenStats({ days, sessionId });
      res.json({ success: true, data: dshStats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/dsh/sessions", (req, res) => {
    try {
      const sessions = getDshSessions();
      res.json({ success: true, count: sessions.length, data: sessions });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/tokens/logs", (req, res) => {
    try {
      const limit = Number(req.query.limit) || 100;
      const excludeTest = req.query.excludeTest === "true" || req.query.clean === "true";
      const groupId = req.query.groupId ? Number(req.query.groupId) : null;
      const client = req.query.client || null;
      const logs = getRecentTokenLogs(limit, { excludeTest, groupId, client });
      res.json({ success: true, data: logs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/tokens/clean-test", (req, res) => {
    try {
      const result = cleanTestTokenLogs();
      res.json({ success: true, message: `已成功清除 ${result.deletedCount} 条测试流量记录`, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6.2 Antigravity 配额防爆健康看板 (Loopback Quota & Smart Anti-Exhaustion)
  app.get("/api/antigravity/quota", async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === "true" || req.query.force === "true";
      let quota = null;
      if (daemonApi?.getQuotaStatus) {
        quota = await daemonApi.getQuotaStatus(forceRefresh);
      } else {
        const { AgyConnectRpcClient } = await import("./connect-rpc-client.mjs");
        const client = new AgyConnectRpcClient();
        quota = await client.getCombinedQuotaHealth(forceRefresh);
      }
      res.json({ success: true, data: quota });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 7. 系统状态与运维看板 (System Ops)
  // -----------------------------------------------------------
  const imagesDir = path.resolve(__dirname, "../data/images");
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  function getCachedImagesStats() {
    try {
      if (!fs.existsSync(imagesDir)) return { count: 0, max: 15, files: [] };
      const files = fs.readdirSync(imagesDir);
      const list = [];
      for (const f of files) {
        const p = path.join(imagesDir, f);
        try {
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            list.push({ name: f, path: p, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        } catch {}
      }
      list.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { count: list.length, max: 15, files: list };
    } catch {
      return { count: 0, max: 15, files: [] };
    }
  }

  app.get("/api/system/status", (req, res) => {
    try {
      const mem = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const snowLuma = daemonApi?.getSnowLumaStatus() || { connected: false, botQqId: 0 };
      const sessions = daemonApi?.getActiveSessions() || [];
      const groups = getManagedGroups();
      const activePreset = config.antigravity?.agentPreset || "tomoko";
      const imageStats = getCachedImagesStats();

      res.json({
        success: true,
        data: {
          projectName: "哈基米聊天系统",
          nodeVersion: process.version,
          platform: process.platform,
          uptime,
          memory: {
            rssMB: Math.round(mem.rss / 1024 / 1024),
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024)
          },
          snowLuma,
          activePersona: activePreset,
          managedGroupCount: groups.length,
          enabledGroupCount: groups.filter(g => g.enabled).length,
          activeSessionsCount: sessions.length,
          sessions,
          cachedImageCount: imageStats.count,
          cachedImagesMax: imageStats.max,
          webPort
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/system/images", (req, res) => {
    try {
      const stats = getCachedImagesStats();
      res.json({
        success: true,
        count: stats.count,
        max: stats.max,
        files: stats.files.map(f => ({ name: f.name, size: f.size, url: `/images/${f.name}`, mtimeMs: f.mtimeMs }))
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/system/clean-images", (req, res) => {
    try {
      const { keepLatest } = req.body || {};
      const keep = keepLatest !== undefined ? Math.max(0, Number(keepLatest)) : 0;
      let deletedCount = 0;
      let remainingCount = 0;

      if (daemonApi && typeof daemonApi.cleanImages === "function") {
        const result = daemonApi.cleanImages(keep);
        deletedCount = result.deleted;
        remainingCount = result.count;
      } else {
        const stats = getCachedImagesStats();
        const toDelete = keep > 0 ? stats.files.slice(keep) : stats.files;
        for (const file of toDelete) {
          try {
            fs.unlinkSync(file.path);
            deletedCount++;
          } catch (err) {
            console.warn(`[ImageCleanup] 删除图片失败 ${file.name}:`, err.message);
          }
        }
        remainingCount = stats.files.length - deletedCount;
      }

      eventBus.emit("broadcast", {
        type: "system_status",
        data: {
          cachedImageCount: remainingCount,
          cachedImagesMax: 15
        }
      });

      res.json({
        success: true,
        message: deletedCount > 0 ? `已清理 ${deletedCount} 张图片缓存` : "当前没有多余的图片缓存需要清理",
        deletedCount,
        count: remainingCount,
        max: 15
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/system/logs", (req, res) => {
    try {
      const logs = daemonApi?.getLogBuffer() || [];
      res.json({ success: true, data: logs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/system/logs", (req, res) => {
    try {
      const { level = "info", text, message } = req.body || {};
      const msgText = text || message || "";
      if (daemonApi?.captureLog) {
        daemonApi.captureLog(level, msgText);
      } else if (eventBus) {
        const entry = { time: new Date().toLocaleTimeString(), level, text: msgText, message: msgText };
        eventBus.emit("broadcast", { type: "system_log", data: entry });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/system/config", (req, res) => {
    try {
      const cfg = daemonApi?.getConfig?.() || config;
      res.json({
        success: true,
        data: {
          chatBehavior: cfg.chatBehavior || {
            ambientTriggerThreshold: 10,
            ambientTriggerProbability: 0.1,
            interestCooldownSeconds: 60,
            activeWindowSeconds: 120,
            silentBufferSeconds: 8,
            recentContextCount: 15,
            topSlangsCount: 5,
            maxImages: 15,
            patrolMinMinutes: 3,
            patrolMaxMinutes: 8,
            maxTurns: 30
          },
          daemon: cfg.daemon || {},
          antigravity: cfg.antigravity || {},
          snowLuma: {
            botQqId: cfg.snowLuma?.botQqId,
            adminQqIds: cfg.snowLuma?.adminQqIds,
            wsUrl: cfg.snowLuma?.wsUrl
          }
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/system/config", (req, res) => {
    try {
      const patch = req.body || {};
      const updated = daemonApi?.updateConfig?.(patch) || config;
      daemonApi?.reloadConfig?.();
      res.json({ success: true, message: "系统配置已保存并热重载生效！", data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 6.1 计费表外置与热更新接口 (Pricing Configuration)
  // -----------------------------------------------------------
  app.get("/api/system/pricing", (req, res) => {
    try {
      const pricingData = loadPricingConfig();
      res.json({ success: true, data: pricingData });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/system/pricing", (req, res) => {
    try {
      const updated = savePricingConfig(req.body || {});
      res.json({ success: true, message: "模型费率配置已成功更新并热生效！", data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/system/reload", (req, res) => {
    try {
      daemonApi?.reloadConfig();
      res.json({ success: true, message: "配置与人设已重新加载！" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/system/restart", (req, res) => {
    try {
      res.json({ success: true, message: "正在重启守护进程..." });
      setTimeout(() => {
        process.exit(0); // 守护进程由外部守护服务 (pm2 / nodemon / start 脚本) 自动拉起
      }, 500);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // 8. 静态管理控制台托管 (SPA) 与本地图片附件静态托管
  // -----------------------------------------------------------
  const publicDir = path.resolve(__dirname, "../public");
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  app.use(express.static(publicDir));

  app.use("/images", express.static(imagesDir));

  // SPA 回退
  app.use((req, res, next) => {
    const p = (req.path || "").toLowerCase();
    if (p === "/api" || p.startsWith("/api/") || p === "/images" || p.startsWith("/images/")) return next();
    const indexPath = path.join(publicDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });


  // -----------------------------------------------------------
  // 9. WebSocket 实时推流广播网关 (免密开放)
  // -----------------------------------------------------------
  const clients = new Set();

  wss.on("connection", (wsClient) => {
    wsClient.authenticated = true;
    clients.add(wsClient);
    sendInitialState(wsClient);

    wsClient.on("close", () => {
      clients.delete(wsClient);
    });

    wsClient.on("error", () => {
      clients.delete(wsClient);
    });
  });

  function sendInitialState(wsClient) {
    if (wsClient.readyState !== WebSocket.OPEN) return;
    try {
      wsClient.send(JSON.stringify({
        type: "init",
        data: {
          characterState: getCharacterState(config.antigravity?.agentPreset || "tomoko"),
          activePersona: config.antigravity?.agentPreset || "tomoko",
          groups: getManagedGroups(),
          recentLogs: daemonApi?.getLogBuffer()?.slice(-50) || []
        }
      }));
    } catch {}
  }

  function broadcast(type, payload) {
    const data = JSON.stringify({ type, timestamp: new Date().toISOString(), data: payload });
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN && c.authenticated) {
        try {
          c.send(data);
        } catch {}
      }
    }
  }

  // 挂载广播方法到 eventBus 监听（记录具名句柄，防止 stop 时泄露）
  const onBroadcast = ({ type, data }) => broadcast(type, data);
  if (eventBus) {
    eventBus.on("broadcast", onBroadcast);
  }

  return {
    app,
    server,
    broadcast,
    start: () => {
      return new Promise((resolve, reject) => {
        server.listen(webPort, () => {
          console.log(`🌐 [Web 管理平台] 哈基米聊天系统 Web Dashboard 已就绪: http://127.0.0.1:${webPort}`);
          resolve(webPort);
        }).on("error", reject);
      });
    },
    stop: () => {
      return new Promise((resolve) => {
        if (eventBus && onBroadcast) {
          eventBus.removeListener("broadcast", onBroadcast);
        }
        for (const c of clients) {
          try { c.terminate(); } catch {}
        }
        clients.clear();
        try {
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
        } catch {}
        wss.close(() => {
          if (server.listening) {
            server.close(() => resolve());
          } else {
            resolve();
          }
        });
      });
    }
  };
}
