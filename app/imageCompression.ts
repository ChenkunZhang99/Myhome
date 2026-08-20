"use client";

/**
 * 上传前在浏览器里把图片压小。
 *
 * 手机拍的小票普遍 3–5MB，直接上传会被托管平台以 413 挡下（而且报的是平台的
 * 英文默认页，不是应用的提示）。在客户端压到 1MB 以内既绕开这个限制，
 * 也让上传和模型识别都更快。
 *
 * 小票是文字密集的图，所以优先降画质、后降分辨率——分辨率掉太多会直接影响识别率。
 */

const MAX_BYTES = 1024 * 1024;
/** 长边上限。低于 1600 左右小票上的小字就开始糊了。 */
const MAX_DIMENSION = 2000;
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45];

export type CompressionResult = {
  file: File;
  originalSize: number;
  /** 是否真的压缩了；已经够小或压不动时为 false。 */
  compressed: boolean;
};

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function jpegName(name: string) {
  return `${name.replace(/\.[^.]+$/, "") || "receipt"}.jpg`;
}

export async function compressImage(file: File, maxBytes = MAX_BYTES): Promise<CompressionResult> {
  const unchanged: CompressionResult = { file, originalSize: file.size, compressed: false };
  if (file.size <= maxBytes) return unchanged;
  // GIF 走 canvas 会丢掉动画，而且小票也不会是 GIF，直接放过。
  if (!file.type.startsWith("image/") || file.type === "image/gif") return unchanged;
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return unchanged;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return unchanged; // 解不出来就原样上传，让服务端去报错
  }

  try {
    let best: Blob | null = null;
    let dimension = MAX_DIMENSION;

    for (let attempt = 0; attempt < 3; attempt++) {
      const scale = Math.min(1, dimension / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of QUALITY_STEPS) {
        const blob = await toBlob(canvas, quality);
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= maxBytes) {
          return {
            file: new File([blob], jpegName(file.name), { type: "image/jpeg" }),
            originalSize: file.size,
            compressed: true,
          };
        }
      }
      dimension = Math.round(dimension * 0.7);
    }

    // 没能压到目标以内，也要把最小的那版交出去，总比原图强。
    if (best && best.size < file.size) {
      return {
        file: new File([best], jpegName(file.name), { type: "image/jpeg" }),
        originalSize: file.size,
        compressed: true,
      };
    }
    return unchanged;
  } finally {
    bitmap.close();
  }
}

/** 供界面显示的体积文案。 */
export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
