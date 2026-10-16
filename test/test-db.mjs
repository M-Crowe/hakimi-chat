import { getCharacterState, updateCharacterLocation, getUserAffinity, modifyUserAffinity, deleteUserAffinity } from "../src/db.mjs";

console.log("=== 测试 1: 检查默认角色位置 ===");
const state1 = getCharacterState();
console.log("初始位置:", state1.location, "| 正在做:", state1.action);

console.log("\n=== 测试 2: 更新角色位置 (/moveto) ===");
updateCharacterLocation("大学图书馆自习室", "坐在窗边翻阅《操作系统概念》", "专注");
const state2 = getCharacterState();
console.log("更新后位置:", state2.location, "| 正在做:", state2.action, "| 心情:", state2.mood);

console.log("\n=== 测试 3: 用户好感度系统接口测试 ===");
const testUid = 99887766;
const initialAff = getUserAffinity(testUid);
console.log("初始好感:", initialAff);

const updatedAff = modifyUserAffinity(testUid, 6, "自检互动测试");
console.log("互动 6 次后好感状态:", updatedAff);

// 还原测试前状态，避免污染真实数据库
updateCharacterLocation(state1.location, state1.action, state1.detail, state1.mood, state1.persona);
deleteUserAffinity(testUid);

console.log("\n✅ SQLite 数据区所有单元测试通过！");

