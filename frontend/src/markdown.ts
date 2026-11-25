function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(escapedUrl: string): string | null {
  const trimmed = escapedUrl.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

function renderEmphasis(text: string): string {
  return text
    .replace(/\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![\w\u4e00-\u9fff])__([^\s_](?:[\s\S]*?[^\s_])?)__(?![\w\u4e00-\u9fff])/g, "<strong>$1</strong>")
    .replace(/~~([^\s~](?:[\s\S]*?[^\s~])?)~~/g, "<del>$1</del>")
    .replace(/(?<!\*)\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<![\w\u4e00-\u9fff])_([^\s_](?:[^_]*?[^\s_])?)_(?![\w\u4e00-\u9fff])/g, "<em>$1</em>");
}

function renderInline(raw: string): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    const id = tokens.length;
    tokens.push(html);
    return `\u0000T${id}\u0000`;
  };

  // 1. Protect inline code spans first so inner markdown/HTML is never parsed.
  let text = raw.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks: string, body: string) => {
    const cleaned =
      body.length >= 2 && body.startsWith(" ") && body.endsWith(" ") && /[^ ]/.test(body)
        ? body.slice(1, -1)
        : body;
    return stash(`<code>${escapeHtml(cleaned)}</code>`);
  });

  // 2. Protect backslash-escaped ASCII punctuation.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, (_m, ch: string) => stash(escapeHtml(ch)));

  // 3. Escape all remaining raw HTML.
  text = escapeHtml(text);

  // 4. Markdown images & links: ![alt](url) / [label](url "optional title")
  text = text.replace(
    /(!?)\[([^\]]*)\]\(\s*(?:&lt;((?:(?!&gt;|\s).)+)&gt;|([^\s)]+(?:\([^\s)]*\)[^\s)]*)*))(?:\s+(?:&quot;(?:(?!&quot;).)*&quot;|&#39;(?:(?!&#39;).)*&#39;))?\s*\)/g,
    (match, bang: string, label: string, angleUrl?: string, plainUrl?: string) => {
      const href = safeHref(angleUrl || plainUrl || "");
      if (!href) return match;
      const inner = label ? renderEmphasis(label) : href;
      if (bang) {
        return stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`);
      }
      if (!label) return match;
      return stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`);
    },
  );

  // 5. Angle-bracket autolinks: <https://...>
  text = text.replace(/&lt;(https?:\/\/(?:(?!&gt;|\s).)+)&gt;/g, (match, url: string) => {
    const href = safeHref(url);
    if (!href) return match;
    return stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`);
  });

  // 6. Bare http(s) URLs.
  text = text.replace(/(^|[\s(（[【:：])(https?:\/\/[^\s<>()）\]】]+)/g, (match, prefix: string, url: string) => {
    const stripped = url.replace(/[.,;!?。，；！？]+$/, "");
    const trailing = url.slice(stripped.length);
    const href = safeHref(stripped);
    if (!href) return match;
    return `${prefix}${stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`)}${trailing}`;
  });

  // 7. Inline emphasis.
  text = renderEmphasis(text);

  // 8. Restore stashed tokens (loop handles nested tokens like inline code inside links).
  let prev = "";
  while (text !== prev && text.includes("\u0000T")) {
    prev = text;
    text = text.replace(/\u0000T(\d+)\u0000/g, (_m, idx: string) => tokens[Number(idx)] ?? "");
  }

  return text;
}

const HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const HR_RE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+\.\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  return lines[idx].includes("|") && TABLE_SEP_RE.test(lines[idx + 1]);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isBlockStart(lines: string[], idx: number): boolean {
  const line = lines[idx];
  return (
    !line.trim() ||
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, idx)
  );
}

function parseList(lines: string[], startIdx: number): { html: string; nextIdx: number } {
  const firstUl = UL_RE.exec(lines[startIdx]);
  const firstOl = OL_RE.exec(lines[startIdx]);
  const ordered = !firstUl && Boolean(firstOl);
  const baseIndent = (firstUl?.[1] ?? firstOl?.[1] ?? "").length;
  const itemRe = ordered ? OL_RE : UL_RE;
  const tag = ordered ? "ol" : "ul";

  const items: string[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const match = itemRe.exec(lines[i]);
    if (!match || match[1].length !== baseIndent) break;

    const itemLines: string[] = [match[2]];
    i += 1;

    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        // Consume blank line only if followed by a more-indented continuation.
        if (i + 1 < lines.length) {
          const afterBlank = lines[i + 1];
          const afterIndent = afterBlank.match(/^(\s*)/)?.[1].length ?? 0;
          if (afterBlank.trim() && afterIndent > baseIndent) {
            itemLines.push("");
            i += 1;
            continue;
          }
        }
        break;
      }

      const nextIndent = next.match(/^(\s*)/)?.[1].length ?? 0;
      const nextUl = UL_RE.exec(next);
      const nextOl = OL_RE.exec(next);

      if ((nextUl || nextOl) && nextIndent <= baseIndent) break;
      if (nextIndent > baseIndent) {
        itemLines.push(next.slice(Math.min(nextIndent, baseIndent + 2)));
        i += 1;
        continue;
      }
      if (isBlockStart(lines, i)) break;

      itemLines.push(next.trim());
      i += 1;
    }

    // Separate leading inline lines from any nested block content (nested lists, code, etc.).
    const nestedStart = itemLines.findIndex(
      (line, idx) => idx > 0 && (UL_RE.test(line) || OL_RE.test(line) || FENCE_RE.test(line) || BLOCKQUOTE_RE.test(line) || !line.trim()),
    );

    let itemHtml: string;
    if (nestedStart === -1) {
      const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(itemLines.join("\n"));
      if (task) {
        const checked = task[1].toLowerCase() === "x" ? " checked" : "";
        itemHtml = `<input type="checkbox" disabled${checked} /> ${task[2].split("\n").map(renderInline).join("<br />")}`;
      } else {
        itemHtml = itemLines.map(renderInline).join("<br />");
      }
    } else {
      const lead = itemLines.slice(0, nestedStart).map(renderInline).join("<br />");
      const rest = renderBlocks(itemLines.slice(nestedStart));
      itemHtml = `${lead}${rest}`;
    }

    items.push(`<li>${itemHtml}</li>`);
  }

  return { html: `<${tag}>${items.join("")}</${tag}>`, nextIdx: i };
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const fenceChar = marker[0];
      const closeRe = new RegExp(`^\\s*${fenceChar === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // Blockquote.
    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qm = BLOCKQUOTE_RE.exec(lines[i]);
        if (!qm) break;
        quoteLines.push(qm[1]);
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoteLines)}</blockquote>`);
      continue;
    }

    // GFM table.
    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const aligns = splitTableRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
      });
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        bodyRows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const ths = headers
        .map((cell, idx) => {
          const align = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
          return `<th${align}>${renderInline(cell)}</th>`;
        })
        .join("");
      const trs = bodyRows
        .map((row) => {
          const tds = headers
            .map((_, idx) => {
              const align = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
              return `<td${align}>${renderInline(row[idx] ?? "")}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      out.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Ordered or unordered list.
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const parsed = parseList(lines, i);
      out.push(parsed.html);
      i = parsed.nextIdx;
      continue;
    }

    // Paragraph.
    const paraLines: string[] = [];
    while (i < lines.length && !isBlockStart(lines, i)) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    if (paraLines.length) {
      out.push(`<p>${paraLines.map(renderInline).join("<br />")}</p>`);
    }
  }

  return out.join("");
}

export function renderMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  return renderBlocks(normalized.split("\n"));
}
