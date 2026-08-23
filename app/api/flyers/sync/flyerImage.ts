/**
 * 在一个 flyer 页面上找出那张 flyer。
 *
 * 很多超市（尤其是亚洲超市）不发结构化数据也不上 Flipp，整份 flyer 就是一张图：
 * H Mart 的是一张 6083×4134、17.8MB 的 JPG，页面 HTML 里连一个 $ 都没有。
 * 那种页面让模型去「搜网页」永远读不出东西——没有文字可读。
 *
 * 找图的办法故意做成通用的，不针对任何一家店：
 *   1. 取页面里所有 <img>，顺带 og:image
 *   2. 按文件名滤掉明显的站点装饰（logo、menu、banner、icon…）
 *   3. 对剩下的发 HEAD，看谁最大
 *
 * 判据是「最大的那张」，因为一份 flyer 必然远大于页面上任何一个按钮或图标。
 * 这条规则对没见过的店也成立，这正是要的效果——H Mart 只是第一个例子。
 */

/** 明显属于站点装饰的文件名。命中就不必再花一次 HEAD 去量它。 */
const CHROME =
  /logo|icon|sprite|menu|nav|button|btn|banner|header|footer|bottom|arrow|bg[-_.]|avatar|favicon/i;

/** 只认这几种。flyer 不会是 svg（那是图标），也不会是 gif。 */
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)(\?|$)/i;

/** 一份 flyer 至少这么大。低于这个数的多半是某个装饰图。 */
const MIN_BYTES = 200 * 1024;

/** 最多量这么多张。免费版每个请求的子请求数有限，不能为找图把额度花光。 */
const MAX_PROBES = 10;

export type FlyerImage = { url: string; bytes: number; contentType: string };

/** 页面里所有可能是图的地址，已解析成绝对地址并去重。 */
export function imageCandidates(html: string, pageUrl: string) {
  const found = new Set<string>();
  const add = (raw: string) => {
    try {
      const url = new URL(raw, pageUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      found.add(url.toString());
    } catch {
      // 拼不成地址的就算了，页面里什么都可能有
    }
  };

  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(match[1]);
  // 懒加载的图片真正的地址在 data-src 上，src 往往是一个占位小图
  for (const match of html.matchAll(/<img[^>]+data-src=["']([^"']+)["']/gi)) add(match[1]);
  // 社交预览图常常就是本周 flyer
  for (const match of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi))
    add(match[1]);

  return [...found].filter((url) => IMAGE_EXTENSION.test(url) && !CHROME.test(url));
}

/**
 * 量出最大的那张图。
 *
 * 用 HEAD 而不是下载：一份 flyer 十几兆，Workers 里没必要把它读进内存——
 * 后面是把地址交给模型去取，本进程从头到尾不碰那些字节。
 */
export async function findFlyerImage(pageUrl: string): Promise<FlyerImage | null> {
  let html: string;
  try {
    const response = await fetch(pageUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; HomeStockPlanner/1.0)",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  const candidates = imageCandidates(html, pageUrl).slice(0, MAX_PROBES);
  let best: FlyerImage | null = null;
  for (const url of candidates) {
    try {
      const head = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (!head.ok) continue;
      const contentType = head.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) continue;
      const bytes = Number(head.headers.get("content-length") ?? 0);
      if (!Number.isFinite(bytes) || bytes < MIN_BYTES) continue;
      if (!best || bytes > best.bytes) best = { url, bytes, contentType };
    } catch {
      // 某一张量不到不影响其余的
    }
  }
  return best;
}
