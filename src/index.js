// == x-vpn Hub — Cloudflare Worker（完全自包含）==
// 不需要任何外部依赖，所有数据从 GitHub 获取后缓存在 KV
//
// 路由: x-vpn.liangxiangan.top/*
// KV 绑定: KV
// 环境变量: 可选 PING_SECRET（保护 Ping 写入端口）
//
// 功能:
//   0.  /                          主页：列出已解码的节点列表
//   1.  /list/x-vpn.txt           订阅聚合（原始 base64，缓存 1h）
//   2.  /api/ping/<region>        GET  读取区域延迟（旧格式）
//   3.  /api/ping/list            GET  列出可用区域
//   4.  /api/ping/predict         GET  按客户端国家返回预测延迟（新）
//   5.  /api/client-ping          POST 客户端提交 ping 数据，按国家聚合（新）
//   6.  /api/ping/<region>        POST 写入区域 Ping（受 shared_secret 保护）
//   7.  /api/geo/<ip>             GET  地理位置（KV 缓存 24h）
//   8.  /api/health               GET  健康检查
//   9.  Cron */10 * * * *             全球 Ping 备用（标注 source=worker-edge）
//
// KV 存储模型:
//   sub:YYYYMMDD                  → 订阅原始文本（1h TTL）
//   ping:{region}                 → 旧格式：{ server: {port, latency, checked_at} }
//   ping:country:{COUNTRY_CODE}   → 新格式(按国家聚合)：
//                                    { "server:port": {latency, samples, type, updated_at},
//                                      updated_at: "ISO" }
//   geo:{ip}                      → { country, country_code, city, isp }（24h TTL）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Ping-Secret',
    };
    if (method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // 0. 主页：列出已解码的节点
      if (path === '/' && method === 'GET') {
        return await handleHome(env, cors);
      }

      // 1. 订阅聚合（原始 base64）
      if (path === '/list/x-vpn.txt' && method === 'GET') {
        return await handleSubscription(url, env, cors);
      }

      // 2. 预测延迟 — 按请求客户端国家返回（新）
      if (path === '/api/ping/predict' && method === 'GET') {
        return await handlePingPredict(request, env, cors);
      }

      // 3. 客户端提交 ping 数据（新）
      if (path === '/api/client-ping' && method === 'POST') {
        return await handleClientPing(request, env, cors);
      }

      // 4. 读取区域/国家 Ping
      if (path.startsWith('/api/ping/') && method === 'GET') {
        const region = path.replace('/api/ping/', '');
        if (region === 'list') return await handlePingList(env, cors);
        if (region === 'predict') return new Response('Not found', { status: 404, headers: cors }); // already handled above
        return await handlePingGet(region, env, cors);
      }

      // 5. 写入区域 Ping（旧，受 shared_secret 保护）
      if (path.startsWith('/api/ping/') && method === 'POST') {
        const region = path.replace('/api/ping/', '');
        if (region === 'list' || region === 'predict') {
          return new Response('Method not allowed', { status: 405, headers: cors });
        }
        return await handlePingSet(region, request, env, cors);
      }

      // 6. 地理位置
      if (path.startsWith('/api/geo/') && method === 'GET') {
        const ip = path.replace('/api/geo/', '');
        return await handleGeo(ip, env, cors);
      }

      // 7. 已知源列表（从 Worker 下发，Python 端从这里拉取）
      if (path === '/api/sources' && method === 'GET') {
        return await handleSources(env, cors);
      }

      // 8. 健康检查
      if (path === '/api/health' && method === 'GET') {
        return new Response(JSON.stringify({ status: 'ok', worker: 'x-vpn-hub' }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  },

  // Cron: 每 10 分钟执行全球 Ping（备用，source=worker-edge）
  async scheduled(event, env, ctx) {
    const region = env.CF_REGION || 'auto';
    await runPingAll(region, env);
  },
};

// ================================================================
//  1. 订阅聚合
// ================================================================
async function handleSubscription(url, env, cors) {
  const dateParam = url.searchParams.get('date');
  const now = new Date();
  const dateStr = dateParam || `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;

  const cacheKey = `sub:${dateStr}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=1800',
        'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' },
    });
  }

  const urls = [
    `https://raw.githubusercontent.com/free-nodes/v2rayfree/main/v${dateStr}2`,
    `https://raw.githubusercontent.com/free-nodes/v2rayfree/main/v${dateStr}1`,
  ];
  let resp = null;
  for (const u of urls) {
    try { const r = await fetch(u); if (r.ok) { resp = r; break; } } catch {}
  }
  if (!resp) return new Response('No subscription available.', { status: 404, headers: cors });

  const text = await resp.text();
  await env.KV.put(cacheKey, text, { expirationTtl: 3600 });
  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=1800',
      'Access-Control-Allow-Origin': '*', 'X-Cache': 'MISS' },
  });
}

