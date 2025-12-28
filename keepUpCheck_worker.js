// Cloudflare Workers Scheduled Task（模块写法）

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};

// ================= 配置 =================

const TIMEOUT = 5000;
const MAX_ATTEMPT = 3;
const RETRY_DELAY = 500;
const CONCURRENCY = 3;

// ================= URL 解析 =================

// - 忽略空行
// - 忽略以 # 开头的注释行
function parseUrls(urlString) {
  return urlString
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// ================= 并发控制 =================

async function runWithConcurrency(tasks, limit) {
  const executing = new Set();

  for (const task of tasks) {
    const p = task();
    executing.add(p);
    p.finally(() => executing.delete(p));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.allSettled(executing);
}

// ================= fetch + timeout + retry =================

async function fetchWithTimeout(env, url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    console.log(`🚀 请求 ${url}（第 ${attempt} 次）`);

    const response = await fetch(url, {
      signal: controller.signal
    });

    // ✅ 关键：始终消费 body
    await response.arrayBuffer();

    if (!response.ok) {
      if (response.status >= 500) {
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
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`⏳ 超时: ${url}`);
    } else {
      console.warn(`❌ 失败: ${url} - ${err.message}`);
    }

    if (attempt < MAX_ATTEMPT) {
      const delay = RETRY_DELAY * (2 ** attempt);
      console.warn(`🔄 ${delay}ms 后重试: ${url}`);
      await sleep(delay);
      return fetchWithTimeout(env, url, attempt + 1);
    } else {
      console.error(`🚨 最终失败: ${url}`);
      await handleFinalFailure(url, env);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ================= 定时入口 =================

async function handleScheduled(env) {
  console.log('⏳ 定时任务开始');

  if (!env.URL_LIST) {
    console.error('❌ 未配置 URL_LIST');
    return;
  }

  const urls = parseUrls(env.URL_LIST);

  if (!urls.length) {
    console.warn('⚠️ URL_LIST 为空');
    return;
  }

  console.log(`📌 URL 数量: ${urls.length}`);
  console.log(`⚙️ 并发限制: ${CONCURRENCY}`);

  const tasks = urls.map(url => () => fetchWithTimeout(env, url));

  await runWithConcurrency(tasks, CONCURRENCY);

  console.log('📊 定时任务结束');
}

// ================= 最终失败处理 =================

async function handleFinalFailure(url, env) {
  try {
    if (!url.includes('galaxy')) return;

    console.warn('⚠️ galaxy 最终失败，触发部署接口');

    const resp = await fetch(env.DEPLOY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Deploy-Token': env.FIXED_TOKEN
      },
      body: JSON.stringify({
        reason: 'galaxy_final_retry_failed',
        url
      })
    });

    // ✅ 同样必须消费
    await resp.arrayBuffer();

    if (!resp.ok) {
      console.error(`❌ 部署接口失败: ${resp.status}`);
      return;
    }

    console.log('✅ 部署接口已触发');
  } catch (e) {
    console.error('❌ 最终失败处理异常', e);
  }
}

// ================= utils =================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
