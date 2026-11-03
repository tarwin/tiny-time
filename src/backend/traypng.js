// Tiny Time — the menu-bar "pill", rasterized by hand.
//
// Lifted from Till: the tray API takes an icon + text title, but a text title
// changes width between states. So we draw the whole widget (glyph chip +
// H:MM chip) into an RGBA buffer and hand-encode a PNG (the backend has no
// canvas). Rendered @2x, tagged 144 dpi, FIXED pixel size, so the menu-bar
// item never resizes. Regenerated only when the text or state changes.

export const TS = 2;                                  // render scale (2 = retina)
// buffer size for the image being drawn (the pill, or the square icon on
// Windows/Linux); the draw helpers read these
let TW = 64 * TS, TH = 22 * TS;
const FONT = {                                 // 3×5 bitmap font, MSB = left px
  '0': [0b111, 0b101, 0b101, 0b101, 0b111], '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111], '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001], '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111], '7': [0b111, 0b001, 0b010, 0b100, 0b100],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111], '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  ':': [0b000, 0b010, 0b000, 0b010, 0b000], '-': [0b000, 0b000, 0b111, 0b000, 0b000], ' ': [0, 0, 0, 0, 0],
};
function blend(buf, x, y, r, g, b, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= TW || y >= TH || a <= 0) return;
  const i = (y * TW + x) * 4, ia = a / 255, ib = 1 - ia;
  buf[i] = r * ia + buf[i] * ib; buf[i + 1] = g * ia + buf[i + 1] * ib;
  buf[i + 2] = b * ia + buf[i + 2] * ib;
  buf[i + 3] = Math.min(255, a + buf[i + 3] * ib);   // src-over: αo = αs + αd(1−αs)
}
function fillRR(buf, x0, y0, x1, y1, rad, r, g, b, a) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let dx = 0, dy = 0;
    if (x < x0 + rad) dx = x0 + rad - x; else if (x >= x1 - rad) dx = x - (x1 - rad - 1);
    if (y < y0 + rad) dy = y0 + rad - y; else if (y >= y1 - rad) dy = y - (y1 - rad - 1);
    if (dx && dy && dx * dx + dy * dy > rad * rad) continue;
    blend(buf, x, y, r, g, b, a);
  }
}
function drawGlyph(buf, running, cx, cy, sz, r, g, b, a) {
  if (running) {                       // pause: two bars
    const bw = Math.max(2, Math.round(sz * 0.30)), h = Math.round(sz / 2);
    for (let xx = 0; xx < bw; xx++) for (let yy = -h; yy <= h; yy++) {
      blend(buf, cx + xx, cy + yy, r, g, b, a);
      blend(buf, cx + sz - bw + xx, cy + yy, r, g, b, a);
    }
  } else {                             // play: right-pointing triangle
    for (let xx = 0; xx < sz; xx++) {
      const half = Math.round((sz / 2) * (1 - xx / sz));
      for (let yy = -half; yy <= half; yy++) blend(buf, cx + xx, cy + yy, r, g, b, a);
    }
  }
}
function drawText(buf, x, y, str, sc, r, g, b, a) {
  let cx = x;
  for (const ch of str) {
    const gl = FONT[ch] || FONT[' '];
    const narrow = ch === ':' || ch === '-';        // tighter advance for punctuation
    for (let ry = 0; ry < 5; ry++) for (let rx = 0; rx < 3; rx++)
      if (gl[ry] & (1 << (2 - rx)))
        for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++)
          blend(buf, cx + rx * sc + xx, y + ry * sc + yy, r, g, b, a);
    cx += (narrow ? 2 : 3) * sc + sc;               // glyph width + 1px gap
  }
}
// hand-rolled PNG (RGBA, uncompressed/stored zlib) — no image lib in txiki
let _crc;
function crc32(b) {
  if (!_crc) { _crc = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crc[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = _crc[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(b) { let a = 1, s = 0; for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; } return ((s << 16) | a) >>> 0; }
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type, data) {
  const body = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(Uint8Array.from(body)))];
}
function encodePNG(rgba, w, h) {
  const raw = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; raw.push(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]); } }
  const z = [0x78, 0x01]; let p = 0;                 // stored deflate
  while (p < raw.length) { const len = Math.min(65535, raw.length - p), last = (p + len >= raw.length) ? 1 : 0;
    z.push(last, len & 255, (len >> 8) & 255, (~len) & 255, ((~len) >> 8) & 255);
    for (let i = 0; i < len; i++) z.push(raw[p + i]); p += len; }
  z.push(...u32(adler32(Uint8Array.from(raw))));
  const ppm = 5669;                                  // 144 dpi → retina point size
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0]),
    ...chunk('pHYs', [...u32(ppm), ...u32(ppm), 1]),
    ...chunk('IDAT', z), ...chunk('IEND', [])]);
}
function textWidth(str, sc) {          // mirror of drawText's advances
  let w = 0;
  for (const ch of str) w += ((ch === ':' || ch === '-') ? 2 : 3) * sc + sc;
  return w - sc;                       // no trailing gap
}
export function renderTrayPNG(running, text, accent = [34, 166, 118]) {
  TW = 64 * TS; TH = 22 * TS;                  // fixed item size: never resizes
  // TWO chips: a brighter button holding the glyph, a small gap, then a
  // darker chip holding the time. Solid colors read well on any menu bar.
  const buf = new Uint8Array(TW * TH * 4);
  const cy = Math.round(TH / 2), rad = 4 * TS;
  const glyphW = 20 * TS, gap = 3 * TS;                     // glyph chip 20pt + 3pt gap
  // glyph chip: gray when idle, the user's accent color while tracking
  if (running) fillRR(buf, 0, TS, glyphW, TH - TS, rad, accent[0], accent[1], accent[2], 255);
  else fillRR(buf, 0, TS, glyphW, TH - TS, rad, 118, 120, 126, 255);
  // time chip: darker gray
  fillRR(buf, glyphW + gap, TS, TW, TH - TS, rad, 62, 63, 68, 255);
  // glyph, centered in its chip (play nudged right — triangles sit better off-center)
  const gsz = 9 * TS;
  drawGlyph(buf, running, Math.round((glyphW - gsz) / 2) + (running ? 0 : TS), cy, gsz, 255, 255, 255, 255);
  // time, centered in its chip
  const sc = 2 * TS;
  const tx = glyphW + gap + Math.round((TW - glyphW - gap - textWidth(text, sc)) / 2);
  drawText(buf, tx, cy - Math.round(2.5 * sc), text, sc, 235, 237, 242, running ? 255 : 190);
  return encodePNG(buf, TW, TH);
}

// Windows and Linux trays are square and have no text title: one rounded
// chip with the glyph — the accent color with ‖ while tracking, gray with ▶
// when idle. The time goes in the tooltip. 32pt, drawn @2x.
export function renderTraySquarePNG(running, accent = [34, 166, 118]) {
  TW = 32 * TS; TH = 32 * TS;
  const buf = new Uint8Array(TW * TH * 4);
  const c = running ? accent : [118, 120, 126];
  fillRR(buf, TS, TS, TW - TS, TH - TS, 7 * TS, c[0], c[1], c[2], 255);
  const gsz = 14 * TS;
  drawGlyph(buf, running, Math.round((TW - gsz) / 2) + (running ? 0 : TS), Math.round(TH / 2), gsz, 255, 255, 255, 255);
  return encodePNG(buf, TW, TH);
}

