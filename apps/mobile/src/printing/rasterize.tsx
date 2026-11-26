// Ticket → 1-bit bitmap, rendered off-screen (doc 06 §1.4 "raster is the only
// reliable path for Arabic").
//
// The doc budgets react-native-view-shot for this; it is not in the dev
// client, react-native-webview is. A hidden WebView draws the ticket on a
// <canvas> — WebKit / Chromium shape Arabic properly, with the system Arabic
// font — thresholds the pixels to 1 bit, packs them MSB-first and posts the
// rows back as base64. The domain package then wraps them in GS v 0.
//
// Mounted on demand by PrintToPrinterAction; nothing here touches BLE.

import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { DOTS, type Bitmap1, type PaperWidth, type Ticket } from "@matgary/domain";

import { PrinterError, fromBase64 } from "./transport";

export interface RasterizerHandle {
  render(ticket: Ticket, width: PaperWidth): Promise<Bitmap1>;
}

type Pending = { resolve: (b: Bitmap1) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const RENDER_TIMEOUT_MS = 8000;

/**
 * The page. Layout mirrors packages/domain/src/escpos/receipt.ts line for
 * line so text mode and raster mode print the same ticket; the only
 * difference is who draws the glyphs.
 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#fff"><canvas id="c"></canvas><script>
(function(){
  var post = function(o){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); };
  var FONT = "-apple-system, 'SF Arabic', 'Geeza Pro', Roboto, 'Noto Naskh Arabic', 'Noto Sans Arabic', 'Droid Arabic Naskh', sans-serif";
  function font(px, bold){ return (bold ? "bold " : "") + px + "px " + FONT; }
  function fitText(ctx, s, max){
    if (ctx.measureText(s).width <= max) return s;
    var chars = Array.from(s), out = "";
    for (var i = 0; i < chars.length; i++){ if (ctx.measureText(out + chars[i]).width > max) break; out += chars[i]; }
    return out;
  }
  function wrapText(ctx, s, max){
    var words = s.split(/\\s+/).filter(Boolean), lines = [], cur = "";
    for (var i = 0; i < words.length; i++){
      var cand = cur ? cur + " " + words[i] : words[i];
      if (ctx.measureText(cand).width <= max) cur = cand;
      else { if (cur) lines.push(cur); cur = ctx.measureText(words[i]).width > max ? fitText(ctx, words[i], max) : words[i]; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }
  // Draws the ticket (or, with draw=false, only measures it) and returns the
  // y after the last line. Two passes: measure to size the canvas exactly,
  // then draw — so a long sale is never silently truncated.
  function layout(ctx, req, draw){
    var W = req.width, PAD = 8, BASE = W >= 500 ? 28 : 24, LH = 1.35;
    var rtl = !!req.ticket.rtl, y = PAD, inner = W - PAD * 2;
    var lines = req.ticket.lines;
    for (var i = 0; i < lines.length; i++){
      var l = lines[i];
      if (l.kind === "text"){
        var px = BASE * (l.size || 1);
        ctx.font = font(px, !!l.bold);
        ctx.direction = rtl ? "rtl" : "ltr";
        var a = l.align || (rtl ? "right" : "left");
        ctx.textAlign = a === "center" ? "center" : a;
        var x = a === "center" ? W / 2 : a === "right" ? W - PAD : PAD;
        var ws = wrapText(ctx, l.text, inner);
        for (var k = 0; k < ws.length; k++){ if (draw) ctx.fillText(ws[k], x, y); y += px * LH; }
      } else if (l.kind === "row"){
        if (draw){
          ctx.font = font(BASE, !!l.bold);
          ctx.direction = "ltr"; ctx.textAlign = "left";
          var endW = ctx.measureText(l.end).width;
          var startMax = inner - endW - 16;
          ctx.direction = rtl ? "rtl" : "ltr";
          var start = fitText(ctx, l.start, startMax);
          if (rtl){ ctx.textAlign = "right"; ctx.fillText(start, W - PAD, y); ctx.direction = "ltr"; ctx.textAlign = "left"; ctx.fillText(l.end, PAD, y); }
          else { ctx.textAlign = "left"; ctx.fillText(start, PAD, y); ctx.textAlign = "right"; ctx.fillText(l.end, W - PAD, y); }
        }
        y += BASE * LH;
      } else if (l.kind === "rule"){
        y += 6; if (draw) ctx.fillRect(PAD, Math.round(y), inner, 2); y += 12;
      } else if (l.kind === "feed"){
        y += BASE * (l.lines || 1);
      }
    }
    return y + PAD;
  }
  window.__render = function(req){
    try {
      var W = req.width, MAX_H = 20000;
      var c = document.getElementById("c");
      var ctx = c.getContext("2d", { willReadFrequently: true });
      // Pass 1: measure. Font metrics do not depend on the canvas size.
      c.width = W; c.height = 8;
      var H = Math.max(8, Math.ceil(layout(ctx, req, false)));
      if (H > MAX_H){ post({ id: req.id, error: "tooLong" }); return; }
      // Pass 2: draw on a canvas exactly as tall as the ticket. Resizing
      // resets the context state, so the styles are set after it.
      c.width = W; c.height = H;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#000"; ctx.textBaseline = "top";
      layout(ctx, req, true);
      var img = ctx.getImageData(0, 0, W, H).data, bpr = W / 8, rows = new Uint8Array(bpr * H);
      for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++){
        var p = (yy * W + xx) * 4, lum = (img[p] * 299 + img[p+1] * 587 + img[p+2] * 114) / 1000;
        if (lum < 150) rows[yy * bpr + (xx >> 3)] |= (0x80 >> (xx & 7));
      }
      var bin = "", CH = 0x8000;
      for (var o = 0; o < rows.length; o += CH) bin += String.fromCharCode.apply(null, rows.subarray(o, Math.min(rows.length, o + CH)));
      post({ id: req.id, width: W, height: H, data: btoa(bin) });
    } catch (e) { post({ id: req.id, error: String(e && e.message || e) }); }
  };
  post({ ready: true });
})();
</script></body></html>`;

/**
 * Mount while printing; call `ref.current.render(ticket, width)`. One render
 * at a time — the action button serialises its own presses anyway.
 */
export const TicketRasterizer = forwardRef<RasterizerHandle, object>(function TicketRasterizer(_props, ref) {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const waiting = useRef<(() => void)[]>([]);
  const pending = useRef(new Map<string, Pending>());

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let msg: { ready?: boolean; id?: string; width?: number; height?: number; data?: string; error?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data) as typeof msg;
    } catch {
      return;
    }
    if (msg.ready) {
      ready.current = true;
      waiting.current.splice(0).forEach((fn) => fn());
      return;
    }
    if (!msg.id) return;
    const p = pending.current.get(msg.id);
    if (!p) return;
    pending.current.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error === "tooLong") {
      p.reject(new PrinterError("tooLong", "rasterize: ticket exceeds the bitmap height cap"));
      return;
    }
    if (msg.error || !msg.data || !msg.width || !msg.height) {
      p.reject(new PrinterError("unknown", msg.error ?? "rasterize failed"));
      return;
    }
    const data = fromBase64(msg.data);
    if (data.length !== (msg.width / 8) * msg.height) {
      p.reject(new PrinterError("unknown", "rasterize: bitmap size mismatch"));
      return;
    }
    p.resolve({ width: msg.width, height: msg.height, data });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      async render(ticket, width) {
        if (!ready.current) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new PrinterError("timeout", "rasterizer did not load")), RENDER_TIMEOUT_MS);
            waiting.current.push(() => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise<Bitmap1>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.current.delete(id);
            reject(new PrinterError("timeout", "rasterize timed out"));
          }, RENDER_TIMEOUT_MS);
          pending.current.set(id, { resolve, reject, timer });
          // Only drawable kinds go over; qr/cut are native ESC/POS commands appended by print.ts.
          const drawable = ticket.lines.filter((l) => l.kind === "text" || l.kind === "row" || l.kind === "rule" || l.kind === "feed");
          const payload = JSON.stringify({ id, width: DOTS[width], ticket: { rtl: ticket.rtl, lines: drawable } });
          web.current?.injectJavaScript(`window.__render(${payload}); true;`);
        });
      },
    }),
    [],
  );

  return (
    <View style={styles.hidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={web}
        source={{ html: HTML }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={onMessage}
        scrollEnabled={false}
        style={styles.web}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" },
  web: { width: 1, height: 1, backgroundColor: "transparent" },
});
