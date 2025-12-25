// Cloudflare Workers Scheduled Task（模块写法）

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};

// ================= 配置 =================

const TIMEOUT = 5000;      // 超时时间（毫秒）
const MAX_RETRIES = 3;    // 最大重试次数
const RETRY_DELAY = 500;  // 初始重试延迟（毫秒）

// ================= 工具函数 =================

// 解析 URL 列表：
// - 忽略空行
// - 忽略以 # 开头的注释行
function parseUrls(urlString) {
  return urlString
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// 带超时和重试机制的 fetch
async function fetchWithTimeout(env, url, retries = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    console.log(`🚀 请求: ${url}，第 ${retries} 次尝试`);

    const response = await fetch(url, {
      signal: controller.signal
    });

    // 非 2xx 状态码
    if (!response.ok) {
      // 仅 5xx 触发重试
      if (response.status >= 500 && response.status < 600) {
        throw new Error(`服务器错误（状态码: ${response.status}）`);
      } else {
        console.warn(
          `❌ 请求失败（非 5xx，不重试）: ${url}, 状态码: ${response.status}`
        );
        await handleFinalFailure(url, env);
        return;
      }
    }

    console.log(`✅ 成功: ${url}`);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(`⏳ 请求超时: ${url}`);
    } else {
      console.warn(
        `❌ 第 ${retries} 次失败: ${url}, 错误: ${error.message}`
      );
    }

    // 重试逻辑
    if (retries <= MAX_RETRIES) {
      const delay = RETRY_DELAY * (2 ** retries); // 指数退避
      console.warn(`🔄 ${delay}ms 后重试第 ${retries + 1} 次: ${url}`);

      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithTimeout(env, url, retries + 1);
    } else {
      console.error(`🚨 最终失败（已重试 ${MAX_RETRIES} 次）: ${url}`);
      await handleFinalFailure(url, env);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ================= 定时任务入口 =================

async function handleScheduled(env) {
  console.log('⏳ 定时任务开始');

  if (!env.URL_LIST) {
    console.error('❌ 未配置 URL_LIST 环境变量');
    return;
  }

  const urls = parseUrls(env.URL_LIST);

  if (urls.length === 0) {
    console.warn('⚠️ URL_LIST 中没有可用 URL');
    return;
  }

  console.log(`📌 本次任务共 ${urls.length} 个 URL`);

  const results = await Promise.allSettled(
    urls.map(url => fetchWithTimeout(env, url))
  );

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      console.log(`✅ 请求完成: ${urls[index]}`);
    } else {
      console.error(`❌ 请求失败: ${urls[index]}`);
    }
  });

  console.log('📊 定时任务结束');
}



/**
 * 最终失败处理：
 * - 仅当 url 包含 galaxy
 * - 且 KV 中 flag !== deployed
 * 才调用部署接口并写入 flag（TTL 3 小时）
 */
async function handleFinalFailure(url, env) {
  try {
    if (!url || !url.includes("galaxy")) {
      return;
    }

    const flag = await env.KV.get("flag");
    if (flag === "deployed") {
      return;
    }

    console.warn("⚠️ galaxy 请求最终失败，触发部署接口");

    const resp = await fetch(env.DEPLOY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Deploy-Token": `${env.FIXED_TOKEN}`
      },
      body: JSON.stringify({
        reason: "galaxy_final_retry_failed",
        url
      })
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error("❌ 部署接口调用失败", resp.status, text);
      return;
    }
    console.log("✅ /deploy 响应:", text);

    // 写入幂等标记，TTL 3 小时（10800 秒）
    await env.KV.put("flag", "deployed", {
      expirationTtl: 60 * 60 * 3
    });

    console.log("✅ 已触发部署并写入 deployed 标记");
  } catch (e) {
    console.error("❌ 最终失败处理逻辑异常", e);
  }
}
