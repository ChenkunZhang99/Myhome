import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 每一个会调用模型的接口都必须先鉴权。
 *
 * 调模型 = 花钱。一个不鉴权的 AI 接口，等于把这台服务器变成别人的免费代理：
 * 攻击者不需要偷到密钥，循环打它就能把额度烧光。
 *
 * flyers/sync 就是这么漏的——它因为要被定时任务调用而没有会话，于是干脆
 * 谁都能调。真正的区分办法是进程内的随机令牌（_shared/internal.ts），
 * 而不是 ?scheduled=1 这种谁都能带上的查询参数。
 */

const API_DIR = new URL("../app/api/", import.meta.url);

async function routes(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await routes(url)));
    else if (entry.name === "route.ts")
      out.push({ name: url.pathname.split("/api/")[1], code: await readFile(url, "utf8") });
  }
  return out;
}

test("会调模型的接口都挡在登录之后", async () => {
  const offenders = [];
  for (const route of await routes(API_DIR)) {
    if (!/createOpenAIResponse/.test(route.code)) continue;
    const gated = /resolveHousehold\(request\)|currentAccount\(request\)/.test(route.code);
    if (!gated) offenders.push(route.name);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些接口不登录就能调用模型，别人可以拿它烧掉你的额度：\n${offenders.join("\n")}`,
  );
});

test("内部调用靠进程内随机令牌区分，不是靠查询参数", async () => {
  const internal = await readFile(new URL("../app/api/_shared/internal.ts", import.meta.url), "utf8");
  assert.match(internal, /crypto\.randomUUID\(\)/, "令牌必须是随机的");
  // 只看真正的 import，不看注释里提到的字样
  assert.doesNotMatch(
    internal,
    /^import .*cloudflare:workers/m,
    "worker 入口要能被普通 Node 加载，这里不能 import cloudflare:workers",
  );

  const sync = await readFile(new URL("../app/api/flyers/sync/route.ts", import.meta.url), "utf8");
  // 只看 POST 处理器内部的先后。createOpenAIResponse 出现在文件上方的辅助函数里，
  // 那是定义位置不是执行顺序，拿它比会误判。
  const body = sync.slice(sync.indexOf("export const POST"));
  const gate = body.indexOf("isInternalCall(request)");
  // 只认名字的后半段：前缀会变（getOpenAIConfig → getSharedOpenAIConfig），
  // 而这条断言关心的是「有没有在闸门之前去拿密钥」，不是它叫什么。
  const readsKey = body.indexOf("OpenAIConfig(");
  assert.ok(gate !== -1, "缺少内部调用判断");
  assert.ok(gate < readsKey, "闸门必须排在读取密钥、开始干活之前");
});
