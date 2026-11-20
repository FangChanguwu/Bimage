import sharp from "sharp";
import { Store } from "./db.js";
import { fail } from "./http.js";

async function renderThumbnail(source: Buffer): Promise<Buffer> {
  return sharp(source, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(480, 480, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
}

/** Derived bytes only; the source row and its owner remain authoritative. */
export class Thumbnails {
  private inflight = new Map<string, Promise<Buffer>>();
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private store: Store,
    private render: (source: Buffer) => Promise<Buffer> = renderThumbnail,
  ) {}

  get(id: string): Promise<Buffer> {
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const result = this.generate(id);
    this.inflight.set(id, result);
    // Both branches resolve; never leave a rejected .finally() child unobserved.
    void result.then(
      () => this.inflight.delete(id),
      () => this.inflight.delete(id),
    );
    return result;
  }

  // createApp closes SQLite after workers stop; pending native decodes may finish
  // later. Never query a closed handle, and let every queued promise settle.
  private assertOpen(): void {
    if (!this.store.db.isOpen) throw fail(503, "服务正在关闭");
  }

  private async generate(id: string): Promise<Buffer> {
    this.assertOpen();
    const cached = this.store.get<{ bytes: Uint8Array }>(
      "SELECT t.bytes FROM asset_thumbnails t JOIN assets a ON a.id=t.asset WHERE a.id=?",
      id,
    );
    if (cached) return Buffer.from(cached.bytes);
    if (this.active >= 2)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      this.assertOpen();
      const source = this.store.get<{ bytes: Uint8Array }>(
        "SELECT bytes FROM assets WHERE id=?",
        id,
      );
      if (!source) throw fail(404, "图片不存在");
      let bytes: Buffer;
      try {
        bytes = await this.render(Buffer.from(source.bytes));
      } catch {
        // Do not expose native decoder errors or damage historical originals.
        throw fail(422, "无法生成缩略图，请使用原图");
      }
      this.assertOpen();
      if (!this.store.get("SELECT id FROM assets WHERE id=?", id))
        throw fail(404, "图片不存在");
      this.store.run(
        "INSERT OR IGNORE INTO asset_thumbnails(asset,bytes) SELECT id,? FROM assets WHERE id=?",
        bytes,
        id,
      );
      return bytes;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
