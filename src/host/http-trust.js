/**
 * 复刻自 dshmarket/src/http.ts:66 与 src/restart.ts:198。
 *
 * 为什么重启需要"环回权威"而不只是"环回 peer"：
 * DNS rebinding 攻击可以让攻击者控制的页面到达 127.0.0.1。
 * socket.remoteAddress 看起来是环回，但 Host 头里写的是攻击者的域名。
 * Host 头是攻击者**不能**伪造的部分（因为 DNS rebinding 的精髓就是 host 头
 * 跟 remoteAddress 对不上），所以 Host 必须命名一个环回权威才放行。
 */

/**
 * @param {string | undefined} host
 * @returns {boolean}
 */
export function loopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  const raw = host.toLowerCase();
  // 不带端口时直接命中。必须先比完整串：剥端口正则 `:\d+$` 会把 IPv6 裸地址
  // `::1` 末尾的 `:1` 当成端口剥掉（得到 `:`），从而漏判。放在前面直接命中
  // 就没有这个坑。
  if (raw === 'localhost' || raw === '127.0.0.1' || raw === '[::1]' || raw === '::1' || raw === '0.0.0.0') {
    return true;
  }
  // 带端口：剥掉末尾 :port 再比（`[::1]:3080` → `[::1]`）。
  const hostname = raw.replace(/:\d+$/u, '');
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '0.0.0.0';
}

/**
 * 本地功能请求（投递 / 配置）是否来自可信来源。
 *
 * 与 trustedRestartRequest 同一套环回防线，只松一档：**放行没有 Origin 头**的请求。
 * 浏览器对跨站 POST（哪怕 content-type 是 text/plain 的"简单请求"）都会自动带上
 * Origin，所以"有 Origin 必须同源"这一条就足以挡掉恶意网页的 drive-by 投递；
 * 而无 Origin 的 curl / 本机脚本正是 README 里文档化的用法，不能跟着重启一起拒掉。
 *
 *   1. socket.remoteAddress 必须是 127.0.0.1 / ::1 / ::ffff:127.0.0.1 之一
 *   2. 不能有任何转发头（forwarded / x-forwarded-for / x-real-ip），
 *      否则环回 peer 实际上是代理
 *   3. Host 头必须命名一个环回权威（loopbackAuthority；挡 DNS rebinding）
 *   4. 有 Origin 时必须 === Host（同源）；没有 Origin 视为本机 CLI/脚本，放行
 *
 * @param {{ headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } }} request
 * @returns {boolean}
 */
export function trustedLocalRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return false;
  }
  const h = request.headers;
  if (h.forwarded !== undefined
    || h['x-forwarded-for'] !== undefined
    || h['x-real-ip'] !== undefined) {
    return false;
  }
  const host = h.host;
  if (typeof host !== 'string' || !loopbackAuthority(host)) return false;
  const origin = h.origin;
  if (origin === undefined || origin === null) return true;
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * 进程控制请求是否来自同源环回 Web 客户端。
 *
 * 三道关：
 *   1. socket.remoteAddress 必须是 127.0.0.1 / ::1 / ::ffff:127.0.0.1 之一
 *   2. 不能有任何转发头（forwarded / x-forwarded-for / x-real-ip），
 *      否则环回 peer 实际上是代理
 *   3. Host 头必须命名一个环回权威（loopbackAuthority）
 *   4. Origin 头必须 === Host（同源；DNS rebinding 攻击绕不过 Origin 校验，
 *      因为 Origin 也得用攻击者域名，浏览器拒绝在私有网络上 fetch 跨源）
 *
 * @param {{ headers: Record<string, string | string[] | undefined>, socket: { remoteAddress?: string } }} request
 * @returns {boolean}
 */
export function trustedRestartRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return false;
  }
  const h = request.headers;
  if (h.forwarded !== undefined
    || h['x-forwarded-for'] !== undefined
    || h['x-real-ip'] !== undefined) {
    return false;
  }
  const origin = h.origin;
  const host = h.host;
  if (!loopbackAuthority(typeof host === 'string' ? host : undefined)) return false;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === host;
  } catch {
    return false;
  }
}