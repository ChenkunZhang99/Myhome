# 002 · Worker 安全响应头

- 状态：完成，待独立复核
- 日期：2026-08-24
- 目标：让页面、API 和图片优化响应都具备浏览器安全策略，并用真实 HTTP 证明这些响应头确实存在。

## 1. 范围

本步骤完成：

- Content Security Policy（CSP）。
- HSTS、禁止 MIME 嗅探、禁止 iframe 嵌入。
- Referrer Policy、Permissions Policy 和 Cross-Origin-Opener-Policy。
- 开发与生产 CSP 分离：Vite HMR 需要的 `unsafe-eval`、`http:` 和 `ws:` 只对 localhost 生效。
- 页面与 API 的真实 HTTP 断言，以及生产/开发策略的纯函数测试。

本步骤不包含：

- 消除 `script-src 'unsafe-inline'`。vinext 当前使用内联 hydration 脚本；要移除它需要引入请求级 nonce，并验证框架完整渲染链。
- 通用限流、会话设备管理、错误监控和账号安全中项目所有者明确暂缓的部分。

## 2. 设计选择

最初尝试在 `next.config.ts` 使用标准 `headers()` 配置。真实 HTTP 测试证明 vinext 的本地 Worker 响应没有带上这些头：`X-Frame-Options` 实际为 `null`。因此没有保留一份“看起来正确但运行时无效”的配置。

最终实现在 `worker/securityHeaders.ts`，由 `worker/index.ts` 的统一响应出口调用：

- 普通页面和所有 API 经过 `handler.fetch()` 后统一包装。
- `/_vinext/image` 图片优化响应也经过相同包装。
- 复制 Response 后再写头，避免 Cloudflare binding 返回的 immutable Headers 抛错。
- 原状态、正文、Cookie 等响应信息保留；测试明确验证了 `Set-Cookie` 不丢失。

## 3. 策略内容

生产 CSP 包括：

- 默认只允许同源。
- 图片允许同源、`data:`、`blob:` 和 HTTPS，兼容用户照片与 Flyer 图片。
- 禁止插件对象，限制 base URL 和表单提交来源。
- `frame-ancestors 'none'` 与 `X-Frame-Options: DENY` 双重阻止点击劫持。
- `upgrade-insecure-requests` 只在非 localhost 响应中启用。
- 生产环境不允许 `unsafe-eval`，也不开放 WebSocket 连接。

其余响应头：

```text
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
```

没有给 HSTS 加 `includeSubDomains` 或 `preload`，因为该 Worker 可能运行在共享或变化中的主机名上，不应替未审计的子域做永久承诺。

## 4. 验证证据

可复制命令：

```bash
pnpm run test:integration
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

2026-08-24 本机结果：

- HTTP 集成测试：1/1 通过；真实 `/` 和 `/api/inventory` 响应均检查到安全头。
- 原有测试与新增策略测试：220/220 通过。
- vinext 生产构建：通过。
- 类型检查：通过。
- ESLint：0 error；保留 10 个原有 warning。
- Prettier：通过。

新增策略测试证明：

1. 生产 CSP 有 `frame-ancestors 'none'`、`object-src 'none'`、`upgrade-insecure-requests`。
2. 生产 CSP 没有 `unsafe-eval` 和 WebSocket 来源。
3. localhost 为 Vite HMR 放行 `unsafe-eval` 与 `ws:`，但不启用 HTTPS 升级。
4. 安全包装保留状态码、正文和 `Set-Cookie`，并覆盖较弱的旧响应头。

## 5. 安全边界

- 没有连接生产服务或修改生产数据。
- 没有读取或输出 OpenAI 密钥。
- CSP 仍含 `unsafe-inline`，因此它是降低 XSS 影响面的防线，不是输入转义的替代品。
- Permissions Policy 禁用的是网页直接调用摄像头、麦克风和定位 API；普通文件选择器的移动端拍照入口不依赖 `getUserMedia`。

## 6. 已知不足

- 尚未在真实 Cloudflare URL 上用浏览器 DevTools 检查 CSP 控制台；当前证据来自生产构建、纯测试和本地 Worker HTTP。
- CSP 没有 report endpoint，因此策略违规不会自动上报。
- `unsafe-inline` 仍允许内联脚本执行；后续若框架支持可靠 nonce，应单独收紧并做完整 UI 回归。
- 统一 Response 克隆不适用于 WebSocket upgrade 响应；当前产品没有 WebSocket API，开发 HMR 由 Vite 处理。未来新增实时功能时必须复核。

## 7. 给下一位审计者的检查清单

1. 对线上页面执行 `curl -I`，确认 Cloudflare 没有覆盖这些头。
2. 用浏览器走登录、上传照片、小票识别、Flyer 和菜谱图片，检查 CSP 是否误拦资源。
3. 尝试从外站 iframe 嵌入页面，确认浏览器拒绝。
4. 搜索新增的第三方域名；任何新字体、图片或连接来源都需要显式评估，而不是直接把 CSP 放宽成 `*`。
5. 若改用 nonce，确认 React hydration、RSC 流、错误页和 API 响应都仍然工作。
