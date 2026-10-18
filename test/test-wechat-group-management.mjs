import { initDatabase, getManagedGroups, getManagedGroup, saveManagedGroup, deleteManagedGroup, allocateWechatGroupId } from "../src/db.mjs";
import { createWebServer } from "../src/web-server.mjs";
import { EventEmitter } from "node:events";

async function runTest() {
  console.log("=== 开始验证微信群聊管理全流程 (WeChat Group Management Integration Test) ===");

  initDatabase();

  // 1. 测试 allocateWechatGroupId
  console.log("\n--- 1. 验证微信虚拟群号动态分配算法 ---");
  const testRoomName = "测试技术交流群_TestRoom_1";
  const allocatedId = allocateWechatGroupId(testRoomName);
  console.log(`✅ 为 "${testRoomName}" 成功计算分配虚拟频段 ID: ${allocatedId}`);
  if (allocatedId < 990000 || allocatedId >= 1000000) {
    throw new Error(`分配的虚拟 ID ${allocatedId} 不在 990000~999999 预期区间`);
  }

  // 2. 测试通过 saveManagedGroup 保存微信群
  console.log("\n--- 2. 验证微信群在 managed_groups 表中的创建与持久化 ---");
  const createdGroup = saveManagedGroup(allocatedId, testRoomName, true, "all", "wechat");
  console.log("✅ 创建微信群结果:", createdGroup);
  if (createdGroup.platform !== "wechat") {
    throw new Error("微信群 platform 字段未正确保存为 'wechat'");
  }
  if (createdGroup.group_name !== testRoomName) {
    throw new Error("群名不匹配");
  }

  // 3. 测试 getManagedGroups 列表与过滤
  console.log("\n--- 3. 验证群列表读取与平台标记 ---");
  const allGroups = getManagedGroups();
  const found = allGroups.find(g => Number(g.group_id) === allocatedId);
  if (!found) {
    throw new Error("在群列表中未找到刚创建的微信群");
  }
  console.log(`✅ 群列表中成功检索到微信群: ID=${found.group_id}, Platform=${found.platform}, Name=${found.group_name}`);

  // 4. 测试 Web API 交互与 Mock Daemon 联动
  console.log("\n--- 4. 验证 Web Server REST APIs 与热同步回路 ---");
  const eventBus = new EventEmitter();
  let syncCalled = null;

  const mockDaemonApi = {
    reloadWechatGroupMaps: () => {
      console.log("🔔 [Mock Daemon] reloadWechatGroupMaps 触发！");
    },
    syncWechatGroup: async (action, roomName) => {
      console.log(`🔔 [Mock Daemon] syncWechatGroup 触发: action=${action}, room=${roomName}`);
      syncCalled = { action, roomName };
      return true;
    },
    broadcastEvent: (type, data) => {
      console.log(`📡 [Mock EventBus] 广播事件: type=${type}`);
    }
  };

  const appInstance = createWebServer({
    config: { web: { port: 5129, adminToken: "test-token" } },
    eventBus,
    daemonApi: mockDaemonApi
  });

  const server = await appInstance.start();
  const BASE_URL = "http://127.0.0.1:5129";

  try {
    // 4.1 POST /api/groups (创建新微信群)
    const testRoom2 = "道馆馆_第二分馆_AutoTest";
    const postRes = await fetch(`${BASE_URL}/api/groups`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token"
      },
      body: JSON.stringify({
        platform: "wechat",
        name: testRoom2,
        triggerPolicy: "strict",
        enabled: true
      })
    });
    const postData = await postRes.json();
    console.log("✅ API 创建微信群返回:", postData);
    if (!postData.success || postData.data.platform !== "wechat" || postData.data.group_name !== testRoom2) {
      throw new Error("POST /api/groups 响应异常: " + JSON.stringify(postData));
    }
    const newGid = postData.data.group_id;
    if (syncCalled?.action !== "add" || syncCalled?.roomName !== testRoom2) {
      throw new Error("未正确触发 syncWechatGroup('add')");
    }

    // 4.2 PUT /api/groups/:id (修改群策略)
    const putRes = await fetch(`${BASE_URL}/api/groups/${newGid}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token"
      },
      body: JSON.stringify({
        name: testRoom2 + "_Renamed",
        triggerPolicy: "all"
      })
    });
    const putData = await putRes.json();
    console.log("✅ API 更新微信群返回:", putData);
    if (!putData.success || putData.data.group_name !== testRoom2 + "_Renamed") {
      throw new Error("PUT /api/groups/:id 响应异常");
    }

    // 4.3 POST /api/groups/:id/toggle (开关信道)
    const toggleRes = await fetch(`${BASE_URL}/api/groups/${newGid}/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token"
      },
      body: JSON.stringify({ enabled: false })
    });
    const toggleData = await toggleRes.json();
    console.log("✅ API 切换开关返回:", toggleData);
    if (!toggleData.success || toggleData.data.enabled !== false) {
      throw new Error("POST /api/groups/:id/toggle 响应异常");
    }
    if (syncCalled?.action !== "remove") {
      throw new Error("禁用微信群时未正确向守护同步 'remove'");
    }

    // 4.4 DELETE /api/groups/:id (移除白名单)
    const delRes = await fetch(`${BASE_URL}/api/groups/${newGid}`, {
      method: "DELETE",
      headers: {
        "Authorization": "Bearer test-token"
      }
    });
    const delData = await delRes.json();
    console.log("✅ API 删除微信群返回:", delData);
    if (!delData.success) {
      throw new Error("DELETE /api/groups/:id 响应异常");
    }

    // 清理步骤 2 的测试群
    deleteManagedGroup(allocatedId);
    console.log("🧹 测试数据清理完毕！");

  } finally {
    await appInstance.stop();
  }

  console.log("\n🎉 微信群聊管理功能全链路验证圆满成功！");
}

runTest().catch(err => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