// ================================================================
//  2. 预测延迟（新）
//  根据请求客户端所属国家，返回该国家所有客户提交的聚合延迟
//  如果无数据则 fallback 到全局均值或 worker-edge 数据
// ================================================================
async function handlePingPredict(request, env, cors) {
  // 从 CF 请求中获取客户端国家
  const clientCountry = request.cf?.country || 'XX';
  const clientIp = request.headers.get('CF-Connecting-IP') || '';

  // 尝试读取该国家的聚合数据
  let countryData = await env.KV.get(`ping:country:${clientCountry}`, 'json');
  let source = clientCountry;

  // 如果没有数据，fallback 到 "auto"（Worker Cron 数据）
  if (!countryData || !countryData.updated_at) {
    const autoData = await env.KV.get('ping:auto', 'json');
    if (autoData && autoData.updated_at) {
      // 转换旧格式 -> 新格式
      countryData = {
        nodes: {},
        updated_at: autoData.updated_at,
        source: 'worker-edge',
      };
      for (const [server, info] of Object.entries(autoData)) {
        if (server === 'colo' || server === 'updated_at') continue;
        const key = `${server}:${info.port || 443}`;
        countryData.nodes[key] = {
          latency: info.latency || -1,
          samples: 1,
          type: info.type || 'unknown',
          updated_at: info.checked_at || autoData.updated_at,
          source: 'worker-edge',
        };
      }
    }
    source = 'worker-edge';
  }

  // 如果没有数据就尝试所有国家的全局均值
  if (!countryData || !countryData.nodes || Object.keys(countryData.nodes).length === 0) {
    countryData = await aggregateGlobalPing(env);
    source = 'global';
  }

  return new Response(JSON.stringify({
    success: true,
    country: clientCountry,
    client_ip: clientIp,
    source: source || clientCountry,
    updated_at: countryData?.updated_at || null,
    nodes: countryData?.nodes || {},
    node_count: countryData?.nodes ? Object.keys(countryData.nodes).length : 0,
  }), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ================================================================
//  3. 客户端提交 Ping（新）
//  接受来自 x-vpn 客户端的按小时 ping 结果，按国家聚合
//  使用加权平均合并多次采样
// ================================================================
async function handleClientPing(request, env, cors) {
  const body = await request.json();

  // 国家检测：优先 body.country，其次 CF 请求国家
  let country = (body.country || '').toUpperCase().trim();
  if (!country || country.length !== 2) {
    country = request.cf?.country || 'XX';
  }

  const nodes = body.nodes || [];
  if (!nodes.length) {
    return new Response(JSON.stringify({ error: 'No nodes provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const key = `ping:country:${country}`;
  const now = new Date().toISOString();

  // 读取现有聚合数据
  let aggregated = (await env.KV.get(key, 'json')) || { nodes: {}, updated_at: now };

  // 合并：加权平均
  for (const n of nodes) {
    const nodeKey = `${n.server}:${n.port}`;
    const newLatency = n.latency;
    const newAlive = n.alive !== false && newLatency >= 0;

    if (!newAlive) continue; // 只记录活着的节点

    const existing = aggregated.nodes[nodeKey];
    if (existing) {
      // 加权平均：旧样本数 * 旧延迟 + 新延迟 / (旧样本数 + 1)
      const samples = (existing.samples || 1);
      const totalLatency = existing.latency * samples + newLatency;
      existing.latency = Math.round(totalLatency / (samples + 1));
      existing.samples = samples + 1;
      existing.updated_at = now;
      existing.type = n.type || existing.type || 'unknown';
    } else {
      aggregated.nodes[nodeKey] = {
        latency: newLatency,
        samples: 1,
        type: n.type || 'unknown',
        updated_at: now,
      };
    }
  }

  aggregated.updated_at = now;

  // 写入 KV（24h TTL）
  await env.KV.put(key, JSON.stringify(aggregated), { expirationTtl: 86400 });

  return new Response(JSON.stringify({
    ok: true,
    country,
    nodes_received: nodes.length,
    nodes_stored: Object.keys(aggregated.nodes).length,
    updated_at: now,
  }), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ================================================================
//  4. Ping 读取（旧格式 + 新格式兼容）
// ================================================================
async function handlePingList(env, cors) {
  // 旧格式 ping:{region}
  const oldList = await env.KV.list({ prefix: 'ping:' });
  // 新格式 ping:country:{CODE}
  const countryList = await env.KV.list({ prefix: 'ping:country:' });

  const regions = oldList.keys
    .map(k => k.name.replace('ping:', ''))
    .filter(r => r !== 'country'); // 排除新格式前缀

  const countries = countryList.keys
    .map(k => k.name.replace('ping:country:', ''));

  return new Response(JSON.stringify({
    regions,
    countries,
    all: [...new Set([...regions, ...countries])],
  }), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function handlePingGet(region, env, cors) {
  // 先尝试旧格式
  let data = await env.KV.get(`ping:${region}`, 'json');

  // 再尝试新格式（ping:country:{region}）
  if (!data) {
    data = await env.KV.get(`ping:country:${region}`, 'json');
  }

  return new Response(JSON.stringify({
    region,
    data: data || {},
    updated_at: data?.updated_at || null,
  }), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ================================================================
//  5. Ping 写入（旧，带 shared_secret 保护，兼容 Cron）
//  同时写入旧格式 ping:{region} 和新格式 ping:country:{region}
//  如果 region 看起来像 2 字母国家代码，则两边都写
// ================================================================
async function handlePingSet(region, request, env, cors) {
  // 验证共享 secret
  const auth = request.headers.get('X-Ping-Secret');
  const expected = env.PING_SECRET;
  if (expected && auth !== expected) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: cors });
  }

  const body = await request.json();
  const now = new Date().toISOString();

  // 写入旧格式
  const oldKey = `ping:${region}`;
  const existing = (await env.KV.get(oldKey, 'json')) || {};
  for (const n of body.nodes || []) {
    existing[n.server] = { port: n.port, latency: n.latency, checked_at: now, type: n.type || 'unknown' };
  }
  existing.colo = body.colo || region;
  existing.updated_at = now;
  await env.KV.put(oldKey, JSON.stringify(existing), { expirationTtl: 86400 });

  // 如果 region 是 2 字母国家代码，同时写入新格式
  if (/^[A-Z]{2}$/.test(region.toUpperCase())) {
    await aggregateIntoCountry(region, body.nodes || [], now, env);
  }

  return new Response(JSON.stringify({ ok: true, region, nodes: Object.keys(existing).length }), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ================================================================
//  辅助：按国家聚合数据
// ================================================================
async function aggregateIntoCountry(country, nodes, timestamp, env) {
  const key = `ping:country:${country}`;
  let aggregated = (await env.KV.get(key, 'json')) || { nodes: {}, updated_at: timestamp };

  for (const n of nodes) {
    const nodeKey = `${n.server}:${n.port}`;
    const newLatency = n.latency;
    if (newLatency < 0) continue;

    const existing = aggregated.nodes[nodeKey];
    if (existing) {
      const samples = existing.samples || 1;
      existing.latency = Math.round((existing.latency * samples + newLatency) / (samples + 1));
      existing.samples = samples + 1;
      existing.updated_at = timestamp;
      existing.type = n.type || existing.type || 'unknown';
    } else {
      aggregated.nodes[nodeKey] = {
        latency: newLatency,
        samples: 1,
        type: n.type || 'unknown',
        updated_at: timestamp,
      };
    }
  }

  aggregated.updated_at = timestamp;
  await env.KV.put(key, JSON.stringify(aggregated), { expirationTtl: 86400 });
}

// ================================================================
//  7. 已知源列表（可扩展，Worker 是单一数据源）
// ================================================================

// 已知订阅源 —— 想加新的直接在这里加，Python 端自动获取
const KNOWN_SOURCES = [
  {
    key: 'v2rayfree',
    name: 'V2RayFree GitHub',
    url: 'https://raw.githubusercontent.com/free-nodes/v2rayfree/main/subscribe',
    type: 'github',
    description: 'Free V2Ray nodes from GitHub (v2rayfree)',
  },
  {
    key: 'x-vpn-hub',
    name: 'x-vpn Hub',
    url: 'https://x-vpn.liangxiangan.top/list/x-vpn.txt',
    type: 'worker',
    description: 'x-vpn Hub aggregated subscription',
    supports_date: true,
  },
];

async function handleSources(env, cors) {
  // 可选：从 KV 读取自定义源列表（管理员可扩展）
  let customSources = [];
  try {
    const custom = await env.KV.get('sources:custom', 'json');
    if (custom && Array.isArray(custom)) {
      customSources = custom;
    }
  } catch {}

  const all = [...KNOWN_SOURCES, ...customSources];
  return new Response(JSON.stringify({
    success: true,
    sources: all,
    total: all.length,
  }), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// 辅助：通过 KV 添加自定义源（可选，管理员用）
// 通过 POST /api/sources/add 调用

// ================================================================
//  辅助：从所有国家数据聚合全局均值
// ================================================================
async function aggregateGlobalPing(env) {
  const countryList = await env.KV.list({ prefix: 'ping:country:' });
  if (!countryList.keys.length) return { nodes: {}, updated_at: null };

  const globalNodes = {};
  let latestUpdated = null;

  for (const { name } of countryList.keys) {
    const data = await env.KV.get(name, 'json');
    if (!data || !data.nodes) continue;

    if (data.updated_at && (!latestUpdated || data.updated_at > latestUpdated)) {
      latestUpdated = data.updated_at;
    }

    for (const [nodeKey, info] of Object.entries(data.nodes)) {
      if (nodeKey === 'updated_at') continue;
      if (globalNodes[nodeKey]) {
        const totalSamples = globalNodes[nodeKey].samples + info.samples;
        globalNodes[nodeKey].latency = Math.round(
          (globalNodes[nodeKey].latency * globalNodes[nodeKey].samples + info.latency * info.samples) / totalSamples
        );
        globalNodes[nodeKey].samples = totalSamples;
        globalNodes[nodeKey].updated_at = info.updated_at > globalNodes[nodeKey].updated_at
          ? info.updated_at : globalNodes[nodeKey].updated_at;
      } else {
        globalNodes[nodeKey] = { ...info };
      }
    }
  }

  return { nodes: globalNodes, updated_at: latestUpdated, source: 'global' };
}

// ================================================================
//  6. 地理位置
// ================================================================
async function handleGeo(ip, env, cors) {
  const cached = await env.KV.get(`geo:${ip}`, 'json');
  if (cached) {
    return new Response(JSON.stringify({ ip, ...cached, cache: 'HIT' }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,isp,query`);
    const data = await resp.json();
    if (data.status === 'success') {
      const result = { country: data.country, country_code: data.countryCode, city: data.city, isp: data.isp };
      await env.KV.put(`geo:${ip}`, JSON.stringify(result), { expirationTtl: 86400 });
      return new Response(JSON.stringify({ ip, ...result, cache: 'MISS' }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    return new Response(JSON.stringify({ ip, error: 'lookup failed' }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ip, error: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}

// ================================================================
//  7. 全球 Ping 执行器（Cron，备用）
//  从 KV 缓存的订阅数据中解析节点，直接测延迟
//  结果写入旧格式 ping:auto 和新格式 ping:country:XX
// ================================================================
async function runPingAll(region, env) {
  try {
    // 从 KV 读取当天的订阅数据
    const now = new Date();
    const ds = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const cached = await env.KV.get(`sub:${ds}`);
    if (!cached) { console.log('No subscription data in KV'); return; }

    // 解码 base64
    let decoded = cached;
    try { decoded = atob(cached.trim()); } catch {}

    // 解析出所有节点 (server:port)
    const links = decoded.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const nodes = [];
    for (const link of links) {
      const n = parseLink(link.trim());
      if (n && n.server) nodes.push({ server: n.server, port: parseInt(n.port) || 443, type: n.type || 'unknown' });
    }

    // 去重（与 Python 端一致：server + port + type）
    const seen = new Set();
    const unique = [];
    for (const n of nodes) {
      const key = `${n.server}:${n.port}:${n.type || 'unknown'}`;
      if (!seen.has(key)) { seen.add(key); unique.push(n); }
    }

    // 并发 Ping（最多 50 个）
    const targets = unique.slice(0, 50);
    const results = await Promise.all(
      targets.map(async n => ({
        server: n.server,
        port: n.port,
        type: n.type || 'unknown',
        latency: await probeLatency(n.server, n.port),
      }))
    );

    const timestamp = new Date().toISOString();

    // 写入旧格式 ping:{region}
    const oldKey = `ping:${region}`;
    const existing = (await env.KV.get(oldKey, 'json')) || {};
    for (const r of results) {
      existing[r.server] = { port: r.port, latency: r.latency, checked_at: timestamp, type: r.type };
    }
    existing.colo = region;
    existing.updated_at = timestamp;
    await env.KV.put(oldKey, JSON.stringify(existing), { expirationTtl: 86400 });

    // 写入新格式 ping:country:{region}（如果 region 是 2 字母国家码）
    if (/^[A-Z]{2}$/.test(region.toUpperCase())) {
      await aggregateIntoCountry(region, results, timestamp, env);
    }

    const alive = results.filter(r => r.latency >= 0).length;
    console.log(`Ping ${region}: ${alive}/${results.length} alive, ${unique.length} unique nodes (worker-edge)`);
  } catch (e) {
    console.log(`Ping error: ${e.message}`);
  }
}

// ================================================================
//  延迟探测（HTTP HEAD，兼容所有 Workers 环境）
// ================================================================
async function probeLatency(host, port, timeout = 3000) {
  const start = Date.now();
  for (const proto of [port === 443 ? 'https' : 'http', port === 443 ? 'http' : 'https']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      await fetch(`${proto}://${host}:${port}/`, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(timer);
      return Date.now() - start;
    } catch {}
  }
  return -1;
}

// ================================================================
//  0. 主页：节点列表（HTML）
// ================================================================
async function handleHome(env, cors) {
  // 获取当天日期的订阅
  const now = new Date();
  const ds = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const cached = await env.KV.get(`sub:${ds}`);
  if (!cached) {
    return new Response('<html><body><h1>x-vpn</h1><p>No nodes available for today. <a href="/list/x-vpn.txt">Try raw subscription</a></p></body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors },
    });
  }

  // 解码 base64
  let decoded = cached;
  try {
    decoded = atob(cached.trim());
  } catch {}

  // 解析每一行
  const links = decoded.split('\n').filter(l => l.trim());
  const nodes = [];
  for (const link of links) {
    const n = parseLink(link.trim());
    if (n) nodes.push(n);
  }

  // 统计
  const types = {};
  for (const n of nodes) { types[n.type] = (types[n.type] || 0) + 1; }
  const typeSummary = Object.entries(types).map(([k,v]) => `${k}: ${v}`).join(' | ');

  // 生成 HTML
  let html = `<!DOCTYPE html><html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>x-vpn - Free Nodes</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;max-width:1000px;margin:20px auto;padding:0 16px}
h1{color:#3b82f6;font-size:1.5rem}
.summary{color:#94a3b8;font-size:0.9rem;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{text-align:left;padding:8px 6px;border-bottom:2px solid #334155;color:#64748b;font-weight:600}
td{padding:6px;border-bottom:1px solid #1e293b;word-break:break-all}
tr:hover{background:#1e293b}
.type{display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.75rem;font-weight:600}
.type-vmess{background:rgba(59,130,246,0.2);color:#60a5fa}
.type-vless{background:rgba(139,92,246,0.2);color:#a78bfa}
.type-ss{background:rgba(34,197,94,0.2);color:#4ade80}
.type-trojan{background:rgba(245,158,11,0.2);color:#fbbf24}
.link{color:#3b82f6;text-decoration:none;font-size:0.8rem}
.link:hover{text-decoration:underline}
.footer{margin-top:20px;color:#475569;font-size:0.8rem}
</style></head>
<body>
<h1>x-vpn Free Nodes</h1>
<div class="summary">${nodes.length} nodes | ${typeSummary} | ${ds}</div>
<table>
<tr><th>#</th><th>Type</th><th>Server</th><th>Port</th><th>Tag</th><th>Link</th></tr>\n`;

  nodes.forEach((n, i) => {
    html += `<tr>
<td>${i+1}</td>
<td><span class="type type-${n.type}">${n.type}</span></td>
<td>${n.server}</td>
<td>${n.port}</td>
<td>${n.tag || '-'}</td>
<td><a class="link" href="${n.link}" target="_blank">copy</a></td>
</tr>\n`;
  });

  html += `</table>
<div class="footer">x-vpn Hub · <a href="/list/x-vpn.txt" style="color:#475569">Raw Base64</a></div>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors },
  });
}

// ================================================================
//  Link Parser（vmess:// ss:// trojan:// vless://）
// ================================================================
function parseLink(link) {
  try {
    if (link.startsWith('vmess://')) {
      const b64 = link.slice(8);
      const json = JSON.parse(atob(b64));
      return { type: 'vmess', server: json.add || '', port: json.port || '', tag: json.ps || '', link };
    }
    if (link.startsWith('ss://')) {
      const rest = link.slice(5);
      const tag = rest.includes('#') ? rest.split('#')[1] || '' : '';
      const p = rest.split('@');
      if (p.length === 2) {
        const hp = p[1].split('#')[0].split(':');
        return { type: 'ss', server: hp[0] || '', port: hp[1] || '', tag, link };
      }
      // SIP002: everything in base64
      try {
        const dec = atob(rest.split('#')[0]);
        const parts = dec.split('@');
        if (parts.length === 2) {
          const hp = parts[1].split(':');
          return { type: 'ss', server: hp[0] || '', port: hp[1] || '', tag, link };
        }
      } catch {}
      return { type: 'ss', server: '', port: '', tag, link };
    }
    if (link.startsWith('trojan://')) {
      const rest = link.slice(9);
      const tag = rest.includes('#') ? rest.split('#')[1] || '' : '';
      const p = rest.split('@');
      if (p.length === 2) {
        const hp = p[1].split('?')[0].split('#')[0].split(':');
        return { type: 'trojan', server: hp[0] || '', port: hp[1] || '', tag, link };
      }
      return { type: 'trojan', server: '', port: '', tag, link };
    }
    if (link.startsWith('vless://')) {
      const rest = link.slice(8);
      const tag = rest.includes('#') ? rest.split('#')[1] || '' : '';
      const p = rest.split('@');
      if (p.length === 2) {
        const hp = p[1].split('?')[0].split('#')[0].split(':');
        return { type: 'vless', server: hp[0] || '', port: hp[1] || '', tag, link };
      }
      return { type: 'vless', server: '', port: '', tag, link };
    }
  } catch {}
  return null;
}
