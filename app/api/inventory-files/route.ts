import { env } from "cloudflare:workers";
import { ensureSchema } from "../_shared/schema";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES_PER_ITEM = 8;

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const fileId = url.searchParams.get("fileId")?.trim();
    if (fileId) {
      const attachment = await env.DB.prepare(
        "SELECT object_key AS objectKey, content_type AS contentType, file_name AS fileName FROM inventory_attachments WHERE id = ?",
      )
        .bind(fileId)
        .first<{ objectKey: string; contentType: string; fileName: string }>();
      if (!attachment) return Response.json({ error: "图片不存在" }, { status: 404 });
      const object = await env.UPLOADS.get(attachment.objectKey);
      if (!object) return Response.json({ error: "图片文件不存在" }, { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": attachment.contentType,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
          "Cache-Control": "private, max-age=3600",
          ETag: object.httpEtag,
        },
      });
    }

    const itemId = url.searchParams.get("itemId")?.trim();
    if (!itemId) return Response.json({ error: "缺少物品编号" }, { status: 400 });
    const attachments = await env.DB.prepare(
      `SELECT id, item_id AS itemId, file_name AS fileName,
      content_type AS contentType, size, created_at AS createdAt
      FROM inventory_attachments WHERE item_id = ? ORDER BY created_at DESC`,
    )
      .bind(itemId)
      .all();
    return Response.json({ attachments: attachments.results });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "暂时无法读取图片" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const form = await request.formData();
    const itemId = String(form.get("itemId") ?? "").trim();
    const files = form
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (!itemId || files.length === 0) return Response.json({ error: "请选择要上传的图片" }, { status: 400 });
    const item = await env.DB.prepare("SELECT id FROM inventory_items WHERE id = ?").bind(itemId).first();
    if (!item) return Response.json({ error: "物品不存在" }, { status: 404 });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM inventory_attachments WHERE item_id = ?",
    )
      .bind(itemId)
      .first<{ count: number }>();
    if (Number(count?.count ?? 0) + files.length > MAX_FILES_PER_ITEM)
      return Response.json({ error: `每件物品最多保存 ${MAX_FILES_PER_ITEM} 张图片` }, { status: 400 });

    const uploaded: {
      id: string;
      itemId: string;
      fileName: string;
      contentType: string;
      size: number;
      createdAt: string;
    }[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/"))
        return Response.json({ error: "目前仅支持图片文件" }, { status: 400 });
      if (file.size > MAX_FILE_SIZE) return Response.json({ error: "单张图片不能超过 5MB" }, { status: 400 });
      const id = crypto.randomUUID();
      const extension = file.name.includes(".")
        ? file.name
            .slice(file.name.lastIndexOf("."))
            .toLowerCase()
            .replace(/[^a-z0-9.]/g, "")
            .slice(0, 10)
        : "";
      const objectKey = `inventory/${itemId}/${id}${extension}`;
      await env.UPLOADS.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } });
      try {
        await env.DB.prepare(
          `INSERT INTO inventory_attachments
          (id, item_id, object_key, file_name, content_type, size) VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, itemId, objectKey, file.name.slice(0, 180), file.type, file.size)
          .run();
      } catch (error) {
        await env.UPLOADS.delete(objectKey);
        throw error;
      }
      uploaded.push({
        id,
        itemId,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
        createdAt: new Date().toISOString(),
      });
    }
    return Response.json({ attachments: uploaded }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "图片上传失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "缺少图片编号" }, { status: 400 });
    const attachment = await env.DB.prepare(
      "SELECT object_key AS objectKey FROM inventory_attachments WHERE id = ?",
    )
      .bind(id)
      .first<{ objectKey: string }>();
    if (!attachment) return Response.json({ error: "图片不存在" }, { status: 404 });
    await env.UPLOADS.delete(attachment.objectKey);
    await env.DB.prepare("DELETE FROM inventory_attachments WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "图片删除失败" }, { status: 500 });
  }
}
