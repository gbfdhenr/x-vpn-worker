# x-vpn-worker

**x-vpn 边缘聚合 Hub** — 基于 Cloudflare Worker 的订阅缓存、IP 地理定位与众包延迟聚合。

配套客户端：[x-vpn](https://github.com/gbfdhenr/x-vpn)

---

## 功能

| 功能 | 说明 |
|------|------|
| **订阅聚合** | 从 GitHub `free-nodes/v2rayfree` 拉取节点，Base64 解码，KV 缓存 1h |
| **已知源分发** | 作为订阅源列表的单一数据源，Python 端从这里拉取 |
| **众包延迟 ⭐** | 所有 x-vpn 客户端每小时提交 Ping 结果，按国家加权平均聚合。新用户请求时自动返回该国预测延迟 |
| **IP 地理定位** | ip-api.com 查询，KV 缓存 24h |
| **备用 Ping** | Cron 每 10 分钟 Worker 自测（标记 `source: worker-edge`） |

## 部署

### 方式一：Cloudflare Dashboard（推荐）

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 点 **Create application** → **Pages** → **Connect to Git**
3. 授权 GitHub，选择仓库 `gbfdhenr/x-vpn-worker`
4. 保存即自动部署

### 方式二：Wrangler CLI

```bash
# 安装 wrangler
npm install -g wrangler

# 登录
npx wrangler login

# 部署
npx wrangler deploy
```

### 前置条件

在 Cloudflare Dashboard 中：
1. 创建 **KV Namespace**（命名随意，绑定名必须为 `KV`）
2. 将 `ZONE_ID` 和 `KV_ID` 填入 `wrangler.toml`

## API

| 端点 | 方法 | 说明 |
|------|:----:|------|
| `/` | GET | 节点列表 HTML 页面 |
| `/list/x-vpn.txt` | GET | 原始 Base64 订阅 |
| `/api/sources` | GET | 已知订阅源列表 |
| `/api/ping/predict` | GET | 预测延迟（按请求端国家） |
| `/api/client-ping` | POST | 客户端提交 Ping（按国家聚合） |
| `/api/ping/<region>` | GET | 读取区域/国家 Ping 数据 |
| `/api/ping/<region>` | POST | 写入区域 Ping（需 PING_SECRET） |
| `/api/ping/list` | GET | 列出所有区域/国家 |
| `/api/geo/<ip>` | GET | IP 地理位置 |
| `/api/health` | GET | 健康检查 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `KV` | KV Namespace 绑定（必需） |
| `PING_SECRET` | 旧版 Ping 写入接口保护密钥（可选，公开仓库建议设 Secret） |
| `CF_REGION` | Worker 区域标识（默认 `auto`） |

## 防滥用机制

`POST /api/client-ping` 端点公开可用，包含以下防护：

- **频率限制**：同一 IP 每 10 分钟只能提交一次
- **节点上限**：单次最多 200 个节点
- **数据校验**：拒绝私有 IP、无效端口、异常延迟值
- **协议白名单**：只接受已知协议类型

## KV 存储模型

| Key | 说明 | TTL |
|-----|------|-----|
| `sub:YYYYMMDD` | 订阅原始文本 | 1h |
| `ping:{region}` | 旧格式延迟数据 | 24h |
| `ping:country:{CODE}` | 新格式按国家聚合延迟 | 24h |
| `geo:{ip}` | IP 地理位置缓存 | 24h |
| `ratelimit:ping:{ip}` | 客户端提交频率限制 | 10min |

## 开发

```bash
git clone git@github.com:gbfdhenr/x-vpn-worker.git
cd x-vpn-worker

# 本地开发
npx wrangler dev

# 部署
npx wrangler deploy
```

## License

MIT — Copyright (c) 2025 gbfdhenr
