// EdgeOne Makers Edge Function：视频代理
// 路由：/api/video-proxy?url=<视频直链>（edge-functions/api/video-proxy.js 自动映射）
// 用途：Agnes 等网关的视频直链不带 CORS 头，浏览器内无法 fetch，导致"合并成片"无法获取数据。
// 本函数在服务端拉取视频并流式转发给前端（服务端无跨域限制），使纯静态站点的浏览器内合并可用。
//
// 安全校验：
//   1. 只允许代理白名单域名的视频（防止被当作开放代理滥用）
//   2. 仅允许 GET
//   3. 限制单次转发的 Content-Length 上限（500MB）
//   4. 不缓存、不落盘，纯流式转发

const ALLOWED_HOSTS = [
  'api.agnes-ai.cn',
  'apihub.agnes-ai.com',
  'agnes-ai.com',
  'agnes-ai.cn'
];

const MAX_BYTES = 500 * 1024 * 1024; // 500MB

export async function onRequest(context) {
  const request = context.request;
  const reqUrl = new URL(request.url);

  if (request.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405);
  }

  const target = reqUrl.searchParams.get('url');
  if (!target) {
    return json({ error: 'missing url param' }, 400);
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return json({ error: 'invalid url' }, 400);
  }

  if (!/^https?:$/.test(targetUrl.protocol)) {
    return json({ error: 'only http(s) allowed' }, 400);
  }

  if (!ALLOWED_HOSTS.some(h => targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h))) {
    return json({ error: 'host not allowed: ' + targetUrl.hostname }, 403);
  }

  // 透传 Range（前端/播放器可能分段拉流）
  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) headers.set('range', range);

  let upstream;
  try {
    upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
  } catch (e) {
    return json({ error: 'upstream fetch failed: ' + (e.message || e) }, 502);
  }

  // 顺带跟随到白名单外的重定向目标时再次校验
  const finalHost = upstream.url ? new URL(upstream.url).hostname : targetUrl.hostname;
  if (!ALLOWED_HOSTS.some(h => finalHost === h || finalHost.endsWith('.' + h))) {
    return json({ error: 'redirect host not allowed: ' + finalHost }, 403);
  }

  const len = Number(upstream.headers.get('content-length') || 0);
  if (len > MAX_BYTES) {
    return json({ error: 'file too large: ' + len }, 413);
  }

  const respHeaders = new Headers();
  respHeaders.set('access-control-allow-origin', '*');
  respHeaders.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
  if (upstream.headers.get('content-length')) respHeaders.set('content-length', upstream.headers.get('content-length'));
  if (upstream.headers.get('content-range')) respHeaders.set('content-range', upstream.headers.get('content-range'));
  if (upstream.headers.get('accept-ranges')) respHeaders.set('accept-ranges', upstream.headers.get('accept-ranges'));
  respHeaders.set('cache-control', 'no-store');
  respHeaders.set('x-proxy-upstream-status', String(upstream.status));

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
  });
}
