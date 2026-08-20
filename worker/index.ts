/** Cloudflare Worker entry point. */
import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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
      return handleImageOptimization(
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
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const request = new Request("https://household.internal/api/flyers/sync?scheduled=1", { method: "POST" });
    ctx.waitUntil(
      handler.fetch(request, env, ctx).then(async (response) => {
        if (!response.ok) throw new Error(`Flyer background sync failed: ${response.status}`);
        await response.arrayBuffer();
      }),
    );
  },
};

export default worker;
