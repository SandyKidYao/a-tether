// Terminal text: display width with East Asian wide characters counted as two columns,
// and truncation and padding that keep SGR color codes intact.
const sgr = /\x1b\[[0-9;]*m/g;

const emoji = /\p{Emoji_Presentation}/u;
export function charWidth(cp: number) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return cp > 0x2000 && emoji.test(String.fromCodePoint(cp)) ? 2 : 1;
}

export function width(text: string) {
  let w = 0;
  for (const ch of text.replace(sgr, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}

// Text from outside (Claude Code's stderr, a model ID from A) must not move the cursor
// or change the terminal: control characters become spaces. The emoji variation
// selector goes too, as terminals disagree on how wide it makes a character.
export const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\ufe0f/g, "");

// Cuts text to at most `max` columns, ending in "…" when it had to cut.
export function truncate(text: string, max: number) {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "", w = 0, styled = false;
  for (let i = 0; i < text.length;) {
    if (text[i] === "\x1b") {
      sgr.lastIndex = i;
      const m = sgr.exec(text);
      if (m && m.index === i) { out += m[0]; styled = true; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + (styled ? "\x1b[0m" : "") + "…";
}

// Exactly `cols` columns: truncated, then padded with spaces.
export function fit(text: string, cols: number, align: "left" | "right" = "left") {
  const cut = truncate(text, cols);
  const gap = " ".repeat(Math.max(0, cols - width(cut)));
  return align === "right" ? gap + cut : cut + gap;
}

// The columns [start, end) of a line, colors kept. A wide character cut in half
// becomes a space.
export function slice(text: string, start: number, end: number) {
  let out = "", col = 0, style = "", begun = false;
  for (let i = 0; i < text.length && col < end;) {
    if (text[i] === "\x1b") {
      sgr.lastIndex = i;
      const m = sgr.exec(text);
      if (m && m.index === i) {
        style = m[0] === "\x1b[0m" ? "" : style + m[0];
        if (begun) out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!);
    i += ch.length;
    if (col + cw <= start) { col += cw; continue; }
    if (!begun) { begun = true; out += style; }
    if (col < start || col + cw > end) out += " ".repeat(Math.min(end, col + cw) - Math.max(start, col));
    else out += ch;
    col += cw;
  }
  return out + "\x1b[0m" + " ".repeat(Math.max(0, end - Math.max(col, start)));
}
