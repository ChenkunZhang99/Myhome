/**
 * 区分「定时任务发起的内部请求」和「外面打进来的请求」。
 *
 * 定时同步走的是 worker 入口里的 handler.fetch(...)，一个进程内构造的请求，
 * 没有会话 cookie。而同一个路由也要能被登录用户手动触发。于是需要一个
 * 外部伪造不出来的标记。
 *
 * 令牌随机生成，从不离开进程——没有任何途径能读到它，所以猜不中。
 * 用 ?scheduled=1 之类的查询参数做判断是不行的，那是谁都能带上的。
 *
 * **为什么是惰性生成而不是模块顶层的常量**：Workers 不允许在全局作用域里
 * 生成随机值（也不允许异步 I/O 和定时器），写成 `const T = crypto.randomUUID()`
 * 会让整个部署被拒绝，报 10021。所以推迟到第一次真正用到的时候，
 * 那时已经在 handler 里了。同一个 isolate 内取到的是同一个值。
 *
 * 这个模块刻意不 import cloudflare:workers：worker 入口要能被普通 Node 加载，
 * 见 tests/rendered-html.test.mjs。
 */

export const INTERNAL_HEADER = "x-hsp-internal";

let token = "";

export function internalToken() {
  if (!token) token = crypto.randomUUID();
  return token;
}

export function isInternalCall(request: Request) {
  return request.headers.get(INTERNAL_HEADER) === internalToken();
}
