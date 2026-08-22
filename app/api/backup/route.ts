import { currentAccount, resolveHousehold } from "../_shared/household";
import { failure, UserFacingError, withRoute } from "../_shared/observability";
import { ensureSchema } from "../_shared/schema";
import { exportHousehold, mergeInventory, replaceHousehold } from "../_shared/dataTransfer";
import { latestSnapshots, readSnapshot } from "../_shared/snapshots";

/**
 * 一键导出与导入。
 *
 * 导出是一个普通的 JSON 下载，导入接收同样的 JSON。中间没有专有格式、
 * 没有压缩、没有二进制——这样这份文件在没有这个应用的情况下也能被读懂，
 * 而「备份能不能被读懂」是备份唯一重要的性质。
 */

function filename() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `家里有数-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

export const GET = withRoute("backup", async (request: Request) => {
  try {
    await ensureSchema();
    const url = new URL(request.url);

    // ?list=1 列出自动备份；?snapshot=<key> 取其中一份
    if (url.searchParams.get("list")) {
      const household = await resolveHousehold(request);
      return Response.json({ snapshots: await latestSnapshots(household) });
    }
    const key = url.searchParams.get("snapshot");
    if (key) {
      const household = await resolveHousehold(request);
      const body = await readSnapshot(household, key);
      if (!body) throw new UserFacingError("这份备份已经不在了", 404);
      return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    const household = await resolveHousehold(request);
    const snapshot = await exportHousehold(household);
    return new Response(JSON.stringify(snapshot, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename())}`,
      },
    });
  } catch (error) {
    return failure("backup", error, "导出暂时不可用", 500);
  }
});

export const POST = withRoute("backup", async (request: Request) => {
  try {
    await ensureSchema();
    const household = await resolveHousehold(request);
    // 导入会覆盖或新增数据，不该让「顺手带了个 household 标识」的请求做这件事。
    if (!(await currentAccount(request))) throw new UserFacingError("请先登录后再导入", 401);

    const payload = (await request.json()) as { mode?: string; snapshot?: unknown };
    if (payload.mode === "merge")
      return Response.json({
        ok: true,
        mode: "merge",
        counts: await mergeInventory(household, payload.snapshot),
      });
    if (payload.mode === "replace")
      return Response.json({
        ok: true,
        mode: "replace",
        counts: await replaceHousehold(household, payload.snapshot),
      });
    throw new UserFacingError("请选择导入方式：合并或整份还原", 400);
  } catch (error) {
    return failure("backup", error, "导入暂时不可用", 500);
  }
});
