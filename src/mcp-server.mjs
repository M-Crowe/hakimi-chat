import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { getCharacterState, getUserAffinity } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let daemonPort = 34567;
try {
  const cfgPath = path.resolve(__dirname, "../config.json");
  const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  if (config.daemon?.internalHttpPort) daemonPort = config.daemon.internalHttpPort;
} catch {}

const server = new Server(
  { name: "agy-tomoko-mcp", version: "1.10.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "qq_send_message",
        description: "向 QQ 群或好友发送消息。你在想好回复之后，必须调用此工具把内容发送出去。可以在回复末尾附带 [af:+2|友好理由]、[af:-2|挑刺反感理由] 或 [state:地点|活动|细节] 标签（网关会自动拦截并入库，单次好感度变动严格限制在 [-2, +2]，不会被用户看到）。",
        inputSchema: {
          type: "object",
          properties: {
            targetType: {
              type: "string",
              enum: ["group", "private"],
              description: "消息目标类型：group (群聊) 或 private (私聊)"
            },
            targetId: {
              type: "number",
              description: "目标 QQ 群号或好友 QQ 号"
            },
            sessionKey: {
              type: "string",
              description: "当前会话 key，如 group:123456"
            },
            senderId: {
              type: "number",
              description: "当前交互的群友 QQ 号"
            },
            message: {
              type: "string",
              description: "准备发送的文本回复内容"
            },
            client: {
              type: "string",
              description: "发信客户端类型，如 dsh 或 antigravity"
            },
            modelName: {
              type: "string",
              description: "使用的模型名称，如 deepseek-flash"
            }
          },
          required: ["targetType", "targetId", "message"]
        }
      },
      {
        name: "qq_get_character_state",
        description: "获取当前伴聊角色的时空身位（所处地点、正在进行的活动、现场细节、心情等）。",
        inputSchema: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "指定人设 key，如 tomoko, dragon_girl, little_whale, haena。默认当前活跃角色"
            }
          }
        }
      },
      {
        name: "qq_get_user_affinity",
        description: "获取指定群友对伴聊角色的好感度分值、等级称谓及最新好感互动理由。",
        inputSchema: {
          type: "object",
          properties: {
            userId: {
              type: "number",
              description: "群友 QQ 号"
            }
          },
          required: ["userId"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "qq_send_message") {
    try {
      const args = { ...request.params.arguments };
      const isDshClient = process.argv.includes("--client=dsh") || process.env.CLIENT === "dsh" || Boolean(process.env.DSH_HOME);
      if (!args.client && isDshClient) {
        args.client = "dsh";
      }
      if (!args.modelName && (args.client === "dsh" || isDshClient)) {
        args.modelName = "deepseek-flash";
      }
      const response = await fetch(`http://127.0.0.1:${daemonPort}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args)
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: data.success ? "消息已由 SnowLuma 网关拦截并成功发送。" : "发送失败" }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `网关连接异常: ${err.message}` }]
      };
    }
  }

  if (request.params.name === "qq_get_character_state") {
    try {
      const p = request.params.arguments?.persona || null;
      const state = getCharacterState(p);
      return {
        content: [{ type: "text", text: JSON.stringify(state, null, 2) }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `获取角色状态失败: ${err.message}` }]
      };
    }
  }

  if (request.params.name === "qq_get_user_affinity") {
    try {
      const uid = Number(request.params.arguments?.userId);
      const aff = getUserAffinity(uid);
      return {
        content: [{ type: "text", text: JSON.stringify(aff, null, 2) }]
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `获取好感度失败: ${err.message}` }]
      };
    }
  }

  throw new Error(`未知工具: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
