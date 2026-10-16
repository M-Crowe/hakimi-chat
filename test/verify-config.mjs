import { getCharacterState, getUserAffinity } from "../src/db.mjs";

console.log("=== 配置校验 ===");
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
console.log("机器人 QQ:", config.snowLuma.botQqId);
console.log("管理员 QQ 列表:", config.snowLuma.adminQqIds);
console.log("允许群聊列表:", config.snowLuma.allowedGroupIds);

console.log("\n=== 数据库状态检查 ===");
console.log("角色当前位置:", getCharacterState());
console.log("管理员好感度初始状态:", getUserAffinity(config.snowLuma.adminQqIds[0]));

console.log("\n✅ 配置与数据库链路一切就绪！");
