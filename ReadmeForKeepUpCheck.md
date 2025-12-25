````md
# KeepUp Check – Cloudflare Workers 定时保活与自愈触发器

`KeepUp Check` 是一个基于 **Cloudflare Workers Scheduled Trigger** 的轻量级可达性检测与自愈触发组件。

其核心职责是：  
**定期探测一组 URL 的可访问性，在满足特定条件且多次重试仍失败的情况下，自动触发部署/修复接口，并通过 KV 实现幂等控制，避免重复执行。**

---

## 一、设计目标

- 定时检测多个服务 URL 的可用性
- 对瞬时网络波动具备容错能力（超时 + 重试）
- 仅在**明确失败**的情况下触发修复行为
- 防止部署接口被频繁或并发调用
- 逻辑简单、可审计、易维护

---

## 二、整体工作流程

1. Cloudflare Cron 触发 `scheduled` 事件
2. 解析 `URL_LIST` 环境变量，获取待检测 URL 列表
3. 对每个 URL 执行带超时和指数退避重试的 `fetch`
4. 若请求成功（HTTP 2xx），记录成功日志
5. 若请求失败：
   - 非 5xx：直接视为最终失败
   - 5xx / 超时：按策略重试
6. 最终失败时：
   - **仅当 URL 包含指定关键字（如 `galaxy`）**
   - **且 KV 中不存在 `deployed` 标记**
   - 才会触发部署接口
7. 成功触发部署后：
   - 在 KV 中写入 `flag=deployed`
   - 设置 TTL 为 3 小时，防止重复触发

---

## 三、核心机制说明

### 1. URL 列表解析规则

`URL_LIST` 为多行字符串，解析规则如下：

- 忽略空行
- 忽略以 `#` 开头的注释行
- 每行一个 URL

示例：

```text
# 主服务
https://example.com/health

# 备用服务
https://galaxy.example.com/ping
````

---

### 2. 请求超时与重试策略

| 参数            | 值     | 说明                 |
| --------------- | ------ | -------------------- |
| `TIMEOUT`     | 5000ms | 单次请求最大等待时间 |
| `MAX_RETRIES` | 3      | 最大重试次数         |
| `RETRY_DELAY` | 500ms  | 初始延迟（指数退避） |

重试延迟计算方式：

```
delay = RETRY_DELAY * (2 ^ retries)
```

---

### 3. 重试触发条件

* **仅以下情况会进入重试逻辑：**

  * 请求超时
  * HTTP 状态码为 5xx
* **以下情况不会重试：**

  * HTTP 4xx
  * 明确返回非成功状态的业务错误

---

### 4. 最终失败处理逻辑

最终失败并不一定触发部署，必须**同时满足以下条件**：

1. URL 字符串中 **包含指定关键字**

   ```js
   url.includes("galaxy")
   ```
2. KV 中不存在以下标记：

   ```text
   flag = deployed
   ```

只有在上述条件全部满足时，才会：

* 调用部署接口
* 写入 KV 幂等标记

---

## 四、部署接口触发说明

### 调用方式

```http
POST {DEPLOY_API_URL}
```

#### 请求头

```http
Content-Type: application/json
X-Deploy-Token: <FIXED_TOKEN>
```

#### 请求体

```json
{
  "reason": "galaxy_final_retry_failed",
  "url": "https://galaxy.example.com/ping"
}
```

### 成功条件

* HTTP 状态码为 2xx
* 返回内容仅用于日志记录，不参与逻辑判断

---

## 五、幂等控制（KV）

### KV Key

```text
flag
```

### KV Value

```text
deployed
```

### TTL

```text
3 小时（10800 秒）
```

### 行为说明

* 在 TTL 有效期内：

  * 即使再次检测失败
  * **也不会再次触发部署接口**
* TTL 到期后：

  * 允许下一次失败重新触发部署

---

## 六、环境变量配置

### 必需变量

| 变量名             | 说明                    |
| ------------------ | ----------------------- |
| `URL_LIST`       | 待检测 URL 列表（多行） |
| `DEPLOY_API_URL` | 部署 / 修复接口地址     |
| `FIXED_TOKEN`    | 部署接口鉴权 Token      |
| `KV`             | Cloudflare KV Namespace |

---

## 七、日志与可观测性

Worker 会输出以下关键日志：

* 定时任务开始 / 结束
* 每个 URL 的请求尝试次数
* 超时 / 5xx / 非重试失败原因
* 最终失败与是否触发部署
* KV 幂等命中情况

适合直接在 Cloudflare Dashboard 中排查问题。

---

## 八、适用场景

* 免费或低配服务的“保活检测”
* 需要外部信号触发自愈部署
* 不希望使用 GitHub Actions / 外部监控平台
* 对误触发部署有严格控制要求的系统

---

## 九、注意事项

* 本 Worker **不会主动恢复服务**，只负责“检测 + 触发”
* 关键字匹配逻辑可按需扩展为：

  * 域名白名单
  * 正则匹配
  * 多服务分类
* 当前为串行逻辑，适合中小规模 URL 数量

---

## 十、License

MIT License
