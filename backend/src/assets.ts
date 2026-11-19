import { randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import type { Express } from "express";
import { Store } from "./db.js";
import { body, fail, param, user } from "./http.js";
import type { AssetRow } from "./types.js";

export function imageType(bytes: Uint8Array, mime: string): boolean {
  const buffer = Buffer.from(bytes);
  switch (mime) {
    case "image/png":
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return buffer[0] === 255 && buffer[1] === 216;
    case "image/webp":
      return (
        buffer.subarray(0, 4).toString() === "RIFF" &&
        buffer.subarray(8, 12).toString() === "WEBP"
      );
    default:
      return false;
  }
}
export function detectMime(bytes: Uint8Array): string | undefined {
  return ["image/png", "image/jpeg", "image/webp"].find((mime) =>
    imageType(bytes, mime),
  );
}
export class Assets {
  constructor(private store: Store) {}
  owned(id: unknown, owner: string): AssetRow {
    if (typeof id !== "string") throw fail(400, "参考图参数无效");
    const asset = this.store.get<AssetRow>(
      "SELECT * FROM assets WHERE id=? AND owner=?",
      id,
      owner,
    );
    if (!asset) throw fail(404, "参考图不存在");
    return asset;
  }
  measure(asset: {
    id: string;
    width?: number | null;
    height?: number | null;
    bytes?: Uint8Array;
  }): { width: number | null; height: number | null } {
    if (asset.width && asset.height)
      return { width: asset.width, height: asset.height };
    try {
      const bytes =
        asset.bytes ??
        this.store.get<{ bytes: Uint8Array }>(
          "SELECT bytes FROM assets WHERE id=?",
          asset.id,
        )?.bytes;
      if (bytes) {
        const { width, height } = imageSize(bytes);
        if (width > 0 && height > 0) {
          this.store.run(
            "UPDATE assets SET width=?,height=? WHERE id=?",
            width,
            height,
            asset.id,
          );
          return { width, height };
        }
      }
    } catch {
      /* Historical malformed images retain null dimensions. */
    }
    return { width: null, height: null };
  }
  save(owner: string, bytes: Uint8Array, mime: string): string {
    const id = randomUUID();
    this.store.run(
      "INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)",
      id,
      owner,
      mime,
      bytes,
    );
    this.measure({ id, bytes });
    return id;
  }
  mount(app: Express): void {
    app.post("/api/assets", (request, response) => {
      const { mime, data } = body(request);
      if (
        typeof mime !== "string" ||
        !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
        typeof data !== "string" ||
        !/^[A-Za-z0-9+/=]+$/.test(data)
      )
        throw fail(400, "仅支持 PNG/JPEG/WebP");
      const bytes = Buffer.from(data, "base64");
      if (
        !bytes.length ||
        bytes.length > 8 * 1024 * 1024 ||
        !imageType(bytes, mime)
      )
        throw fail(400, "图片内容无效或超过8MB");
      const owner = user(request).id;
      // A new upload must not inherit the lifetime of a job with identical output.
      const existing = this.store.get<{ id: string }>(
        `SELECT id FROM assets AS a WHERE owner=? AND mime=? AND bytes=?
         AND NOT EXISTS (SELECT 1 FROM tasks WHERE asset=a.id) LIMIT 1`,
        owner,
        mime,
        bytes,
      );
      const id = existing?.id ?? this.save(owner, bytes, mime);
      response.json({ id, url: "/api/assets/" + id });
    });
    app.get("/api/assets/:id", (request, response) => {
      const asset = this.store.get<AssetRow>(
        "SELECT * FROM assets WHERE id=?",
        param(request),
      );
      const identity = user(request);
      if (!asset || (asset.owner !== identity.id && identity.role !== "admin"))
        throw fail(404, "图片不存在");
      response
        .set("Cache-Control", "private, no-store")
        .type(asset.mime)
        .send(Buffer.from(asset.bytes));
    });
  }
}
