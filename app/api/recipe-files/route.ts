import { env } from "cloudflare:workers";
import { failure, withRoute } from "../_shared/observability";
import { ensureSchema } from "../_shared/schema";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES_PER_RECIPE = 2;

export const GET = withRoute("recipe.files", async (request: Request) => {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const fileId = url.searchParams.get("fileId")?.trim();
    if (fileId) {
      const attachment = await env.DB.prepare(
        "SELECT object_key AS objectKey, content_type AS contentType, file_name AS fileName FROM recipe_attachments WHERE id = ?",
      )
        .bind(fileId)
        .first<{ objectKey: string; contentType: string; fileName: string }>();
      if (!attachment) return Response.json({ error: "菜谱照片不存在" }, { status: 404 });
      const object = await env.UPLOADS.get(attachment.objectKey);
      if (!object) return Response.json({ error: "菜谱照片文件不存在" }, { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": attachment.contentType,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
          "Cache-Control": "private, max-age=3600",
          ETag: object.httpEtag,
        },
      });
    }

    const recipeId = url.searchParams.get("recipeId")?.trim();
    if (!recipeId) return Response.json({ error: "缺少菜谱编号" }, { status: 400 });
    const attachments = await env.DB.prepare(
      `SELECT id, recipe_id AS recipeId, file_name AS fileName,
      content_type AS contentType, size, created_at AS createdAt FROM recipe_attachments
      WHERE recipe_id = ? ORDER BY created_at ASC`,
    )
      .bind(recipeId)
      .all();
    return Response.json({ attachments: attachments.results });
  } catch (error) {
    return failure("recipe.files", error, "暂时无法读取菜谱照片", 500);
  }
});

export const POST = withRoute("recipe.files", async (request: Request) => {
  try {
    await ensureSchema();
    const form = await request.formData();
    const recipeId = String(form.get("recipeId") ?? "").trim();
    const files = form
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (!recipeId || files.length === 0)
      return Response.json({ error: "请选择要上传的菜谱照片" }, { status: 400 });
    const recipe = await env.DB.prepare("SELECT id, is_custom AS isCustom FROM recipe_catalog WHERE id = ?")
      .bind(recipeId)
      .first<{ id: string; isCustom: number }>();
    if (!recipe) return Response.json({ error: "菜谱不存在" }, { status: 404 });
    if (!recipe.isCustom)
      return Response.json({ error: "目前仅支持为家庭自建菜谱上传照片" }, { status: 400 });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM recipe_attachments WHERE recipe_id = ?")
      .bind(recipeId)
      .first<{ count: number }>();
    if (Number(count?.count ?? 0) + files.length > MAX_FILES_PER_RECIPE)
      return Response.json({ error: `每道菜谱最多保存 ${MAX_FILES_PER_RECIPE} 张照片` }, { status: 400 });

    const uploaded = [];
    for (const file of files) {
      if (!file.type.startsWith("image/"))
        return Response.json({ error: "目前仅支持图片文件" }, { status: 400 });
      if (file.size > MAX_FILE_SIZE) return Response.json({ error: "单张照片不能超过 5MB" }, { status: 400 });
      const id = crypto.randomUUID();
      const extension = file.name.includes(".")
        ? file.name
            .slice(file.name.lastIndexOf("."))
            .toLowerCase()
            .replace(/[^a-z0-9.]/g, "")
            .slice(0, 10)
        : "";
      const objectKey = `recipes/${recipeId}/${id}${extension}`;
      await env.UPLOADS.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } });
      try {
        await env.DB.prepare(
          `INSERT INTO recipe_attachments
          (id, recipe_id, object_key, file_name, content_type, size) VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, recipeId, objectKey, file.name.slice(0, 180), file.type, file.size)
          .run();
      } catch (error) {
        await env.UPLOADS.delete(objectKey);
        throw error;
      }
      uploaded.push({ id, recipeId, fileName: file.name, contentType: file.type, size: file.size });
    }
    return Response.json({ attachments: uploaded }, { status: 201 });
  } catch (error) {
    return failure("recipe.files", error, "菜谱照片上传失败", 500);
  }
});

export const DELETE = withRoute("recipe.files", async (request: Request) => {
  try {
    await ensureSchema();
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "缺少照片编号" }, { status: 400 });
    const attachment = await env.DB.prepare(
      "SELECT object_key AS objectKey FROM recipe_attachments WHERE id = ?",
    )
      .bind(id)
      .first<{ objectKey: string }>();
    if (!attachment) return Response.json({ error: "菜谱照片不存在" }, { status: 404 });
    await env.UPLOADS.delete(attachment.objectKey);
    await env.DB.prepare("DELETE FROM recipe_attachments WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return failure("recipe.files", error, "菜谱照片删除失败", 500);
  }
});
