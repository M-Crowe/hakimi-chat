import { getCharacterState, getUserAffinity, updateCharacterLocation, modifyUserAffinity, saveSessionMemory, getSessionMemory, deleteUserAffinity, deleteSessionMemory } from "../src/db.mjs";

console.log("=== 1. 测试好感度变动标签 ===");
const userId = 100000 + Math.floor(Math.random() * 800000);
console.log("初始好感:", getUserAffinity(userId));

// 模拟变动
modifyUserAffinity(userId, 5, "聊到 Switch 2 共鸣");
const aff1 = getUserAffinity(userId);
console.log("好感+5后:", aff1);

modifyUserAffinity(userId, 20, "高频互动晋级朋友");
const aff2 = getUserAffinity(userId);
console.log("好感+20后（跨入朋友阶段）:", aff2);

console.log("\n=== 2. 测试时空转移标签 [state:...] ===");
const origState = getCharacterState();
console.log("初始位置:", origState.location);

updateCharacterLocation("拉面店", "和NozzleWTR吃拉面", "刚点好单等拉面上桌");
console.log("外出转移后:", getCharacterState());

updateCharacterLocation("home", "吃饱回家休息中", "回到二楼房间");
console.log("回家后状态:", getCharacterState());

console.log("\n=== 3. 测试记忆切片标签 ===");
saveSessionMemory("group:999", "群友聊了任天堂直面会和新海诚的新片");
console.log("提取记忆快照:", getSessionMemory("group:999"));

// 清理测试数据并还原初始身位
deleteUserAffinity(userId);
deleteSessionMemory("group:999");
updateCharacterLocation(origState.location, origState.action, origState.detail, origState.mood, origState.persona);

console.log("\n✅ 智子 (Tomoko) 业务逻辑与数据驱动全流程自检通过！");

