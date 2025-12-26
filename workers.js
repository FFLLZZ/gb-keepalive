export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // 仅允许 POST /deploy
    if (url.pathname === "/deploy" && req.method === "POST") {
      console.log("➡️ /deploy called");

      // ===== Token 鉴权 =====
      const tokenFromHeader = req.headers.get("X-Deploy-Token");
      if (!tokenFromHeader || tokenFromHeader !== env.DEPLOY_TOKEN) {
        console.warn("❌ Unauthorized request");
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      try {
        const result = await run(env);
        console.log("✅ deploy finished", result);
        return json({ ok: true, result });
      } catch (err) {
        console.error("🚨 deploy error", err);
        return json({ ok: false, error: err.message }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

// ================= 常量 =================

const FLAG_KEY = "flag";
const FLAG_TTL = 3 * 60 * 60; // 3 小时（秒）

// ================= 核心流程 =================

async function run(env) {
  const {
    GITHUB_TOKEN,
    GH_BRANCH,
    GH_CONTENT_API_URL,
    STATE_KV
  } = env;

  console.log("🔧 env check", {
    hasToken: !!GITHUB_TOKEN,
    branch: GH_BRANCH,
    apiUrl: GH_CONTENT_API_URL,
    hasKV: !!STATE_KV
  });

  if (!GITHUB_TOKEN || !GH_CONTENT_API_URL) {
    throw new Error("必要的环境变量未配置");
  }

  // ===== 幂等控制 =====
  const flag = await STATE_KV.get(FLAG_KEY);
  console.log("🧱 KV flag =", flag);

  if (flag === "deployed") {
    return { skipped: true, reason: "already deployed (within 3 hours)" };
  }

  console.log("📥 reading file from GitHub");

  const file = await getFile(
    GITHUB_TOKEN,
    GH_CONTENT_API_URL,
    GH_BRANCH
  );

  const rawContent = base64DecodeUtf8(file.content);
  const newContent = updateTimestampSection(rawContent);

  if (newContent === rawContent) {
    console.log("📄 content unchanged");
    return { skipped: true, reason: "content unchanged" };
  }

  console.log("📤 updating file on GitHub");

  await updateFile(
    GITHUB_TOKEN,
    GH_CONTENT_API_URL,
    GH_BRANCH,
    file.sha,
    newContent
  );

  // ===== 写入幂等标记 =====
  await STATE_KV.put(FLAG_KEY, "deployed", {
    expirationTtl: FLAG_TTL
  });

  console.log("🟢 deployed flag set (3h)");

  return { deployed: true };
}

// ================= GitHub API =================

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "cloudflare-worker"
  };
}

async function getFile(token, apiUrl, branch) {
  const url = branch
    ? `${apiUrl}?ref=${encodeURIComponent(branch)}`
    : apiUrl;

  console.log("➡️ GET", url);

  const res = await fetch(url, {
    headers: ghHeaders(token)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ getFile failed", res.status, text);
    throw new Error(`读取文件失败: ${res.status}`);
  }

  return res.json();
}

async function updateFile(token, apiUrl, branch, sha, content) {
  const body = {
    message: "chore: auto update README timestamp",
    content: base64EncodeUtf8(content),
    sha,
    branch,
    committer: {
      name: "cloudflare-worker[bot]",
      email: "cloudflare-worker@users.noreply.github.com"
    }
  };

  console.log("➡️ PUT", apiUrl);

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: ghHeaders(token),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ updateFile failed", res.status, text);
    throw new Error(`提交失败: ${res.status}`);
  }
}

// ================= README 时间戳逻辑 =================

function updateTimestampSection(content) {
  const utc = new Date();
  const bj = new Date(
    utc.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
  );

  const fmt = d =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const section =
`\n## 🕒 最后更新时间

**UTC**: \`${fmt(utc)}\`  
**北京时间**: \`${fmt(bj)}\`  

> ⚡ 此时间戳由 Cloudflare Workers 自动更新
`;

  const reg = /## 🕒 最后更新时间[\s\S]*?(?=\n## |\n# |$)/;

  if (reg.test(content)) {
    return content.replace(reg, section.trim());
  }

  return content.trimEnd() + "\n" + section;
}

// ================= 编码工具函数（关键） =================

function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function base64DecodeUtf8(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ================= 通用工具 =================

function pad(n) {
  return String(n).padStart(2, "0");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
