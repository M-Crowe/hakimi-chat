#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ❌ 错误: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function backupFile(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
    log(`已创建配置备份: ${path.basename(dest)}`);
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
    return dest;
  } catch (err) {
    log(`⚠️ 备份失败: ${err.message}`);
    return null;
  }
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 1. 解析 DSH 根目录
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const TARGET_PROFILE = process.argv[2] || "web";

log(`=== 开始配置 DeepSeek Harness (DSH) 伴聊大脑集成 ===`);
log(`项目目录: ${PROJECT_ROOT}`);
log(`DSH 目录: ${DSH_HOME}`);
log(`目标 Profile: ${TARGET_PROFILE}`);

if (!fs.existsSync(DSH_HOME)) {
  if (process.argv.includes("--init")) {
    log(`DSH 目录不存在，初始化目录结构: ${DSH_HOME}`);
    ensureDir(path.join(DSH_HOME, "profiles", TARGET_PROFILE));
    ensureDir(path.join(DSH_HOME, "skills"));
  } else {
    fatal(`未检测到 DSH 目录: ${DSH_HOME}。若首次配置请添加 --init 参数自动初始化，或确认 DSH 安装路径并设置环境变量 DSH_HOME。`);
  }
}

// 2. 构造 MCP 注册配置块
function generateMcpBlock() {
  const nodeExe = process.execPath;
  const mcpScript = path.resolve(PROJECT_ROOT, "src", "mcp-server.mjs");

  return [
    "# === agy-tomoko-mcp BEGIN ===",
    "# 由 scripts/setup-dsh.mjs 自动生成维护，提供 QQ 消息收发与好感时空网关",
    "- insert:",
    "    - id: agy-tomoko-mcp",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: agy-tomoko-mcp",
    "        transport: stdio",
    `        command: ${yamlSingleQuote(nodeExe)}`,
    "        args:",
    `          - ${yamlSingleQuote(mcpScript)}`,
    "          - '--client=dsh'",
    "        toolCallTimeoutMs: 725000",
    "# === agy-tomoko-mcp END ==="
  ].join("\n");
}

// 3. 补丁并同步 cordis.patch.yml
function patchProfileCordis(profileName) {
  const profileDir = path.join(DSH_HOME, "profiles", profileName);
  ensureDir(profileDir);
  const patchFile = path.join(profileDir, "cordis.patch.yml");

  let content = "";
  if (fs.existsSync(patchFile)) {
    content = fs.readFileSync(patchFile, "utf-8");
    backupFile(patchFile);
  }

  // 修复 DSH 模板中仅包含注释与根 [] 时追加 - insert 导致的 YAML 根结构冲突
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = lines.findIndex(l => l.trim() && !l.trimStart().startsWith("#"));
  if (first >= 0 && lines[first].trim() === "[]") {
    lines.splice(first, 1);
    content = lines.join("\n");
  }

  const mcpBlock = generateMcpBlock();
  const beginMarker = "# === agy-tomoko-mcp BEGIN ===";
  const endMarker = "# === agy-tomoko-mcp END ===";

  let newContent = "";
  if (content.includes(beginMarker) && content.includes(endMarker)) {
    // 替换现有块
    const pre = content.slice(0, content.indexOf(beginMarker));
    const post = content.slice(content.indexOf(endMarker) + endMarker.length);
    newContent = `${pre.trimEnd()}\n\n${mcpBlock}\n${post.trimStart()}`.trim() + "\n";
    log(`已在 profile [${profileName}] 中更新现有 agy-tomoko-mcp 配置`);
  } else {
    // 插入新块
    const trimmed = content.trim();
    if (!trimmed || trimmed === "[]") {
      newContent = `${mcpBlock}\n`;
    } else {
      newContent = `${trimmed}\n\n${mcpBlock}\n`;
    }
    log(`已在 profile [${profileName}] 中追加 agy-tomoko-mcp 配置`);
  }

  fs.writeFileSync(patchFile, newContent, "utf-8");
  log(`已写入: ${patchFile}`);
}

