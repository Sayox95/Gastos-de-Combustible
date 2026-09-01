/* ==========================================================================
   scanner-core.js  ·  Núcleo de escaneo de documentos (sin dependencias)
   SGE-PAU-F-02 · Gastos de Combustible
   --------------------------------------------------------------------------
   Script clásico: funciona tanto en Web Worker (importScripts) como en el
   hilo principal (<script src>). Expone self.ScannerCore.
   ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* ======================================================================
     1. UTILIDADES BÁSICAS
     ====================================================================== */

  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v | 0); }

  function toGray(rgba, n, out) {
    out = out || new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
    return out;
  }

  /** Reduce por promedio de bloque (box average). Evita aliasing. */
  function downscaleGray(gray, w, h, nw, nh) {
    if (nw === w && nh === h) return gray;
    var out = new Uint8Array(nw * nh);
    var xr = w / nw, yr = h / nh;
    for (var y = 0; y < nh; y++) {
      var y0 = (y * yr) | 0;
      var y1 = Math.min(h, Math.ceil((y + 1) * yr)); if (y1 <= y0) y1 = y0 + 1;
      for (var x = 0; x < nw; x++) {
        var x0 = (x * xr) | 0;
        var x1 = Math.min(w, Math.ceil((x + 1) * xr)); if (x1 <= x0) x1 = x0 + 1;
        var s = 0, c = 0;
        for (var yy = y0; yy < y1; yy++) {
          var row = yy * w;
          for (var xx = x0; xx < x1; xx++) { s += gray[row + xx]; c++; }
        }
        out[y * nw + x] = (s / c) | 0;
      }
    }
    return out;
  }

  function fitSize(w, h, maxSide) {
    var s = Math.min(1, maxSide / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), s: s };
  }

  /** Imagen integral. sq=true -> integral de cuadrados. */
  function buildIntegral(src, w, h, sq) {
    var iw = w + 1;
    var I = new Float64Array(iw * (h + 1));
    for (var y = 0; y < h; y++) {
      var rowSum = 0, o = (y + 1) * iw, po = y * iw, so = y * w;
      for (var x = 0; x < w; x++) {
        var v = src[so + x];
        if (sq) v = v * v;
        rowSum += v;
        I[o + x + 1] = I[po + x + 1] + rowSum;
      }
    }
    return I;
  }

  function rectSum(I, iw, x0, y0, x1, y1) {
    return I[(y1 + 1) * iw + (x1 + 1)] - I[y0 * iw + (x1 + 1)]
         - I[(y1 + 1) * iw + x0] + I[y0 * iw + x0];
  }

  /** Desenfoque de caja O(n) via integral (independiente del radio). */
  function boxBlur(src, w, h, r) {
    var I = buildIntegral(src, w, h, false), iw = w + 1;
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var y0 = y - r; if (y0 < 0) y0 = 0;
      var y1 = y + r; if (y1 > h - 1) y1 = h - 1;
      var oy = y * w;
      for (var x = 0; x < w; x++) {
        var x0 = x - r; if (x0 < 0) x0 = 0;
        var x1 = x + r; if (x1 > w - 1) x1 = w - 1;
        var area = (x1 - x0 + 1) * (y1 - y0 + 1);
        out[oy + x] = (rectSum(I, iw, x0, y0, x1, y1) / area) | 0;
      }
    }
    return out;
  }

  /** Media y desviación estándar locales (ventana cuadrada 2r+1). */
  function localStats(src, w, h, r) {
    var I = buildIntegral(src, w, h, false);
    var I2 = buildIntegral(src, w, h, true);
    var iw = w + 1;
    var mean = new Float32Array(w * h);
    var std = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var y0 = y - r; if (y0 < 0) y0 = 0;
      var y1 = y + r; if (y1 > h - 1) y1 = h - 1;
      var oy = y * w;
      for (var x = 0; x < w; x++) {
        var x0 = x - r; if (x0 < 0) x0 = 0;
        var x1 = x + r; if (x1 > w - 1) x1 = w - 1;
        var area = (x1 - x0 + 1) * (y1 - y0 + 1);
        var s1 = rectSum(I, iw, x0, y0, x1, y1);
        var s2 = rectSum(I2, iw, x0, y0, x1, y1);
        var m = s1 / area;
        var v = s2 / area - m * m;
        mean[oy + x] = m;
        std[oy + x] = v > 0 ? Math.sqrt(v) : 0;
      }
    }
    return { mean: mean, std: std };
  }

  function otsu(src, n) {
    var hist = new Float64Array(256), i;
    for (i = 0; i < n; i++) hist[src[i]]++;
    var total = n, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (wB === 0) continue;
      var wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  /** Sobel. Devuelve gx, gy y magnitud (Float32). */
  function sobel(gray, w, h) {
    var gx = new Float32Array(w * h);
    var gy = new Float32Array(w * h);
    var mag = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      var o = y * w, up = o - w, dn = o + w;
      for (var x = 1; x < w - 1; x++) {
        var a = gray[up + x - 1], b = gray[up + x], c = gray[up + x + 1];
        var d = gray[o + x - 1], f = gray[o + x + 1];
        var g = gray[dn + x - 1], hh = gray[dn + x], k = gray[dn + x + 1];
        var vx = (c + 2 * f + k) - (a + 2 * d + g);
        var vy = (g + 2 * hh + k) - (a + 2 * b + c);
        gx[o + x] = vx; gy[o + x] = vy;
        mag[o + x] = Math.sqrt(vx * vx + vy * vy);
      }
    }
    return { gx: gx, gy: gy, mag: mag };
  }

  function sampleF32(arr, w, h, fx, fy) {
    if (fx < 0) fx = 0; if (fy < 0) fy = 0;
    if (fx > w - 1) fx = w - 1; if (fy > h - 1) fy = h - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var r0 = y0 * w, r1 = y1 * w;
    var t = arr[r0 + x0] * (1 - ax) + arr[r0 + x1] * ax;
    var b = arr[r1 + x0] * (1 - ax) + arr[r1 + x1] * ax;
    return t * (1 - ay) + b * ay;
  }

  /* ======================================================================
     2. GEOMETRÍA
     ====================================================================== */

  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  function cross3(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /** Envolvente convexa (monotone chain). pts: [{x,y}] */
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var lo = [], i;
    for (i = 0; i < p.length; i++) {
      while (lo.length >= 2 && cross3(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop();
      lo.push(p[i]);
    }
    var up = [];
    for (i = p.length - 1; i >= 0; i--) {
      while (up.length >= 2 && cross3(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
      up.push(p[i]);
    }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  function perimeter(poly) {
    var s = 0;
    for (var i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
    return s;
  }

  function polyArea(poly) {
    var s = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function pointLineDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return dist(p, a);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
  }

  /** Douglas–Peucker sobre una cadena abierta. */
  function dpChain(pts, first, last, eps, keep) {
    var maxD = -1, idx = -1;
    for (var i = first + 1; i < last; i++) {
      var d = pointLineDist(pts[i], pts[first], pts[last]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      dpChain(pts, first, idx, eps, keep);
      keep.push(idx);
      dpChain(pts, idx, last, eps, keep);
    }
  }

  /** approxPolyDP para polígono cerrado. */
  function approxPolyClosed(poly, eps) {
    var n = poly.length;
    if (n <= 4) return poly.slice();
    // Punto más lejano del primero -> divide en dos cadenas
    var far = 0, maxD = -1;
    for (var i = 1; i < n; i++) {
      var d = dist(poly[0], poly[i]);
      if (d > maxD) { maxD = d; far = i; }
    }
    var chainA = poly.slice(0, far + 1);
    var chainB = poly.slice(far).concat([poly[0]]);
    var keepA = [], keepB = [];
    dpChain(chainA, 0, chainA.length - 1, eps, keepA);
    dpChain(chainB, 0, chainB.length - 1, eps, keepB);
    keepA.sort(function (a, b) { return a - b; });
    keepB.sort(function (a, b) { return a - b; });
    var out = [poly[0]];
    for (i = 0; i < keepA.length; i++) out.push(chainA[keepA[i]]);
    out.push(poly[far]);
    for (i = 0; i < keepB.length; i++) out.push(chainB[keepB[i]]);
    return out;
  }

  /** Rectángulo de área mínima (rotating calipers simplificado). */
  function minAreaRect(hull) {
    if (hull.length < 3) return null;
    var best = null, bestArea = Infinity;
    for (var i = 0; i < hull.length; i++) {
      var a = hull[i], b = hull[(i + 1) % hull.length];
      var ex = b.x - a.x, ey = b.y - a.y;
      var len = Math.sqrt(ex * ex + ey * ey);
      if (len < 1e-6) continue;
      ex /= len; ey /= len;
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var j = 0; j < hull.length; j++) {
        var u = hull[j].x * ex + hull[j].y * ey;
        var v = -hull[j].x * ey + hull[j].y * ex;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      var area = (maxU - minU) * (maxV - minV);
      if (area < bestArea) {
        bestArea = area;
        best = [
          { x: minU * ex - minV * ey, y: minU * ey + minV * ex },
          { x: maxU * ex - minV * ey, y: maxU * ey + minV * ex },
          { x: maxU * ex - maxV * ey, y: maxU * ey + maxV * ex },
          { x: minU * ex - maxV * ey, y: minU * ey + maxV * ex }
        ];
      }
    }
    return best;
  }

  /**
   * Cuadrilátero de área máxima inscrito en la envolvente convexa.
   *
   * Douglas-Peucker falla cuando un lado del papel tiene una leve curvatura:
   * conserva el vértice del abombamiento y descarta la esquina verdadera,
   * recortando el documento. El criterio de área máxima no tiene ese sesgo,
   * porque sacrificar una esquina real siempre cuesta área.
   * El contorno se simplifica antes para que la búsqueda exhaustiva sea
   * barata: con 30 vértices son ~27.000 combinaciones.
   */
  function maxAreaQuad(hull) {
    if (!hull || hull.length < 4) return null;
    if (hull.length === 4) return orderQuad(hull.slice());

    var pts = hull;
    var peri = perimeter(hull);
    if (pts.length > 30) pts = approxPolyClosed(hull, peri * 0.004);
    if (pts.length > 30) {
      var step = pts.length / 30, red = [];
      for (var t = 0; t < 30; t++) red.push(pts[Math.floor(t * step)]);
      pts = red;
    }
    var n = pts.length;
    if (n < 4) return null;

    function tri(a, b, c) {
      return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * 0.5;
    }
    var best = null, bestA = -1;
    for (var i = 0; i < n - 3; i++)
      for (var j = i + 1; j < n - 2; j++)
        for (var k = j + 1; k < n - 1; k++)
          for (var l = k + 1; l < n; l++) {
            var a = tri(pts[i], pts[j], pts[k]) + tri(pts[i], pts[k], pts[l]);
            if (a > bestA) { bestA = a; best = [pts[i], pts[j], pts[k], pts[l]]; }
          }
    return best ? orderQuad(best) : null;
  }

  /** Ordena 4 puntos como TL, TR, BR, BL (coordenadas de pantalla). */
  function orderQuad(pts) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= 4; cy /= 4;
    var s = pts.slice().sort(function (a, b) {
      return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
    });
    // atan2 con y hacia abajo produce orden horario visual empezando en ~9 en punto
    var bestIdx = 0, bestVal = Infinity;
    for (i = 0; i < 4; i++) {
      var v = s[i].x + s[i].y;
      if (v < bestVal) { bestVal = v; bestIdx = i; }
    }
    return [s[bestIdx], s[(bestIdx + 1) % 4], s[(bestIdx + 2) % 4], s[(bestIdx + 3) % 4]];
  }

  function isConvexQuad(q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var c = cross3(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (Math.abs(c) < 1e-6) continue;
      var s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return sign !== 0;
  }

  /* ======================================================================
     3. PUNTUACIÓN DE CANDIDATOS
     ====================================================================== */

  /**
   * Puntúa un cuadrilátero por soporte de gradiente en sus 4 lados,
   * área relativa y rectitud de los ángulos. Devuelve -1 si es inválido.
   */
  function scoreQuad(q, mag, w, h, magMax) {
    if (!q || q.length !== 4) return -1;
    var i;
    for (i = 0; i < 4; i++) {
      if (!isFinite(q[i].x) || !isFinite(q[i].y)) return -1;
      if (q[i].x < -0.2 * w || q[i].x > 1.2 * w) return -1;
      if (q[i].y < -0.2 * h || q[i].y > 1.2 * h) return -1;
    }
    if (!isConvexQuad(q)) return -1;

    var area = polyArea(q);
    var ratio = area / (w * h);
    if (ratio < 0.10 || ratio > 1.05) return -1;

    // Ángulos razonablemente rectos
    for (i = 0; i < 4; i++) {
      var p0 = q[(i + 3) % 4], p1 = q[i], p2 = q[(i + 1) % 4];
      var v1x = p0.x - p1.x, v1y = p0.y - p1.y;
      var v2x = p2.x - p1.x, v2y = p2.y - p1.y;
      var n1 = Math.sqrt(v1x * v1x + v1y * v1y), n2 = Math.sqrt(v2x * v2x + v2y * v2y);
      if (n1 < 8 || n2 < 8) return -1;
      var cosA = (v1x * v2x + v1y * v2y) / (n1 * n2);
      var ang = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI;
      if (ang < 50 || ang > 130) return -1;
    }

    // Soporte de borde: gradiente medio a lo largo de cada lado
    var SAMPLES = 28, total = 0, sides = 0;
    for (i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], acc = 0, cnt = 0;
      for (var s = 1; s < SAMPLES; s++) {
        var t = s / SAMPLES;
        var px = a.x + (b.x - a.x) * t;
        var py = a.y + (b.y - a.y) * t;
        if (px < 0 || py < 0 || px > w - 1 || py > h - 1) continue;
        // mejor valor en una banda perpendicular de +-2 px
        var dx = b.x - a.x, dy = b.y - a.y;
        var L = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / L, ny = dx / L;
        var best = 0;
        for (var o = -2; o <= 2; o++) {
          var v = sampleF32(mag, w, h, px + nx * o, py + ny * o);
          if (v > best) best = v;
        }
        acc += best; cnt++;
      }
      if (cnt > 0) { total += acc / cnt; sides++; }
    }
    if (sides === 0) return -1;
    var support = (total / sides) / (magMax || 1);

    // Prefiere cuadriláteros grandes, sin premiar el marco completo
    var areaBonus = ratio > 0.98 ? 0.6 : (0.55 + 0.45 * Math.min(1, ratio / 0.75));
    return support * areaBonus;
  }

  function pointInQuad(p, q) {
    var c = false;
    for (var i = 0, j = 3; i < 4; j = i++) {
      var xi = q[i].x, yi = q[i].y, xj = q[j].x, yj = q[j].y;
      if (((yi > p.y) !== (yj > p.y)) &&
          (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }

  /** ¿Está B contenido dentro de A, con una tolerancia en píxeles? */
  function quadContains(A, B, tol) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += A[i].x; cy += A[i].y; }
    cx /= 4; cy /= 4;
    // A se expande ligeramente para absorber el ruido del refinado
    var Ax = [];
    for (i = 0; i < 4; i++) {
      var dx = A[i].x - cx, dy = A[i].y - cy;
      var L = Math.sqrt(dx * dx + dy * dy) || 1;
      Ax.push({ x: A[i].x + dx / L * tol, y: A[i].y + dy / L * tol });
    }
    for (i = 0; i < 4; i++) if (!pointInQuad(B[i], Ax)) return false;
    return true;
  }

  /* ======================================================================
     4. CANDIDATOS: SEGMENTACIÓN POR INTENSIDAD
     ====================================================================== */

  /**
   * Componente conexo más grande de la máscara y su envolvente convexa.
   * Solo se guardan los extremos izquierdo/derecho de cada fila: su
   * envolvente convexa es idéntica a la del componente completo.
   */
  function largestComponentHull(mask, w, h, minFrac) {
    var n = w * h;
    var labels = new Int32Array(n);
    var stack = new Int32Array(n);
    var cur = 0, bestLabel = -1, bestSize = 0;
    for (var i = 0; i < n; i++) {
      if (!mask[i] || labels[i]) continue;
      cur++;
      var sp = 0, size = 0;
      stack[sp++] = i; labels[i] = cur;
      while (sp > 0) {
        var p = stack[--sp]; size++;
        var x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    if (bestLabel < 0 || bestSize < n * (minFrac || 0.08)) return null;

    var pts = [];
    for (var y2 = 0; y2 < h; y2++) {
      var row = y2 * w, lo = -1, hi = -1;
      for (var x2 = 0; x2 < w; x2++) {
        if (labels[row + x2] === bestLabel) { if (lo < 0) lo = x2; hi = x2; }
      }
      if (lo >= 0) {
        pts.push({ x: lo, y: y2 });
        if (hi !== lo) pts.push({ x: hi, y: y2 });
      }
    }
    if (pts.length < 4) return null;
    return convexHull(pts);
  }

  /** Devuelve TODOS los cuadriláteros plausibles del contorno; la
      puntuación decide después cuál gana. */
  function quadsFromHull(hull) {
    if (!hull || hull.length < 4) return [];
    var out = [];
    var peri = perimeter(hull);
    for (var f = 0.010; f <= 0.16; f += 0.006) {
      var ap = approxPolyClosed(hull, peri * f);
      if (ap.length === 4) { out.push(orderQuad(ap)); break; }
      if (ap.length < 4) break;
    }
    var ma = maxAreaQuad(hull);
    if (ma) out.push(ma);
    var r = minAreaRect(hull);
    if (r) out.push(orderQuad(r));
    return out;
  }

  /* ======================================================================
     5. CANDIDATOS: HOUGH GUIADO POR GRADIENTE
     ====================================================================== */

  function houghCandidates(sob, w, h) {
    var mag = sob.mag, gx = sob.gx, gy = sob.gy;
    var n = w * h, i;

    // Umbral: percentil alto de la magnitud
    var m8 = new Uint8Array(n), magMax = 0;
    for (i = 0; i < n; i++) if (mag[i] > magMax) magMax = mag[i];
    if (magMax < 1) return { lines: [], magMax: 1 };
    for (i = 0; i < n; i++) m8[i] = (mag[i] / magMax * 255) | 0;
    var thr = Math.max(24, otsu(m8, n));

    var NT = 180;
    var rhoMax = Math.ceil(Math.sqrt(w * w + h * h));
    var NR = 2 * rhoMax + 1;
    var acc = new Float32Array(NT * NR);
    var cosT = new Float32Array(NT), sinT = new Float32Array(NT);
    for (var t = 0; t < NT; t++) {
      var a = t * Math.PI / NT;
      cosT[t] = Math.cos(a); sinT[t] = Math.sin(a);
    }

    for (var y = 1; y < h - 1; y++) {
      var o = y * w;
      for (var x = 1; x < w - 1; x++) {
        var idx = o + x;
        if (m8[idx] < thr) continue;
        var deg = Math.atan2(gy[idx], gx[idx]) * 180 / Math.PI;
        if (deg < 0) deg += 180;
        if (deg >= 180) deg -= 180;
        var t0 = Math.round(deg) % NT;
        var wgt = mag[idx];
        for (var dt = -2; dt <= 2; dt++) {
          var tt = (t0 + dt + NT) % NT;
          var rho = Math.round(x * cosT[tt] + y * sinT[tt]) + rhoMax;
          if (rho < 0 || rho >= NR) continue;
          acc[tt * NR + rho] += wgt;
        }
      }
    }

    // Picos con supresión de no máximos
    var accMax = 0;
    for (i = 0; i < acc.length; i++) if (acc[i] > accMax) accMax = acc[i];
    if (accMax <= 0) return { lines: [], magMax: magMax };
    var minPeak = accMax * 0.18;
    var rWin = Math.max(8, Math.round(Math.min(w, h) * 0.06));
    var peaks = [];
    for (var tt2 = 0; tt2 < NT; tt2++) {
      var base = tt2 * NR;
      for (var rr = 1; rr < NR - 1; rr++) {
        var v = acc[base + rr];
        if (v < minPeak) continue;
        var isMax = true;
        for (var dtt = -3; dtt <= 3 && isMax; dtt++) {
          var t3 = (tt2 + dtt + NT) % NT;
          for (var drr = -rWin; drr <= rWin; drr++) {
            var r3 = rr + drr;
            if (r3 < 0 || r3 >= NR) continue;
            if (dtt === 0 && drr === 0) continue;
            if (acc[t3 * NR + r3] > v) { isMax = false; break; }
          }
        }
        if (isMax) peaks.push({ t: tt2, rho: rr - rhoMax, v: v });
      }
    }
    peaks.sort(function (p, q) { return q.v - p.v; });
    peaks = peaks.slice(0, 40);

    var lines = peaks.map(function (p) {
      return { a: cosT[p.t], b: sinT[p.t], c: -p.rho, t: p.t, v: p.v };
    });
    return { lines: lines, magMax: magMax };
  }

  function intersect(l1, l2) {
    var det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < 1e-8) return null;
    return {
      x: (l1.b * l2.c - l2.b * l1.c) / det,
      y: (l2.a * l1.c - l1.a * l2.c) / det
    };
  }

  function houghQuads(lines, w, h) {
    var vert = [], horz = [];
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].t;
      if (t <= 35 || t >= 145) vert.push(lines[i]);
      else if (t >= 55 && t <= 125) horz.push(lines[i]);
    }
    vert = vert.slice(0, 6); horz = horz.slice(0, 6);
    var quads = [];
    for (var a = 0; a < vert.length; a++)
      for (var b = a + 1; b < vert.length; b++)
        for (var c = 0; c < horz.length; c++)
          for (var d = c + 1; d < horz.length; d++) {
            var p1 = intersect(vert[a], horz[c]);
            var p2 = intersect(vert[b], horz[c]);
            var p3 = intersect(vert[b], horz[d]);
            var p4 = intersect(vert[a], horz[d]);
            if (!p1 || !p2 || !p3 || !p4) continue;
            quads.push(orderQuad([p1, p2, p3, p4]));
          }
    return quads;
  }

  /* ======================================================================
     5b. REFINAMIENTO DE BORDES
     ====================================================================== */

  /** Ajuste de recta por mínimos cuadrados totales (PCA). -> {a,b,c} */
  function fitLine(pts) {
    var n = pts.length, i, mx = 0, my = 0;
    if (n < 2) return null;
    for (i = 0; i < n; i++) { mx += pts[i].x; my += pts[i].y; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      var dx = pts[i].x - mx, dy = pts[i].y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    sxx /= n; syy /= n; sxy /= n;
    // Autovector principal de [[sxx,sxy],[sxy,syy]]
    var tr = sxx + syy, det = sxx * syy - sxy * sxy;
    var disc = tr * tr / 4 - det;
    if (disc < 0) disc = 0;
    var l1 = tr / 2 + Math.sqrt(disc);
    var vx, vy;
    if (Math.abs(sxy) > 1e-9) { vx = l1 - syy; vy = sxy; }
    else if (sxx >= syy) { vx = 1; vy = 0; }
    else { vx = 0; vy = 1; }
    var nl = Math.sqrt(vx * vx + vy * vy);
    if (nl < 1e-9) return null;
    vx /= nl; vy /= nl;
    var a = -vy, b = vx;            // normal
    return { a: a, b: b, c: -(a * mx + b * my) };
  }

  /**
   * Refina el cuadrilátero buscando, en cada lado, el máximo de gradiente
   * en una banda perpendicular y reajustando la recta a esos puntos.
   */
  function refineQuad(q, mag, w, h, magMax) {
    var lines = [], i, s;
    for (i = 0; i < 4; i++) {
      var A = q[i], B = q[(i + 1) % 4];
      var dx = B.x - A.x, dy = B.y - A.y;
      var L = Math.sqrt(dx * dx + dy * dy);
      if (L < 12) { lines.push(null); continue; }
      var nx = -dy / L, ny = dx / L;
      var R = Math.max(3, Math.min(14, L * 0.06));
      var N = Math.max(16, Math.min(64, Math.round(L / 5)));
      var pts = [];
      for (s = 0; s <= N; s++) {
        var t = 0.06 + (0.88 * s / N);
        var px = A.x + dx * t, py = A.y + dy * t;
        var best = -1, bestO = 0;
        for (var o = -R; o <= R; o += 0.5) {
          var v = sampleF32(mag, w, h, px + nx * o, py + ny * o);
          if (v > best) { best = v; bestO = o; }
        }
        if (best > magMax * 0.12) pts.push({ x: px + nx * bestO, y: py + ny * bestO });
      }
      lines.push(pts.length >= 8 ? fitLine(pts) : null);
    }
    // Rellena lados sin ajuste con la recta original
    for (i = 0; i < 4; i++) {
      if (lines[i]) continue;
      var P = q[i], Q = q[(i + 1) % 4];
      var ex = Q.x - P.x, ey = Q.y - P.y;
      var el = Math.sqrt(ex * ex + ey * ey) || 1;
      var la = -ey / el, lb = ex / el;
      lines[i] = { a: la, b: lb, c: -(la * P.x + lb * P.y) };
    }
    var out = [];
    for (i = 0; i < 4; i++) {
      var p = intersect(lines[(i + 3) % 4], lines[i]);
      if (!p) return null;
      out.push(p);
    }
    return orderQuad(out);
  }

  /* ======================================================================
     6. DETECCIÓN (API)
     ====================================================================== */

  /**
   * detect(rgba, w, h) -> { quad:[{x,y}x4], score, ok }
   * Se espera una imagen ya reducida (~480-720 px lado mayor).
   * Las coordenadas devueltas están en el espacio de ESA imagen.
   */
  function detect(rgba, w, h, opts) {
    opts = opts || {};
    var fast = !!opts.fast;
    var n = w * h;
    var gray = toGray(rgba, n);
    var blur = boxBlur(gray, w, h, fast ? 1 : 2);
    var sob = sobel(blur, w, h);

    var magMax = 0;
    for (var i = 0; i < n; i++) if (sob.mag[i] > magMax) magMax = sob.mag[i];
    if (magMax < 1) magMax = 1;

    var candidates = [];

    /* --- A/B: segmentación por intensidad ---
       Un solo umbral de Otsu es frágil cuando una sombra hunde parte del
       papel por debajo de él: esa zona se clasifica como fondo y el
       cuadrilátero sale recortado. Se barren varios umbrales por debajo de
       Otsu para que el contorno completo exista en el conjunto de
       candidatos; después la puntuación y la regla de contención deciden. */
    var thr = otsu(blur, n);
    var factores = fast ? [1, 0.62, 0.40] : [1, 0.82, 0.66, 0.52, 0.40, 0.30];
    var maskTmp = new Uint8Array(n);
    for (var fi = 0; fi < factores.length; fi++) {
      var tv = Math.max(8, Math.round(thr * factores[fi]));
      for (i = 0; i < n; i++) maskTmp[i] = blur[i] > tv ? 1 : 0;
      var hl = largestComponentHull(maskTmp, w, h, 0.08);
      var ql = quadsFromHull(hl);
      for (var qi = 0; qi < ql.length; qi++) candidates.push(ql[qi]);
    }
    // Documento oscuro sobre fondo claro
    for (i = 0; i < n; i++) maskTmp[i] = blur[i] > thr ? 0 : 1;
    var hullB = largestComponentHull(maskTmp, w, h, 0.08);
    var qbs = quadsFromHull(hullB);
    for (var qj = 0; qj < qbs.length; qj++) candidates.push(qbs[qj]);

    // Puntuación parcial: en modo rápido, si el contorno ya es convincente
    // se evita el Hough, que es la etapa cara.
    var best = null, bestScore = -1;
    var scored = [];   // todos los candidatos, para la regla de contención
    for (i = 0; i < candidates.length; i++) {
      var sc = scoreQuad(candidates[i], sob.mag, w, h, magMax);
      if (sc > 0) scored.push({ q: candidates[i], s: sc });
      if (sc > bestScore) { bestScore = sc; best = candidates[i]; }
    }

    if (!fast || bestScore < 0.50) {
      // --- C: Hough guiado por gradiente ---
      var hc = houghCandidates(sob, w, h);
      var hq = houghQuads(hc.lines, w, h);
      for (i = 0; i < hq.length; i++) {
        var sh = scoreQuad(hq[i], sob.mag, w, h, magMax);
        if (sh > 0) scored.push({ q: hq[i], s: sh });
        if (sh > bestScore) { bestScore = sh; best = hq[i]; }
      }
    }

    /* Una banda de sombra, un pliegue o una línea impresa gruesa producen un
       borde recto DENTRO del documento, a veces con más gradiente que el
       contorno real mal iluminado. El síntoma es un cuadrilátero recortado
       contenido dentro del verdadero.
       Regla: si un candidato envuelve al mejor y su puntuación no es mucho
       peor, gana el envolvente. El contorno del papel siempre encierra a
       cualquier artefacto interno; lo contrario nunca ocurre. */
    if (best && scored.length > 1) {
      var tol = Math.max(3, Math.min(w, h) * 0.02);
      for (i = 0; i < scored.length; i++) {
        var cand = scored[i];
        if (cand.q === best || cand.s <= 0) continue;
        /* Suelo absoluto: un cuadrilátero que abarca casi todo el encuadre
           puede envolver al mejor y ganar por área aunque no se apoye en
           ningún borde real. Exigirle una puntuación mínima propia lo filtra
           sin sacrificar los recortes legítimos por sombra. */
        if (cand.s >= 0.35 && cand.s >= bestScore * 0.62 &&
            polyArea(cand.q) > polyArea(best) * 1.18 &&
            quadContains(cand.q, best, tol)) {
          best = cand.q; bestScore = cand.s;
        }
      }
    }

    // Refinamiento sub-borde: solo se acepta si no empeora la puntuación
    if (best) {
      var ref = refineQuad(best, sob.mag, w, h, magMax);
      if (ref) {
        var rs = scoreQuad(ref, sob.mag, w, h, magMax);
        if (rs >= bestScore * 0.97) { best = ref; bestScore = Math.max(bestScore, rs); }
      }
    }

    // Semilla del visor en vivo (normalizada 0..1). El usuario ya la validó
    // visualmente antes de disparar, así que se le concede un margen del 20%
    // frente a la detección ciega sobre la foto fija.
    var seedUsed = false;
    if (opts.seed && opts.seed.length === 4) {
      var sq = [];
      for (i = 0; i < 4; i++) {
        sq.push({ x: opts.seed[i].x * w, y: opts.seed[i].y * h });
      }
      var sref = refineQuad(sq, sob.mag, w, h, magMax) || sq;
      var ssc = scoreQuad(sref, sob.mag, w, h, magMax);
      if (ssc > 0 && ssc * 1.20 >= bestScore) {
        best = sref; bestScore = ssc; seedUsed = true;
      }
    }

    var ok = !!best && bestScore >= 0.11;
    if (!best) {
      seedUsed = false;
      var mx = w * 0.06, my = h * 0.06;
      best = [
        { x: mx, y: my }, { x: w - mx, y: my },
        { x: w - mx, y: h - my }, { x: mx, y: h - my }
      ];
    }
    // Recorta a un margen tolerante
    for (i = 0; i < 4; i++) {
      best[i].x = Math.max(0, Math.min(w - 1, best[i].x));
      best[i].y = Math.max(0, Math.min(h - 1, best[i].y));
    }
    return { quad: best, score: bestScore, ok: ok, seedUsed: seedUsed };
  }

  /* ======================================================================
     7. HOMOGRAFÍA
     ====================================================================== */

  /** Resuelve Ax=b (8x8) por eliminación gaussiana con pivoteo parcial. */
  function solve8(A, b) {
    var N = 8, i, j, k;
    for (i = 0; i < N; i++) {
      var piv = i, maxV = Math.abs(A[i][i]);
      for (k = i + 1; k < N; k++) {
        var v = Math.abs(A[k][i]);
        if (v > maxV) { maxV = v; piv = k; }
      }
      if (maxV < 1e-12) return null;
      if (piv !== i) {
        var tmp = A[i]; A[i] = A[piv]; A[piv] = tmp;
        var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      }
      for (k = i + 1; k < N; k++) {
        var f = A[k][i] / A[i][i];
        if (f === 0) continue;
        for (j = i; j < N; j++) A[k][j] -= f * A[i][j];
        b[k] -= f * b[i];
      }
    }
    var x = new Float64Array(N);
    for (i = N - 1; i >= 0; i--) {
      var s = b[i];
      for (j = i + 1; j < N; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /**
   * Homografía que mapea dst(u,v) -> src(x,y). Se usa para muestreo inverso.
   * dst y src son arrays de 4 puntos correspondientes.
   */
  function homography(dst, src) {
    var A = [], b = new Float64Array(8);
    for (var i = 0; i < 4; i++) {
      var u = dst[i].x, v = dst[i].y, X = src[i].x, Y = src[i].y;
      A.push([u, v, 1, 0, 0, 0, -u * X, -v * X]); b[2 * i] = X;
      A.push([0, 0, 0, u, v, 1, -u * Y, -v * Y]); b[2 * i + 1] = Y;
    }
    return solve8(A, b);
  }

  /** Tamaño de salida sugerido a partir del cuadrilátero. */
  function suggestOutputSize(quad, maxSide, maxPixels) {
    var wTop = dist(quad[0], quad[1]), wBot = dist(quad[3], quad[2]);
    var hLef = dist(quad[0], quad[3]), hRig = dist(quad[1], quad[2]);
    var W = Math.max(wTop, wBot), H = Math.max(hLef, hRig);
    if (W < 8) W = 8; if (H < 8) H = 8;
    var s = 1;
    if (Math.max(W, H) > maxSide) s = maxSide / Math.max(W, H);
    if (W * s * H * s > maxPixels) s = Math.sqrt(maxPixels / (W * H));
    return { w: Math.max(8, Math.round(W * s)), h: Math.max(8, Math.round(H * s)) };
  }

  /** Aplica la homografía. Devuelve Uint8ClampedArray RGBA de ow*oh. */
  function warp(srcRGBA, sw, sh, quad, ow, oh) {
    var dst = [{ x: 0, y: 0 }, { x: ow - 1, y: 0 }, { x: ow - 1, y: oh - 1 }, { x: 0, y: oh - 1 }];
    var Hm = homography(dst, quad);
    if (!Hm) return null;
    var a = Hm[0], b = Hm[1], c = Hm[2], d = Hm[3], e = Hm[4], f = Hm[5], g = Hm[6], hh = Hm[7];
    var out = new Uint8ClampedArray(ow * oh * 4);
    for (var y = 0; y < oh; y++) {
      var o = y * ow * 4;
      var nx0 = b * y + c, ny0 = e * y + f, nd0 = hh * y + 1;
      for (var x = 0; x < ow; x++) {
        var den = a * 0 + nd0 + g * x;
        if (den === 0) den = 1e-9;
        var fx = (a * x + nx0) / den;
        var fy = (d * x + ny0) / den;
        var p = o + x * 4;
        if (fx < -1 || fy < -1 || fx > sw || fy > sh) {
          out[p] = 255; out[p + 1] = 255; out[p + 2] = 255; out[p + 3] = 255;
          continue;
        }
        if (fx < 0) fx = 0; if (fy < 0) fy = 0;
        if (fx > sw - 1) fx = sw - 1; if (fy > sh - 1) fy = sh - 1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
        var i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (var ch = 0; ch < 3; ch++) {
          var t = srcRGBA[i00 + ch] * (1 - ax) + srcRGBA[i01 + ch] * ax;
          var bb = srcRGBA[i10 + ch] * (1 - ax) + srcRGBA[i11 + ch] * ax;
          out[p + ch] = t * (1 - ay) + bb * ay;
        }
        out[p + 3] = 255;
      }
    }
    return out;
  }

  /* ======================================================================
     8. FILTROS
     ====================================================================== */

  /** Estimación de fondo (iluminación) a baja resolución. */
  function backgroundField(gray, w, h) {
    var t = fitSize(w, h, 300);
    var gs = downscaleGray(gray, w, h, t.w, t.h);
    var r = Math.max(3, Math.round(Math.min(t.w, t.h) / 7));
    var bg = boxBlur(gs, t.w, t.h, r);
    return { data: bg, w: t.w, h: t.h };
  }

  function flatFieldValue(v, bgv) {
    if (bgv < 8) bgv = 8;
    var o = v * 225 / bgv;
    return o > 255 ? 255 : (o < 0 ? 0 : o);
  }

  function percentiles(src, n, loP, hiP) {
    var hist = new Uint32Array(256), i;
    for (i = 0; i < n; i++) hist[src[i]]++;
    var loN = n * loP, hiN = n * hiP, acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= loN) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n - hiN) { hi = i; break; } }
    if (hi <= lo) { lo = 0; hi = 255; }
    return { lo: lo, hi: hi };
  }

  /** Elimina píxeles negros aislados y rellena huecos de 1 px. */
  function despeckle(bin, w, h) {
    var out = new Uint8Array(bin);
    for (var y = 1; y < h - 1; y++) {
      var o = y * w;
      for (var x = 1; x < w - 1; x++) {
        var i = o + x;
        var black = 0;
        if (!bin[i - w - 1]) black++; if (!bin[i - w]) black++; if (!bin[i - w + 1]) black++;
        if (!bin[i - 1]) black++; if (!bin[i + 1]) black++;
        if (!bin[i + w - 1]) black++; if (!bin[i + w]) black++; if (!bin[i + w + 1]) black++;
        if (!bin[i] && black <= 1) out[i] = 255;
        else if (bin[i] && black >= 7) out[i] = 0;
      }
    }
    return out;
  }

  var STRENGTH_K = { suave: 0.32, normal: 0.18, fuerte: 0.06 };

  /**
   * applyFilter(rgba, w, h, filter, strength) -> Uint8ClampedArray RGBA
   * filter: 'original' | 'gris' | 'bn' | 'color'
   * strength (solo 'bn'): 'suave' | 'normal' | 'fuerte'
   */
  function applyFilter(rgba, w, h, filter, strength) {
    var n = w * h, i, p;
    if (filter === 'original') return rgba;

    var gray = toGray(rgba, n);
    var bg = backgroundField(gray, w, h);
    var bx = bg.w / w, by = bg.h / h;

    if (filter === 'bn') {
      // Estadísticas locales sobre versión reducida del campo aplanado
      var ts = fitSize(w, h, 620);
      var gs = downscaleGray(gray, w, h, ts.w, ts.h);
      var ff = new Uint8Array(ts.w * ts.h);
      var sx = bg.w / ts.w, sy = bg.h / ts.h;
      for (var y = 0; y < ts.h; y++) {
        for (var x = 0; x < ts.w; x++) {
          var bv = sampleF32(bg.data, bg.w, bg.h, x * sx, y * sy);
          ff[y * ts.w + x] = flatFieldValue(gs[y * ts.w + x], bv) | 0;
        }
      }
      var r = Math.max(7, Math.round(Math.min(ts.w, ts.h) / 14));
      var st = localStats(ff, ts.w, ts.h, r);
      var k = STRENGTH_K[strength] || STRENGTH_K.normal;
      var T = new Float32Array(ts.w * ts.h);
      for (i = 0; i < T.length; i++) {
        var tv = st.mean[i] * (1 + k * (st.std[i] / 128 - 1));
        T[i] = tv < 28 ? 28 : (tv > 248 ? 248 : tv);
      }
      var tx = ts.w / w, ty = ts.h / h;
      var bin = new Uint8Array(n);
      for (var yy = 0; yy < h; yy++) {
        var ro = yy * w;
        var byy = yy * by, tyy = yy * ty;
        for (var xx = 0; xx < w; xx++) {
          var bgv = sampleF32(bg.data, bg.w, bg.h, xx * bx, byy);
          var thv = sampleF32(T, ts.w, ts.h, xx * tx, tyy);
          var fv = flatFieldValue(gray[ro + xx], bgv);
          bin[ro + xx] = fv > thv ? 255 : 0;
        }
      }
      bin = despeckle(bin, w, h);
      var outBn = new Uint8ClampedArray(n * 4);
      for (i = 0, p = 0; i < n; i++, p += 4) {
        var v = bin[i];
        outBn[p] = v; outBn[p + 1] = v; outBn[p + 2] = v; outBn[p + 3] = 255;
      }
      return outBn;
    }

    if (filter === 'gris') {
      var g2 = new Uint8Array(n);
      for (var y2 = 0; y2 < h; y2++) {
        var ro2 = y2 * w, by2 = y2 * by;
        for (var x2 = 0; x2 < w; x2++) {
          g2[ro2 + x2] = flatFieldValue(gray[ro2 + x2], sampleF32(bg.data, bg.w, bg.h, x2 * bx, by2)) | 0;
        }
      }
      var pc = percentiles(g2, n, 0.02, 0.99);
      var scale = 255 / Math.max(1, pc.hi - pc.lo);
      var outG = new Uint8ClampedArray(n * 4);
      for (i = 0, p = 0; i < n; i++, p += 4) {
        var gv = clamp255((g2[i] - pc.lo) * scale);
        outG[p] = gv; outG[p + 1] = gv; outG[p + 2] = gv; outG[p + 3] = 255;
      }
      return outG;
    }

    // 'color': aplanado de iluminación por canal + realce de saturación
    var outC = new Uint8ClampedArray(n * 4);
    for (var y3 = 0; y3 < h; y3++) {
      var ro3 = y3 * w, by3 = y3 * by;
      for (var x3 = 0; x3 < w; x3++) {
        var idx = ro3 + x3, q = idx * 4;
        var bv3 = sampleF32(bg.data, bg.w, bg.h, x3 * bx, by3);
        var rr = flatFieldValue(rgba[q], bv3);
        var gg = flatFieldValue(rgba[q + 1], bv3);
        var bb2 = flatFieldValue(rgba[q + 2], bv3);
        var lum = (rr * 0.30 + gg * 0.59 + bb2 * 0.11);
        outC[q] = clamp255(lum + (rr - lum) * 1.25);
        outC[q + 1] = clamp255(lum + (gg - lum) * 1.25);
        outC[q + 2] = clamp255(lum + (bb2 - lum) * 1.25);
        outC[q + 3] = 255;
      }
    }
    return outC;
  }

  /* ======================================================================
     9. SESIÓN (máquina de estado reutilizable por Worker y por hilo principal)
     ====================================================================== */

  /** Reducción RGBA por promedio de bloque. */
  function resampleRGBA(src, w, h, nw, nh) {
    if (nw === w && nh === h) return src;
    var out = new Uint8ClampedArray(nw * nh * 4);
    var xr = w / nw, yr = h / nh;
    for (var y = 0; y < nh; y++) {
      var y0 = (y * yr) | 0, y1 = Math.min(h, Math.ceil((y + 1) * yr)); if (y1 <= y0) y1 = y0 + 1;
      for (var x = 0; x < nw; x++) {
        var x0 = (x * xr) | 0, x1 = Math.min(w, Math.ceil((x + 1) * xr)); if (x1 <= x0) x1 = x0 + 1;
        var r = 0, g = 0, b = 0, c = 0;
        for (var yy = y0; yy < y1; yy++) {
          var row = yy * w * 4;
          for (var xx = x0; xx < x1; xx++) {
            var p = row + xx * 4;
            r += src[p]; g += src[p + 1]; b += src[p + 2]; c++;
          }
        }
        var q = (y * nw + x) * 4;
        out[q] = r / c; out[q + 1] = g / c; out[q + 2] = b / c; out[q + 3] = 255;
      }
    }
    return out;
  }

  function createSession() {
    var src = null, sw = 0, sh = 0;
    var warped = null, ww = 0, wh = 0, cacheKey = null;

    function doWarp(quad, maxSide, maxPixels) {
      var key = quad.map(function (p) { return p.x.toFixed(2) + ',' + p.y.toFixed(2); }).join(';') + '|' + maxSide + '|' + maxPixels;
      if (key === cacheKey && warped) return true;
      var s = suggestOutputSize(quad, maxSide, maxPixels);
      var w2 = warp(src, sw, sh, quad, s.w, s.h);
      if (!w2) return false;
      warped = w2; ww = s.w; wh = s.h; cacheKey = key;
      return true;
    }

    return {
      load: function (rgba, w, h) {
        src = rgba; sw = w; sh = h;
        warped = null; cacheKey = null;
        return { w: sw, h: sh };
      },
      size: function () { return { w: sw, h: sh }; },

      /** Detecta sobre versión reducida y devuelve el quad en coords de la fuente. */
      detect: function (maxSide, opts) {
        var t = fitSize(sw, sh, maxSide || 560);
        var small = resampleRGBA(src, sw, sh, t.w, t.h);
        var r = detect(small, t.w, t.h, opts);
        var kx = sw / t.w, ky = sh / t.h;
        var q = r.quad.map(function (p) { return { x: p.x * kx, y: p.y * ky }; });
        return { quad: q, score: r.score, ok: r.ok, seedUsed: r.seedUsed };
      },

      /** Warp + filtro. Devuelve {w,h,data:Uint8ClampedArray RGBA}. */
      render: function (quad, filter, strength, maxSide, maxPixels) {
        if (!doWarp(quad, maxSide, maxPixels)) return null;
        var out = applyFilter(warped, ww, wh, filter, strength);
        if (out === warped) out = new Uint8ClampedArray(warped);
        return { w: ww, h: wh, data: out };
      },

      /** Miniaturas de todos los filtros, calculadas a resolución media. */
      thumbs: function (quad, filters, strength, maxSide) {
        var s = suggestOutputSize(quad, maxSide || 380, (maxSide || 380) * (maxSide || 380) * 2);
        var small = warp(src, sw, sh, quad, s.w, s.h);
        if (!small) return [];
        var res = [];
        for (var i = 0; i < filters.length; i++) {
          var o = applyFilter(small, s.w, s.h, filters[i], strength);
          if (o === small) o = new Uint8ClampedArray(small);
          res.push({ filter: filters[i], w: s.w, h: s.h, data: o });
        }
        return res;
      },

      free: function () { src = null; warped = null; cacheKey = null; }
    };
  }

  /* ======================================================================
     10. EXPORT
     ====================================================================== */

  global.ScannerCore = {
    VERSION: VERSION,
    createSession: createSession,
    resampleRGBA: resampleRGBA,
    detect: detect,
    warp: warp,
    applyFilter: applyFilter,
    suggestOutputSize: suggestOutputSize,
    fitSize: fitSize,
    orderQuad: orderQuad,
    _internal: {
      toGray: toGray, boxBlur: boxBlur, otsu: otsu, sobel: sobel,
      convexHull: convexHull, approxPolyClosed: approxPolyClosed,
      minAreaRect: minAreaRect, homography: homography, localStats: localStats,
      scoreQuad: scoreQuad, downscaleGray: downscaleGray, refineQuad: refineQuad, fitLine: fitLine
    }
  };

})(typeof self !== 'undefined' ? self : this);
