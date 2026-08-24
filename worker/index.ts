/** Cloudflare Worker entry point. */
import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { INTERNAL_HEADER, internalToken } from "../app/api/_shared/internal";
import { withSecurityHeaders } from "./securityHeaders";

/** Cloudflare Images is optional; without it images are served unmodified. */
type ImagesBinding = {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
};

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES?: ImagesBinding;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const images = env.IMAGES;
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(
        request,
        {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          // Without the Images binding, hand the original bytes back untouched
          // so the app still works on a free Cloudflare account.
          transformImage: async (body, { width, format, quality }) => {
            if (!images) return new Response(body);
            const result = await images
              .input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
      return withSecurityHeaders(response, request);
    }

    return withSecurityHeaders(await handler.fetch(request, env, ctx), request);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const request = new Request("https://household.internal/api/flyers/sync?scheduled=1", {
      method: "POST",
      headers: { [INTERNAL_HEADER]: internalToken() },
    });
    ctx.waitUntil(
      handler.fetch(request, env, ctx).then(async (response) => {
        if (!response.ok) throw new Error(`Flyer background sync failed: ${response.status}`);
        await response.arrayBuffer();
      }),
    );
    // 备份直接在这里做，不像上面那样绕一个内部请求：它只是一次函数调用，
    // 而且走 HTTP 就意味着有一个谁都能打的 /api/... 端点，那是白送的攻击面。
    ctx.waitUntil(backupEveryHousehold());
  },
};

/**
 * 每个有数据的家存一份快照。
 *
 * 一家出错不该连累其余的——所以逐个 catch，把失败记下来继续走。
 * 备份任务最糟糕的失败方式是「有一家挂了，于是所有人都没有备份」。
 */
async function backupEveryHousehold() {
  // 动态导入是必须的，不是风格选择：这两个模块引用 cloudflare:workers，
  // 而这个文件要能被普通 Node 加载——tests/rendered-html.test.mjs 会 import
  // 打包产物来做服务端渲染断言。写成顶层 import 会让整个 bundle 在 Node 里加载失败。
  const [{ householdsWithData, writeSnapshot }, { ensureSchema }] = await Promise.all([
    import("../app/api/_shared/snapshots"),
    import("../app/api/_shared/schema"),
  ]);
  await ensureSchema();
  for (const householdId of await householdsWithData()) {
    try {
      const result = await writeSnapshot(householdId);
      if (!result.skipped)
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            scope: "backup",
            key: result.key,
            rows: result.rows,
          }),
        );
    } catch (error) {
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          scope: "backup",
          householdId,
          failed: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}

export default worker;
