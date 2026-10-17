import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let daemonPort = 34567;
try {
  const cfgPath = path.resolve(__dirname, "../config.json");
  const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  if (config.daemon?.internalHttpPort) daemonPort = config.daemon.internalHttpPort;
} catch {}

const server = new Server(
  { name: "agy-tomoko-mcp", version: "1.0.0" },
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
            }
          },
          required: ["targetType", "targetId", "message"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "qq_send_message") {
    try {
      const response = await fetch(`http://127.0.0.1:${daemonPort}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.params.arguments)
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

  throw new Error(`未知工具: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
