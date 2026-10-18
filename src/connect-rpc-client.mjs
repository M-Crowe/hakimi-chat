import { discoverLanguageServer, getCachedLanguageServer, clearDiscoveryCache } from "./antigravity-discovery.mjs";

/**
 * 直连 Antigravity 本地常驻 Language Server 的 ConnectRPC 原生客户端
 * 使用可靠的 Connect Protocol (HTTP/1.1 POST JSON)，自动嗅探端口与 CSRF 令牌
 */
export class AgyConnectRpcClient {
  constructor(baseUrl, csrfToken) {
    const cached = getCachedLanguageServer();
    let addr = baseUrl || process.env.ANTIGRAVITY_LS_ADDRESS || (cached ? cached.address : "http://127.0.0.1:6714");
    if (!addr.startsWith("http://") && !addr.startsWith("https://")) {
      addr = `http://${addr}`;
    }
    this.baseUrl = addr;
    this.csrfToken = csrfToken || process.env.ANTIGRAVITY_CSRF_TOKEN || (cached ? cached.csrfToken : "");
    this._explicitBaseUrl = Boolean(baseUrl);
    this._explicitCsrfToken = Boolean(csrfToken);
    console.log(`[ConnectRPC] 已自动连接 Antigravity 后台端点: ${this.baseUrl}`);
  }

  async ensureDiscovered(forceRefresh = false) {
    if ((!this._explicitCsrfToken && !this.csrfToken) || forceRefresh) {
      if (!process.env.ANTIGRAVITY_CSRF_TOKEN || !process.env.ANTIGRAVITY_LS_ADDRESS) {
        const auto = await discoverLanguageServer({ forceRefresh });
        if (auto?.csrfToken && !this._explicitCsrfToken && !process.env.ANTIGRAVITY_CSRF_TOKEN) {
          this.csrfToken = auto.csrfToken;
        }
        if (auto?.address && !this._explicitBaseUrl && !process.env.ANTIGRAVITY_LS_ADDRESS) {
          this.baseUrl = auto.address;
        }
      }
    }
  }

  async callRpc(serviceMethod, payloadObj, timeoutMs = 30000) {
    return await this._callRpcInternal(serviceMethod, payloadObj, timeoutMs, false);
  }

