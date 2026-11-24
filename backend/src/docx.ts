import { unzipSync } from "fflate";
import sharp from "sharp";
import { detectMime } from "./assets.js";
import { fail, HttpError } from "./http.js";

export const MAX_DOCX_BYTES = 20 * 1024 * 1024;
export const MAX_DOCX_IMAGES = 24;
export const MAX_DOCX_TEXT_CHARS = 60000;
export const MAX_AGENT_DOCUMENTS = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}
const localName = (name: string): string => name.slice(name.indexOf(":") + 1);
const invalid = () => fail(400, "无效的 Word (.docx) 文档");
const abnormal = () => fail(400, "文档体积或内部结构异常");

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value) : "�";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

// A deliberately small, non-expanding XML tree parser: no DTDs or external entities.
function parseXml(bytes: Uint8Array): XmlNode {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  const root: XmlNode = { name: "", attrs: {}, children: [] };
  const stack = [root];
  let cursor = 0;
  let nodes = 0;
  const tagPattern = /<\s*(\/?)\s*([\w:.-]+)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y;
  while (cursor < text.length) {
    if (text[cursor] !== "<") {
      const next = text.indexOf("<", cursor);
      const end = next < 0 ? text.length : next;
      stack[stack.length - 1].children.push(decodeEntities(text.slice(cursor, end)));
      cursor = end;
      continue;
    }
    const special = text.startsWith("<!--", cursor) ? ["-->", 4]
      : text.startsWith("<?", cursor) ? ["?>", 2]
      : text.startsWith("<![CDATA[", cursor) ? ["]]>", 9] : null;
    if (special) {
      const end = text.indexOf(special[0] as string, cursor + (special[1] as number));
      if (end < 0) throw invalid();
      if (special[1] === 9) stack[stack.length - 1].children.push(text.slice(cursor + 9, end));
      cursor = end + (special[0] as string).length;
      continue;
    }
    if (text.startsWith("<!", cursor)) throw invalid();
    tagPattern.lastIndex = cursor;
    const token = tagPattern.exec(text);
    if (!token) throw invalid();
    cursor = tagPattern.lastIndex;
    if (token[1]) {
      if (stack.length === 1 || stack.pop()!.name !== token[2] || token[3].trim()) throw invalid();
      continue;
    }
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    const selfClosing = /\/\s*$/.test(token[3]);
    let rest = token[3].replace(/\/\s*$/, "");
    while (rest.trim()) {
      const attr = /^\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr) throw invalid();
      attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3]);
      rest = rest.slice(attr[0].length);
    }
    const node: XmlNode = { name: token[2], attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (++nodes > 500000 || stack.length > 128) throw abnormal();
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root.children.filter((node) => typeof node !== "string").length !== 1) throw invalid();
  return root;
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (localName(child.name) === name) found.push(child);
    else found.push(...descendants(child, name));
  }
  return found;
}
function attribute(node: XmlNode, name: string): string {
  return Object.entries(node.attrs).find(([key]) => localName(key) === name)?.[1] ?? "";
}
function archivePath(target: string, base = ""): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(target).replace(/\\/g, "/"); } catch { return null; }
  if (/[\0?#]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  const parts = decoded.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}

export async function parseDocxDocument(
  buffer: Uint8Array,
  saveImage: (bytes: Uint8Array, mime: string) => Promise<string> | string,
) {
  if (buffer.length > MAX_DOCX_BYTES) throw fail(400, "文档大小不能超过 20MB");
  if (buffer[0] !== 80 || buffer[1] !== 75 || !((buffer[2] === 3 && buffer[3] === 4) || (buffer[2] === 5 && buffer[3] === 6))) throw invalid();
  let files: Record<string, Uint8Array>;
  try {
    let count = 0;
    let size = 0;
    files = unzipSync(buffer, { filter: (entry) => {
      size += entry.originalSize;
      if (++count > 500 || size > MAX_UNZIPPED_BYTES) throw abnormal();
      return true;
    } });
    if (Object.values(files).reduce((total, bytes) => total + bytes.length, 0) > MAX_UNZIPPED_BYTES) throw abnormal();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid();
  }
  const keys = new Map<string, string>();
  for (const key of Object.keys(files)) {
    const normalized = archivePath(key);
    if (!normalized || normalized !== key.replace(/\/$/, "") || keys.has(normalized.toLowerCase())) throw abnormal();
    keys.set(normalized.toLowerCase(), key);
  }
  const lookup = (name: string): Uint8Array | undefined => {
    const key = keys.get(name.toLowerCase());
    return key === undefined ? undefined : files[key];
  };
  if (!lookup("word/document.xml")) throw invalid();
  const images: string[] = [];
  const extracted = new Map<string, string>();
  let skippedImages = 0;

  async function image(mediaPath: string, label: string): Promise<string> {
    const normalized = mediaPath.toLowerCase();
    const previous = extracted.get(normalized);
    if (previous !== undefined) return previous;
    const filename = mediaPath.split("/").pop() ?? mediaPath;
    let marker: string;
    if (images.length >= MAX_DOCX_IMAGES) {
      skippedImages++;
      marker = `[文档图片已达上限，已跳过: ${filename}]`;
    } else {
      const raw = lookup(mediaPath);
      if (!raw) return "";
      let bytes: Uint8Array = raw;
      let mime = detectMime(raw);
      try {
        if (!mime || raw.length > MAX_IMAGE_BYTES) {
          const pipeline = sharp(raw).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
          let converted = await pipeline.png().toBuffer();
          mime = "image/png";
          if (converted.length > MAX_IMAGE_BYTES) {
            converted = await sharp(converted).webp({ quality: 88 }).toBuffer();
            mime = "image/webp";
          }
          bytes = converted;
        }
      } catch {
        skippedImages++;
        marker = `[无法解析的嵌入图片: ${filename}]`;
        extracted.set(normalized, marker);
        return marker;
      }
      const assetId = await saveImage(bytes, mime!);
      images.push(assetId);
      marker = `[文档图片 #${images.length} | assetId: ${assetId}${label ? ` | ${label.replace(/[\r\n|\]]/g, " ").trim()}` : ""}]`;
    }
    extracted.set(normalized, marker);
    return marker;
  }

  async function renderPart(part: string): Promise<string> {
    const bytes = lookup(part);
    if (!bytes) return "";
    const root = parseXml(bytes);
    const slash = part.lastIndexOf("/");
    const base = part.slice(0, slash);
    const relBytes = lookup(`${base}/_rels/${part.slice(slash + 1)}.rels`);
    const relationships = new Map<string, string>();
    if (relBytes) {
      for (const rel of descendants(parseXml(relBytes), "Relationship")) {
        if (attribute(rel, "TargetMode").toLowerCase() === "external") continue;
        const target = archivePath(attribute(rel, "Target"), base);
        if (target) relationships.set(attribute(rel, "Id"), target);
      }
    }
    async function render(node: XmlNode, label = ""): Promise<string> {
      const name = localName(node.name);
      if (name === "AlternateContent") {
        const alternatives = node.children.filter((child): child is XmlNode => typeof child !== "string");
        const selected = alternatives.find((child) => localName(child.name) === "Choice")
          ?? alternatives.find((child) => localName(child.name) === "Fallback");
        return selected ? renderChildren(selected, label) : "";
      }
      if (["pPr", "rPr", "tblPr", "tcPr", "trPr", "sectPr"].includes(name)) return "";
      if (name === "t") return node.children.filter((child) => typeof child === "string").join("");
      if (name === "tab") return "\t";
      if (name === "br" || name === "cr") return "\n";
      if (name === "noBreakHyphen") return "-";
      if (name === "drawing" || name === "pict") {
        const properties = [...descendants(node, "docPr"), ...descendants(node, "cNvPr")];
        label = properties.map((entry) => attribute(entry, "descr") || attribute(entry, "name")).find(Boolean) || label;
      }
      if (name === "blip" || name === "imagedata") {
        const id = node.attrs["r:embed"] || node.attrs["r:link"] || node.attrs["r:id"] || node.attrs["o:relid"];
        const target = relationships.get(id);
        return target ? image(target, label) : "";
      }
      if (name === "tbl") {
        const rows: string[][] = [];
        for (const row of descendants(node, "tr")) {
          const cells: string[] = [];
          for (const cell of descendants(row, "tc")) {
            cells.push((await renderChildren(cell, label)).trim().replace(/\|/g, "\\|").replace(/\n+/g, "<br>"));
          }
          rows.push(cells);
        }
        const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
        const lines = rows.map((row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`);
        if (rows.length >= 2) lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
        return `\n\n${lines.join("\n")}\n\n`;
      }
      const content = await renderChildren(node, label);
      if (name === "p") {
        const props = node.children.find((child): child is XmlNode => typeof child !== "string" && localName(child.name) === "pPr");
        const style = props ? attribute(descendants(props, "pStyle")[0] ?? { name: "", attrs: {}, children: [] }, "val") : "";
        const heading = /^(?:Heading\s*|标题\s*)([1-6])$/i.exec(style);
        const level = heading ? Math.min(3, Number(heading[1])) : /^Title$/i.test(style) ? 1 : /^Subtitle$/i.test(style) ? 2 : 0;
        const prefix = level ? `${"#".repeat(level)} ` : props && descendants(props, "numPr").length ? "- " : "";
        return content.trim() ? `\n${prefix}${content.trim()}\n` : "\n";
      }
      if (name === "txbxContent") return `\n${content.trim()}\n`;
      return content;
    }
    async function renderChildren(node: XmlNode, label: string): Promise<string> {
      const parts: string[] = [];
      for (const child of node.children) {
        if (typeof child !== "string") parts.push(await render(child, label));
      }
      return parts.join("");
    }
    return render(root);
  }

  const sections: string[] = [];
  try {
    sections.push(await renderPart("word/document.xml"));
    for (const key of Object.keys(files)) {
      if (/^word\/(?:header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(key)) {
        const text = (await renderPart(key)).trim();
        if (text) sections.push(text);
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid();
  }
  const otherImages: string[] = [];
  for (const key of Object.keys(files)) {
    if (/^word\/media\/[^/]+$/i.test(key) && !extracted.has(key.toLowerCase())) {
      const marker = await image(key, "");
      if (marker) otherImages.push(marker);
    }
  }
  if (otherImages.length) sections.push(`[其他嵌入图片]\n${otherImages.join("\n")}`);
  let text = sections.join("\n\n").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const readableText = text.replace(/\[(?:无法解析的嵌入图片|文档图片已达上限，已跳过):[^\]]*\]|\[其他嵌入图片\]/g, "").trim();
  if (!readableText && images.length === 0) throw fail(400, "文档中没有可读取的文字或图片内容");
  const charCount = text.length;
  const truncated = charCount > MAX_DOCX_TEXT_CHARS;
  if (truncated) {
    const notice = "\n[文档文字过长，后续内容已截断]";
    text = text.slice(0, MAX_DOCX_TEXT_CHARS - notice.length) + notice;
  }
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 180);
  return { text, charCount, images, skippedImages, truncated, excerpt };
}
