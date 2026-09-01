/* ==========================================================================
   scanner-worker.js  ·  Web Worker clásico (importScripts, sin build step)
   SGE-PAU-F-02 · Gastos de Combustible
   ========================================================================== */
/* global importScripts, ScannerCore */
'use strict';

/* La URL del worker llega con ?v=<version>. Se reutiliza el mismo parámetro
   para el núcleo, de modo que worker y núcleo nunca queden desparejados en
   caché tras un despliegue. */
importScripts('./scanner-core.js' + (self.location.search || ''));

var session = ScannerCore.createSession();

function reply(msg, transfers) {
  try { self.postMessage(msg, transfers || []); }
  catch (e) { self.postMessage({ t: msg.t, id: msg.id, error: String(e && e.message || e) }); }
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  try {
    switch (m.t) {

      case 'ping': {
        reply({ t: 'ping', id: m.id, version: ScannerCore.VERSION });
        break;
      }

      case 'load': {
        var rgba = new Uint8ClampedArray(m.buf);
        var s = session.load(rgba, m.w, m.h);
        reply({ t: 'load', id: m.id, w: s.w, h: s.h });
        break;
      }

      // Detección sobre un frame suelto del visor en vivo. No toca la sesión.
      case 'frame': {
        var fr = new Uint8ClampedArray(m.buf);
        var d0 = ScannerCore.detect(fr, m.w, m.h, { fast: !!m.fast });
        reply({ t: 'frame', id: m.id, quad: d0.quad, score: d0.score, ok: d0.ok });
        break;
      }

      case 'detect': {
        var d = session.detect(m.maxSide, { seed: m.seed || null });
        reply({ t: 'detect', id: m.id, quad: d.quad, score: d.score, ok: d.ok, seedUsed: d.seedUsed });
        break;
      }

      case 'render': {
        var r = session.render(m.quad, m.filter, m.strength, m.maxSide, m.maxPixels);
        if (!r) { reply({ t: 'render', id: m.id, error: 'warp_failed' }); break; }
        reply({ t: 'render', id: m.id, w: r.w, h: r.h, buf: r.data.buffer }, [r.data.buffer]);
        break;
      }

      case 'thumbs': {
        var list = session.thumbs(m.quad, m.filters, m.strength, m.maxSide);
        var payload = list.map(function (it) {
          return { filter: it.filter, w: it.w, h: it.h, buf: it.data.buffer };
        });
        reply({ t: 'thumbs', id: m.id, items: payload }, payload.map(function (p) { return p.buf; }));
        break;
      }

      case 'free': {
        session.free();
        reply({ t: 'free', id: m.id });
        break;
      }

      default:
        reply({ t: m.t, id: m.id, error: 'unknown_command' });
    }
  } catch (err) {
    reply({ t: m.t, id: m.id, error: String(err && err.message || err) });
  }
};