  async _callRpcInternal(serviceMethod, payloadObj, timeoutMs = 30000, isRetry = false) {
    await this.ensureDiscovered();
    const url = `${this.baseUrl.replace(/\/$/, "")}/exa.language_server_pb.LanguageServerService/${serviceMethod}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-codeium-csrf-token": this.csrfToken
        },
        body: JSON.stringify(payloadObj),
        signal: controller.signal
      });

      clearTimeout(timer);
      const text = await response.text();
      let parsed = {};
      try {
        parsed = JSON.parse(text || "{}");
      } catch {
        parsed = { raw: text };
      }

      if (!response.ok) {
        // 若遇到 401/403 鉴权失效且并非显式指定 Token，主动清除缓存并重试一次
        if (!isRetry && (response.status === 401 || response.status === 403) && (!this._explicitBaseUrl || !this._explicitCsrfToken)) {
          clearDiscoveryCache();
          await this.ensureDiscovered(true);
          return await this._callRpcInternal(serviceMethod, payloadObj, timeoutMs, true);
        }
        const errorMsg = parsed.message || parsed.code || `HTTP ${response.status} ${response.statusText}`;
        const err = new Error(errorMsg);
        err.code = parsed.code || `HTTP_${response.status}`;
        err.status = response.status;
        throw err;
      }

      if (parsed.code && parsed.code !== "ok") {
        const err = new Error(parsed.message || `RPC Error: ${parsed.code}`);
        err.code = parsed.code;
        throw err;
      }

      return parsed;
    } catch (err) {
      clearTimeout(timer);
      // 若遇到网络不可达或连接拒绝且并非显式指定端点，主动清除缓存并尝试重新探测重试一次
      if (!isRetry && (err.cause?.code === "ECONNREFUSED" || err.code === "ECONNREFUSED" || err.name === "TypeError") && (!this._explicitBaseUrl || !this._explicitCsrfToken)) {
        clearDiscoveryCache();
        await this.ensureDiscovered(true);
        return await this._callRpcInternal(serviceMethod, payloadObj, timeoutMs, true);
      }
      throw err;
    }
  }

  /**
   * 启动新的持久化后台会话 (StartCascade)
   */
  async createPersistentCascade(initialPrompt, agentPreset = "tomoko", effortLevel = "EFFORT_LOW") {
    const res = await this.callRpc("StartCascade", {
      source: "CORTEX_TRAJECTORY_SOURCE_CLI",
      prompt: initialPrompt,
      agentName: agentPreset,
      backgroundMode: true,
      effortLevel
    });
    return res.cascadeId;
  }

  /**
   * 追加多轮消息 (SendUserCascadeMessage)
   */
  async sendCascadeMessage(cascadeId, messageText, effortLevel = "EFFORT_LOW") {
    return await this.callRpc("SendUserCascadeMessage", {
      cascadeId,
      items: [{ text: messageText }],
      effortLevel
    });
  }

  /**
   * 查询用户当前配额摘要 (RetrieveUserQuotaSummary)
   * 自动嗅探 5-hour 与 weekly 窗口余量、重置时间与防爆阈值
   */
  async getUserQuotaSummary(forceRefresh = true) {
    try {
      const res = await this.callRpc("RetrieveUserQuotaSummary", { forceRefresh });
      const rawGroups = res?.response?.groups || [];
      if (rawGroups.length === 0) {
        return {
          success: true,
          endpoint: this.baseUrl,
          fetchedAt: new Date().toISOString(),
          groups: [],
          lowestRemainingPercent: undefined,
          isExhausted: false,
          isThrottled: false,
          throttleReason: null
        };
      }

      const parsedGroups = [];
      let minFraction = 1.0;

      for (const g of rawGroups) {
        const buckets = g.buckets || [];
        const groupInfo = {
          displayName: g.displayName || "Model Group",
          description: g.description || "",
          fiveHour: null,
          weekly: null
        };

        for (const b of buckets) {
          const frac = typeof b.remainingFraction === "number" ? Math.max(0, Math.min(1, b.remainingFraction)) : 1.0;
          if (frac < minFraction) {
            minFraction = frac;
          }

          const resetDate = b.resetTime ? new Date(b.resetTime) : null;
          let countdownStr = "未知";
          if (resetDate && !isNaN(resetDate.getTime())) {
            const diffMs = resetDate.getTime() - Date.now();
            if (diffMs <= 0) {
              countdownStr = "已重置";
            } else {
              const totalMins = Math.floor(diffMs / 60000);
              const days = Math.floor(totalMins / 1440);
              const hours = Math.floor((totalMins % 1440) / 60);
              const mins = totalMins % 60;
              if (days > 0) {
                countdownStr = `${days}天${hours}小时`;
              } else if (hours > 0) {
                countdownStr = `${hours}小时${mins}分`;
              } else {
                countdownStr = `${mins}分钟`;
              }
            }
          }

          const bucketData = {
            bucketId: b.bucketId || "",
            displayName: b.displayName || "",
            description: b.description || "",
            window: b.window || "",
            remainingFraction: frac,
            remainingPercent: Number((frac * 100).toFixed(1)),
            resetTime: b.resetTime || "",
            resetCountdown: countdownStr
          };

          if (b.window === "5h" || b.bucketId?.includes("5h")) {
            groupInfo.fiveHour = bucketData;
          } else if (b.window === "weekly" || b.bucketId?.includes("weekly")) {
            groupInfo.weekly = bucketData;
          }
        }

        parsedGroups.push(groupInfo);
      }

      const lowestPercent = Number((minFraction * 100).toFixed(1));
      const isExhausted = minFraction <= 0.001;
      const isThrottled = minFraction < 0.10; // 剩余小于 10% 触发防爆熔断保护

      return {
        success: true,
        endpoint: this.baseUrl,
        fetchedAt: new Date().toISOString(),
        groups: parsedGroups,
        lowestRemainingPercent: lowestPercent,
        isExhausted,
        isThrottled,
        throttleReason: isExhausted ? "配额完全耗尽 (0%)" : (isThrottled ? `配额余量偏低 (${lowestPercent}% < 10%)` : null)
      };
    } catch (err) {
      const isRateLimited = /resource_exhausted|rate_limit|too_many_requests|429/i.test(err.message || "");
      return {
        success: false,
        endpoint: this.baseUrl,
        fetchedAt: new Date().toISOString(),
        error: err.message,
        groups: [],
        lowestRemainingPercent: isRateLimited ? 0 : undefined,
        isExhausted: isRateLimited,
        isThrottled: isRateLimited,
        isRateLimited,
        throttleReason: isRateLimited ? `语言服务已触发速率或配额熔断限制 (${err.message})` : null
      };
    }
  }

  /**
   * 查询账户状态 (GetUserStatus)，获取账号 Tier、名称等
   */
  async getUserStatus() {
    try {
      const res = await this.callRpc("GetUserStatus", {});
      const statusObj = res?.userStatus || res || {};
      return {
        success: true,
        userTier: statusObj.userTier || null,
        acceptedTerms: statusObj.acceptedLatestTermsOfService ?? true,
        models: statusObj.clientModelSorts || []
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 综合查询配额与账户健康看板 (支持降级自愈)
   */
  async getCombinedQuotaHealth(forceRefresh = true) {
    const quota = await this.getUserQuotaSummary(forceRefresh);
    if (!quota.success) {
      return {
        ...quota,
        userTier: null
      };
    }
    const status = await this.getUserStatus();
    return {
      ...quota,
      userTier: status.userTier || null
    };
  }
}