// 遍历配置 profiles (web 和 desktop)
const profilesToPatch = [TARGET_PROFILE];
const desktopProfileDir = path.join(DSH_HOME, "profiles", "desktop");
if (TARGET_PROFILE !== "desktop" && fs.existsSync(desktopProfileDir)) {
  profilesToPatch.push("desktop");
}

for (const prof of profilesToPatch) {
  patchProfileCordis(prof);
}

// 4. 同步 DSH Skill 伴聊技能规范
const skillsDir = path.join(DSH_HOME, "skills");
ensureDir(skillsDir);
const dshTomokoSkillDir = path.join(skillsDir, "tomoko-bridge");
ensureDir(dshTomokoSkillDir);

const dshSkillContent = `---
name: tomoko-bridge
description: 一键启动并运行「哈基米聊天系统」伴聊大脑（支持智子/白龙娘/小鲸鱼/Haena等多角色）。提供独立 Web 控制台（Port 5120）、内部 IPC 通信网关（Port 34567）、长轮询监听消息队列、大模型标准 Token 校准与 KV Cache 缓存命中率监测、时空状态双向同步与好感度自动持久化。
---

# 🐱 哈基米聊天系统 (Hakimi Chat System) DSH 伴聊大脑启动与运行规范

本 Skill 用于在 DeepSeek Harness (DSH) 中运行**哈基米聊天系统**伴聊大脑。

---

## 🛠️ 对等复用与通信链路

1. **消息监听**：在终端执行长轮询脚本监听 QQ 消息队列：
   \`\`\`powershell
   node ${path.resolve(PROJECT_ROOT, "scripts/wait-for-qq-message.mjs").replace(/\\/g, "/")}
   \`\`\`
   - 若输出 \`NEW_QQ_MESSAGE:{...}\`：提取消息内容进行回复；
   - 若输出 \`HEARTBEAT_TIMEOUT\`：无新消息超时，继续再次执行监听。

2. **回复发信（原生 MCP 工具）**：
   通过 MCP 工具 \`qq_send_message\` 发信（不要在控制台打字）：
   \`\`\`json
   {
     "targetType": "group",
     "targetId": 587071853,
     "sessionKey": "group:587071853",
     "message": "<social_decision>ACTION: REPLY</social_decision><reply>在的呢，有什么事吗？[af:+1|礼貌问候]</reply>",
     "client": "dsh"
   }
   \`\`\`

3. **Token 与计费审计**：
   访问 Web 管理控制台：\`http://127.0.0.1:5120\`，选择「DSH (DeepSeek)」视图查看真实的 KV Cache 提示词缓存与阶梯账单。
`;

fs.writeFileSync(path.join(dshTomokoSkillDir, "SKILL.md"), dshSkillContent, "utf-8");
log(`已同步 DSH 专属伴聊 Skill: ${path.join(dshTomokoSkillDir, "SKILL.md")}`);

// 5. 更新本地 config.json 中的 DSH 配置节
const configPath = path.resolve(PROJECT_ROOT, "config.json");
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    cfg.dsh = {
      enabled: true,
      home: DSH_HOME,
      defaultModel: cfg.dsh?.defaultModel || "deepseek-flash",
      agentPreset: cfg.dsh?.agentPreset || "tomoko"
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    log(`已同步 config.json 中的 dsh 配置节`);
  } catch {}
}

console.log("\n=======================================================");
console.log("🎉 DeepSeek Harness (DSH) 伴聊大脑集成配置成功！");
console.log("=======================================================");
console.log(`📌 MCP 客户端已注册: agy-tomoko-mcp (${path.join(PROJECT_ROOT, "src", "mcp-server.mjs")})`);
console.log(`📌 DSH Skill 已安装: ~/.dsh/skills/tomoko-bridge/SKILL.md`);
console.log(`📌 伴聊消息监听脚本: node scripts/wait-for-qq-message.mjs`);
console.log(`🌐 Web 控制台实时看板: http://127.0.0.1:5120 (支持 DSH / Antigravity 双端切换)`);
console.log("=======================================================\n");
