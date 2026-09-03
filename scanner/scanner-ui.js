/* ==========================================================================
   scanner-ui.js  ·  Escáner de facturas con visor en vivo
   SGE-PAU-F-02 · Gastos de Combustible
   --------------------------------------------------------------------------
   window.FacturaScanner.openCamera()   -> visor en vivo + recorte + filtros
   window.FacturaScanner.open(file)     -> recorte + filtros sobre una foto
   Resuelve con:
     { dataUrl, mime, bytes, w, h }   imagen escaneada
     { skipped:true }                 usar la foto sin procesar
     { needFile:true }                el usuario pidió la cámara del teléfono
     null                             cancelado
   ========================================================================== */
(function (global) {
  'use strict';

  /* Versión del escáner. Se usa como parámetro anti-caché en los archivos
     que este módulo carga por su cuenta (worker, núcleo, hoja de estilos).
     Debe subirse en cada despliegue que toque scanner-*.js o scanner.css,
     y coincidir con el ?v= que index.html le pone a este archivo. */
  var VER = '2.10.0';
  var QS = '?v=' + VER;

  /* BASE se deriva de la URL de este propio script, así que funciona igual
     en la raíz de un dominio (Cloudflare Pages) que en una subruta de
     proyecto (GitHub Pages). El replace elimina también el ?v= si viene. */
  var BASE = (function () {
    var s = document.currentScript && document.currentScript.src;
    if (s) return s.replace(/[^/]*$/, '');
    try { return new URL('scanner/', document.baseURI).href; } catch (e) { return 'scanner/'; }
  })();

  /* ---- Parámetros ---- */
  var SRC_MAX_SIDE = 2000;   // antes 1600: recortaba un stream de 1920 o 2560
  var DETECT_MAX_SIDE = 560;
  var LIVE_MAX_SIDE = 320;        // lado mayor del frame de detección en vivo
  var LIVE_MIN_INTERVAL = 90;     // ms mínimos entre detecciones
  var LIVE_SLOW_MS = 250;         // si tarda más, se degrada a modo rápido
  var OUT_MAX_SIDE = 1500;
  var OUT_MAX_PIXELS = 2200000;
  var THUMB_MAX_SIDE = 360;
  var JPEG_QUALITY = 0.82;
  var SMOOTH_ALPHA = 0.38;        // suavizado temporal del cuadrilátero
  var STABLE_TOL = 0.014;         // movimiento relativo máx. para considerar estable
  var STABLE_READY = 2;           // detecciones estables para marcar el borde en verde
  var STABLE_HITS = 5;            // detecciones estables seguidas para autodisparo
  /* Antes el verde y el disparo compartían umbral, así que el borde se ponía
     verde en la misma detección en que ya se estaba capturando y no daba
     tiempo de verlo. Separarlos deja ~270 ms de confirmación visible. */

  var FILTERS = [
    { id: 'bn', label: 'B/N' },
    { id: 'gris', label: 'Grises' },
    { id: 'color', label: 'Color' },
    { id: 'original', label: 'Original' }
  ];
  var DEFAULT_FILTER = 'gris';
  var DEFAULT_STRENGTH = 'normal';

  /* ======================================================================
     Pistas contextuales de un solo uso
     ---------------------------------------------------------------------
     Aparecen donde está la atención y en el momento de la decisión, no al
     abrir la app. Se recuerdan en localStorage; si no está disponible
     (modo privado, almacenamiento bloqueado) se degrada a "una vez por
     carga de página" en lugar de repetirse en cada apertura.
     ====================================================================== */
  /* Subir este número reinicia el aviso para TODOS los usuarios: la clave
     vieja queda huérfana en localStorage y la nueva aún no existe, así que
     el aviso vuelve a mostrarse una sola vez y luego se recuerda igual.
     Debe coincidir con la clave leída en index.html (introFacturaVisto). */
  var COACH_KEY = 'scn_coach_v2_';
  var coachSession = {};

  function coachSeen(k) {
    if (coachSession[k]) return true;
    try { return localStorage.getItem(COACH_KEY + k) === '1'; }
    catch (e) { return false; }
  }
  function coachMark(k) {
    coachSession[k] = true;
    try { localStorage.setItem(COACH_KEY + k, '1'); } catch (e) {}
  }

  function loadScriptOnce(src) {
    loadScriptOnce._m = loadScriptOnce._m || {};
    if (loadScriptOnce._m[src]) return loadScriptOnce._m[src];
    loadScriptOnce._m[src] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = function () { delete loadScriptOnce._m[src]; rej(new Error('script_failed: ' + src)); };
      document.head.appendChild(s);
    });
    return loadScriptOnce._m[src];
  }

  /* ======================================================================
     Motor: Web Worker con handshake, o hilo principal
     ====================================================================== */

  function createEngine() {
    var worker = null;
    try { if (typeof Worker === 'function') worker = new Worker(BASE + 'scanner-worker.js' + QS); }
    catch (e) { worker = null; }
    if (!worker) return mainThreadEngine();

    return new Promise(function (resolve) {
      var settled = false;
      var to = setTimeout(function () { give(false); }, 4000);
      worker.onmessage = function (ev) { if ((ev.data || {}).t === 'ping') give(true); };
      worker.onerror = function () { give(false); };
      try { worker.postMessage({ t: 'ping', id: 0 }); } catch (e) { give(false); }
      function give(alive) {
        if (settled) return;
        settled = true; clearTimeout(to);
        if (alive) { resolve(workerEngine(worker)); }
        else { try { worker.terminate(); } catch (e) {} resolve(mainThreadEngine()); }
      }
    });
  }

  function workerEngine(worker) {
    var seq = 0, pending = {}, dead = false;
    worker.onmessage = function (ev) {
      var m = ev.data || {}, cb = pending[m.id];
      if (!cb) return;
      delete pending[m.id];
      if (m.error) cb.rej(new Error(m.error)); else cb.res(m);
    };
    worker.onerror = function () {
      dead = true;
      Object.keys(pending).forEach(function (k) { pending[k].rej(new Error('worker_error')); delete pending[k]; });
    };
    function send(msg, transfers) {
      if (dead) return Promise.reject(new Error('worker_dead'));
      msg.id = ++seq;
      return new Promise(function (res, rej) {
        pending[msg.id] = { res: res, rej: rej };
        worker.postMessage(msg, transfers || []);
      });
    }
    return {
      kind: 'worker',
      frame: function (imgData, fast) {
        var buf = imgData.data.buffer;
        return send({ t: 'frame', w: imgData.width, h: imgData.height, buf: buf, fast: !!fast }, [buf]);
      },
      load: function (imgData) {
        var buf = imgData.data.buffer;
        return send({ t: 'load', w: imgData.width, h: imgData.height, buf: buf }, [buf]);
      },
      detect: function (seed) { return send({ t: 'detect', maxSide: DETECT_MAX_SIDE, seed: seed || null }); },
      render: function (quad, filter, strength) {
        return send({
          t: 'render', quad: quad, filter: filter, strength: strength,
          maxSide: OUT_MAX_SIDE, maxPixels: OUT_MAX_PIXELS
        }).then(function (m) { return { w: m.w, h: m.h, data: new Uint8ClampedArray(m.buf) }; });
      },
      thumbs: function (quad, strength) {
        return send({
          t: 'thumbs', quad: quad, strength: strength, maxSide: THUMB_MAX_SIDE,
          filters: FILTERS.map(function (f) { return f.id; })
        }).then(function (m) {
          return m.items.map(function (it) {
            return { filter: it.filter, w: it.w, h: it.h, data: new Uint8ClampedArray(it.buf) };
          });
        });
      },
      destroy: function () { try { worker.terminate(); } catch (e) {} }
    };
  }

  function mainThreadEngine() {
    return loadScriptOnce(BASE + 'scanner-core.js' + QS).then(function () {
      var Core = global.ScannerCore;
      var session = Core.createSession();
      var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
      return {
        kind: 'main',
        frame: function (imgData, fast) {
          return tick().then(function () {
            return Core.detect(imgData.data, imgData.width, imgData.height, { fast: !!fast });
          });
        },
        load: function (imgData) {
          return tick().then(function () { return session.load(imgData.data, imgData.width, imgData.height); });
        },
        detect: function (seed) { return tick().then(function () { return session.detect(DETECT_MAX_SIDE, { seed: seed || null }); }); },
        render: function (quad, filter, strength) {
          return tick().then(function () {
            var r = session.render(quad, filter, strength, OUT_MAX_SIDE, OUT_MAX_PIXELS);
            if (!r) throw new Error('warp_failed');
            return r;
          });
        },
        thumbs: function (quad, strength) {
          return tick().then(function () {
            return session.thumbs(quad, FILTERS.map(function (f) { return f.id; }), strength, THUMB_MAX_SIDE);
          });
        },
        destroy: function () { try { session.free(); } catch (e) {} }
      };
    });
  }

  /* ======================================================================
     Decodificación / utilidades de imagen
     ====================================================================== */

  function decodeToCanvas(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var done = function (c) { if (!settled) { settled = true; resolve(c); } };
      var fail = function (e) { if (!settled) { settled = true; reject(e); } };

      if (typeof global.loadImage === 'function') {
        try {
          global.loadImage(file, function (res) {
            if (res && res.getContext) done(res); else viaBitmap();
          }, { maxWidth: maxSide, maxHeight: maxSide, canvas: true, orientation: true, meta: true });
          setTimeout(function () { if (!settled) viaBitmap(); }, 6000);
          return;
        } catch (e) { /* sigue */ }
      }
      viaBitmap();

      function viaBitmap() {
        if (settled) return;
        if (typeof createImageBitmap !== 'function') { viaImg(); return; }
        var p;
        try { p = createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (e) { try { p = createImageBitmap(file); } catch (e2) { viaImg(); return; } }
        p.then(function (bmp) {
          done(drawFit(bmp, bmp.width, bmp.height, maxSide));
          if (bmp.close) bmp.close();
        }).catch(viaImg);
      }
      function viaImg() {
        if (settled) return;
        var url = URL.createObjectURL(file), im = new Image();
        im.onload = function () {
          try { done(drawFit(im, im.naturalWidth, im.naturalHeight, maxSide)); } catch (e) { fail(e); }
          URL.revokeObjectURL(url);
        };
        im.onerror = function () { URL.revokeObjectURL(url); fail(new Error('decode_failed')); };
        im.src = url;
      }
    });
  }

  function drawFit(srcLike, iw, ih, maxSide) {
    var s = Math.min(1, maxSide / Math.max(iw, ih));
    var w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(srcLike, 0, 0, w, h);
    return c;
  }

  function imageDataToCanvas(o) {
    var c = document.createElement('canvas');
    c.width = o.w; c.height = o.h;
    var ctx = c.getContext('2d');
    var id = ctx.createImageData(o.w, o.h);
    id.data.set(o.data);
    ctx.putImageData(id, 0, 0);
    return c;
  }

  function encodeCanvas(canvas, filter) {
    var mime = (filter === 'bn') ? 'image/png' : 'image/jpeg';
    var url = (mime === 'image/png') ? canvas.toDataURL('image/png')
                                     : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    if (url.indexOf('data:image/') !== 0) return null;
    var b64 = url.slice(url.indexOf(',') + 1);
    return { dataUrl: url, mime: mime, bytes: Math.round(b64.length * 0.75) };
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function containRect(vw, vh, cw, ch) {
    var s = Math.min(cw / vw, ch / vh);
    var w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h, s: s };
  }

  /* ======================================================================
     Plantilla
     ====================================================================== */

  var TPL = ''
    + '<div class="scn-shell" role="dialog" aria-modal="true" aria-label="Escanear factura">'
    + '  <div class="scn-head">'
    + '    <button type="button" class="scn-x" data-act="cancel" aria-label="Cerrar">&#10005;</button>'
    + '    <span class="scn-title" data-el="title">Escanear factura</span>'
    + '    <span class="scn-badge" data-el="badge"></span>'
    + '  </div>'

    + '  <div class="scn-cam" data-el="cam">'
    + '    <video data-el="video" playsinline muted autoplay></video>'
    + '    <canvas class="scn-ovl" data-el="ovl"></canvas>'
    + '    <div class="scn-camstate" data-el="camstate">Iniciando cámara…</div>'
    + '    <div class="scn-flash" data-el="flash"></div>'
    + '  </div>'

    + '  <div class="scn-body" data-el="body">'
    + '    <div class="scn-stage" data-el="stage">'
    + '      <canvas data-el="canvas"></canvas>'
    + '      <canvas class="scn-loupe" data-el="loupe" width="132" height="132"></canvas>'
    + '    </div>'
    + '    <div class="scn-busy" data-el="busy"><div class="scn-spin"></div><span data-el="busytext">Procesando…</span></div>'
    + '  </div>'

    + '  <div class="scn-hint" data-el="hint"></div>'

    + '  <div class="scn-filters" data-el="filters" hidden></div>'
    + '  <div class="scn-strength" data-el="strength" hidden>'
    + '    <span class="scn-slabel">Intensidad</span>'
    + '    <div class="scn-seg">'
    + '      <button type="button" data-str="suave">Suave</button>'
    + '      <button type="button" data-str="normal">Normal</button>'
    + '      <button type="button" data-str="fuerte">Fuerte</button>'
    + '    </div>'
    + '  </div>'

    + '  <div class="scn-camfoot" data-el="camfoot">'
    + '    <button type="button" class="scn-round" data-act="torch" title="Linterna">&#9788;</button>'
    + '    <button type="button" class="scn-shutter" data-act="shot" aria-label="Capturar"><span></span></button>'
    + '    <button type="button" class="scn-round" data-act="auto" title="Autodisparo">AUTO</button>'
    + '  </div>'

    + '  <div class="scn-foot" data-el="foot">'
    + '    <button type="button" class="scn-btn ghost" data-act="back">Atrás</button>'
    + '    <button type="button" class="scn-btn warn" data-act="full">No recortar</button>'
    + '    <button type="button" class="scn-btn ghost" data-act="skip">Sin procesar</button>'
    + '    <button type="button" class="scn-btn primary" data-act="next">Continuar</button>'
    + '  </div>'
    + '</div>';

  /**
   * Carga scanner.css y devuelve una promesa que resuelve cuando ya está
   * aplicado. Antes solo lo inyectaba y seguía de largo, así que la tarjeta
   * y el modal se pintaban sin estilos durante unos fotogramas: se veía una
   * versión "en crudo" antes de la definitiva.
   * El tope de 1500 ms evita quedarse esperando si la hoja no llega; en ese
   * caso se sigue igual, apoyado en los estilos críticos en línea.
   */
  var cssPromise = null;
  function ensureCss() {
    if (cssPromise) return cssPromise;
    if (document.getElementById('scn-css')) {
      cssPromise = Promise.resolve();
      return cssPromise;
    }
    cssPromise = new Promise(function (res) {
      var l = document.createElement('link');
      l.id = 'scn-css'; l.rel = 'stylesheet'; l.href = BASE + 'scanner.css' + QS;
      var hecho = false;
      var fin = function () { if (hecho) return; hecho = true; res(); };
      l.onload = fin;
      l.onerror = fin;
      setTimeout(fin, 1500);
      document.head.appendChild(l);
    });
    return cssPromise;
  }

  /* ======================================================================
     Controlador
     ====================================================================== */

  function openScanner(source) {
    ensureCss();
    return new Promise(function (resolve) {
      var root = document.createElement('div');
      root.className = 'scn-overlay';
      root.innerHTML = TPL;
      document.body.appendChild(root);
      document.body.classList.add('scn-lock');

      var el = {}, btn = {};
      root.querySelectorAll('[data-el]').forEach(function (n) { el[n.getAttribute('data-el')] = n; });
      root.querySelectorAll('[data-act]').forEach(function (n) { btn[n.getAttribute('data-act')] = n; });

      var engine = null;
      var srcCanvas = null, srcW = 0, srcH = 0, viewCanvas = null;
      var quad = null, stage = '', filter = DEFAULT_FILTER, strength = DEFAULT_STRENGTH;
      var rendered = null, renderedCanvas = null, encoded = null, thumbCache = null;
      var dragIdx = -1, renderToken = 0, closed = false;
      var view = { s: 1, w: 0, h: 0 };

      /* --------- estado del visor en vivo --------- */
      var stream = null, track = null, rafId = 0;
      var liveSmoothed = null, liveOk = false;
      var liveBusy = false, liveTimer = 0, liveFast = false;
      var stableHits = 0, autoCapture = true, torchOn = false, capturing = false;
      var grabCanvas = document.createElement('canvas');

      function busy(on, text) {
        el.busy.style.display = on ? 'flex' : 'none';
        if (text) el.busytext.textContent = text;
      }

      /* ==================================================================
         ETAPA 1 · VISOR EN VIVO
         ================================================================== */

      function showCamera() {
        stage = 'camera';
        el.title.textContent = 'Enfoque la factura';
        el.badge.textContent = '';
        el.cam.style.display = 'block';
        el.body.style.display = 'none';
        el.camfoot.style.display = 'flex';
        el.foot.style.display = 'flex';
        el.filters.hidden = true;
        el.strength.hidden = true;
        btn.back.style.display = 'none';
        btn.full.style.display = 'none';
        btn.next.style.display = 'none';
        btn.skip.style.display = '';
        btn.skip.textContent = 'Usar cámara del teléfono';
        btn.skip.style.display = '';
        btn.shot.disabled = false;
        syncAuto();
      }

      function startCamera() {
        showCamera();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          camError('Este navegador no permite el visor en vivo.');
          return;
        }
        var tries = [
          { video: { facingMode: { exact: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false },
          { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
          { video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false },
          { video: true, audio: false }
        ];
        (function attempt(i) {
          if (i >= tries.length) { camError('No se pudo abrir la cámara.'); return; }
          navigator.mediaDevices.getUserMedia(tries[i]).then(function (s) {
            if (closed || stage !== 'camera') { s.getTracks().forEach(function (t) { t.stop(); }); return; }
            stream = s;
            track = s.getVideoTracks()[0];
            el.video.srcObject = s;
            var pp = el.video.play();
            if (pp && pp.catch) pp.catch(function () {});
            setupTorch();
            el.camstate.textContent = 'Buscando documento…';
            el.hint.textContent = 'Coloque la factura sobre un fondo que contraste.';
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(overlayLoop);
            scheduleDetect(150);
          }).catch(function () { attempt(i + 1); });
        })(0);
      }

      function camError(msg) {
        el.camstate.textContent = msg;
        el.camstate.classList.add('err');
        el.hint.textContent = 'Puede continuar con la cámara del teléfono.';
        btn.shot.disabled = true;
      }

      function setupTorch() {
        var ok = false;
        try { ok = !!(track.getCapabilities && track.getCapabilities().torch); } catch (e) { ok = false; }
        btn.torch.style.visibility = ok ? 'visible' : 'hidden';
      }

      function toggleTorch() {
        if (!track) return;
        torchOn = !torchOn;
        btn.torch.classList.toggle('on', torchOn);
        try { track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) {}
      }

      /* ---- dibujo del overlay a 60fps, independiente de la detección ---- */
      function overlayLoop() {
        if (closed || stage !== 'camera') return;
        rafId = requestAnimationFrame(overlayLoop);
        var box = el.cam.getBoundingClientRect();
        if (!box.width || !box.height) return;
        var dpr = Math.min(2, global.devicePixelRatio || 1);
        var cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
        if (el.ovl.width !== cw || el.ovl.height !== ch) { el.ovl.width = cw; el.ovl.height = ch; }
        var ctx = el.ovl.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        if (!liveSmoothed || !el.video.videoWidth) return;

        var fit = containRect(el.video.videoWidth, el.video.videoHeight, cw, ch);
        var pts = liveSmoothed.map(function (p) {
          return { x: fit.x + p.x * fit.w, y: fit.y + p.y * fit.h };
        });

        var listo = stableHits >= STABLE_READY;
        var col = listo ? '#37d67a' : (liveOk ? '#4c9ffe' : '#8aa0bc');

        ctx.save();
        ctx.fillStyle = listo ? 'rgba(55,214,122,.16)' : 'rgba(76,159,254,.12)';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 3 * dpr;
        ctx.lineJoin = 'round';
        ctx.stroke();
        for (i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, 6 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();
        }
        ctx.restore();
      }

      /* ---- bucle de detección ---- */
      function scheduleDetect(delay) {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(detectFrame, delay);
      }

      function detectFrame() {
        if (closed || stage !== 'camera' || liveBusy || capturing) return;
        var v = el.video;
        if (!v.videoWidth || v.readyState < 2) { scheduleDetect(120); return; }
        liveBusy = true;
        var f = Math.min(1, LIVE_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
        var dw = Math.max(2, Math.round(v.videoWidth * f));
        var dh = Math.max(2, Math.round(v.videoHeight * f));
        if (grabCanvas.width !== dw || grabCanvas.height !== dh) { grabCanvas.width = dw; grabCanvas.height = dh; }
        var imgData;
        try {
          /* El visor lee un frame varias veces por segundo. Sin este
             atributo, Chrome mantiene el canvas en la GPU y cada getImageData
             obliga a una transferencia de vuelta a memoria. */
          var gctx = grabCanvas.getContext('2d', { willReadFrequently: true });
          gctx.drawImage(v, 0, 0, dw, dh);
          imgData = gctx.getImageData(0, 0, dw, dh);
        } catch (e) { liveBusy = false; scheduleDetect(400); return; }

        var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
        engine.frame(imgData, liveFast).then(function (r) {
          var dt = ((global.performance && performance.now) ? performance.now() : Date.now()) - t0;
          if (!liveFast && dt > LIVE_SLOW_MS) liveFast = true;
          liveBusy = false;
          if (closed || stage !== 'camera') return;
          onDetection(r, dw, dh);
          scheduleDetect(LIVE_MIN_INTERVAL);
        }).catch(function () {
          liveBusy = false;
          if (!closed && stage === 'camera') scheduleDetect(500);
        });
      }

      function onDetection(r, dw, dh) {
        liveOk = !!r.ok;
        var q = r.quad.map(function (p) { return { x: p.x / dw, y: p.y / dh }; });

        if (!r.ok) {
          stableHits = 0;
          el.camstate.textContent = 'Buscando documento…';
          el.camstate.classList.remove('ok');
          liveSmoothed = liveSmoothed ? blend(liveSmoothed, q, 0.15) : q;
          return;
        }

        var prev = liveSmoothed;
        liveSmoothed = prev ? blend(prev, q, SMOOTH_ALPHA) : q;

        if (prev) {
          var mv = 0;
          for (var i = 0; i < 4; i++) {
            mv = Math.max(mv, Math.hypot(liveSmoothed[i].x - prev[i].x, liveSmoothed[i].y - prev[i].y));
          }
          if (mv < STABLE_TOL) stableHits++; else stableHits = 0;
        }

        if (stableHits >= STABLE_HITS) {
          el.camstate.textContent = autoCapture ? 'Capturando…' : 'Listo · toque el botón';
          el.camstate.classList.add('ok');
          if (autoCapture) doCapture();
        } else if (stableHits >= STABLE_READY) {
          // Confirmación visible antes del disparo, y también útil en manual
          el.camstate.textContent = autoCapture ? 'Bordes detectados · no mueva' : 'Bordes detectados · toque el botón';
          el.camstate.classList.add('ok');
        } else {
          el.camstate.textContent = 'Documento detectado · mantenga firme';
          el.camstate.classList.remove('ok');
        }
      }

      function blend(a, b, k) {
        var o = [];
        for (var i = 0; i < 4; i++) {
          o.push({ x: a[i].x + (b[i].x - a[i].x) * k, y: a[i].y + (b[i].y - a[i].y) * k });
        }
        return o;
      }

      function syncAuto() { btn.auto.classList.toggle('on', autoCapture); }

      function doCapture() {
        if (capturing || closed) return;
        capturing = true;
        clearTimeout(liveTimer);
        el.flash.classList.add('go');
        setTimeout(function () { el.flash.classList.remove('go'); }, 220);

        var seed = liveSmoothed && liveOk ? liveSmoothed.slice() : null;
        grabStill().then(function (canvas) {
          stopCamera();
          el.cam.style.display = 'none';
          el.body.style.display = 'flex';
          el.camfoot.style.display = 'none';
          busy(true, 'Procesando captura…');
          return loadSource(canvas, seed);
        }).catch(function () {
          capturing = false;
          el.camstate.textContent = 'No se pudo capturar. Intente de nuevo.';
          scheduleDetect(300);
        });
      }

      /**
       * Captura SIEMPRE el frame del vídeo.
       *
       * Antes se intentaba ImageCapture.takePhoto() por resolución, pero esa
       * API dispara una toma independiente del preview: distinto campo de
       * visión y distinta exposición. Eso provocaba dos fallos reales:
       *   1) el cuadrilátero validado en el visor dejaba de corresponder;
       *   2) la foto salía sobreexpuesta (papel blanco quemado a 255).
       * Capturando del vídeo, lo que el usuario ve es exactamente lo que se
       * procesa. Se compensa la menor resolución pidiendo el stream más
       * grande disponible en startCamera().
       */
      function grabStill() {
        var v = el.video;
        if (!v.videoWidth) return Promise.reject(new Error('no_frame'));
        return Promise.resolve(drawFit(v, v.videoWidth, v.videoHeight, SRC_MAX_SIDE));
      }

      function stopCamera() {
        cancelAnimationFrame(rafId);
        clearTimeout(liveTimer);
        if (track && torchOn) { try { track.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {} }
        if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
        stream = null; track = null; torchOn = false;
        try { el.video.srcObject = null; } catch (e) {}
      }

      /* ==================================================================
         ETAPA 2 · RECORTE
         ================================================================== */

      function loadSource(canvas, seed) {
        srcCanvas = canvas; srcW = canvas.width; srcH = canvas.height;
        var vs = Math.min(1, 900 / Math.max(srcW, srcH));
        viewCanvas = document.createElement('canvas');
        viewCanvas.width = Math.max(1, Math.round(srcW * vs));
        viewCanvas.height = Math.max(1, Math.round(srcH * vs));
        viewCanvas.getContext('2d').drawImage(canvas, 0, 0, viewCanvas.width, viewCanvas.height);

        var imgData = canvas.getContext('2d').getImageData(0, 0, srcW, srcH);
        busy(true, 'Detectando bordes…');
        return engine.load(imgData).then(function () {
          return engine.detect(seed || null);
        }).then(function (d) {
          if (closed) return;
          quad = d.quad;
          busy(false);
          el.hint.classList.remove('warn');
          el.hint.textContent = d.ok
            ? 'Arrastre las esquinas si el recuadro no calza.'
            : 'No se detectaron bordes con claridad. Ajuste las esquinas.';
          showCrop();
          // La pista que más importa: aquí se decide recortar o no.
        });
      }

      /**
       * El canvas se dibujaba con un búfer de 1 píxel por píxel CSS. En una
       * pantalla de 2.5x eso significa pintar a un tercio de la resolución
       * física y dejar que el navegador lo estire: de ahí el aspecto borroso.
       * Ahora el búfer va a la densidad real y el tamaño CSS se fija aparte.
       */
      function fitStage(w, h) {
        var box = el.stage.getBoundingClientRect();
        var aw = box.width || 320, ah = box.height || 400;
        var cs = Math.min(aw / w, ah / h);
        var dpr = Math.min(2.5, global.devicePixelRatio || 1);
        var cssW = Math.max(1, Math.round(w * cs));
        var cssH = Math.max(1, Math.round(h * cs));
        return {
          s: cs * dpr, dpr: dpr,
          cssW: cssW, cssH: cssH,
          w: Math.max(1, Math.round(cssW * dpr)),
          h: Math.max(1, Math.round(cssH * dpr))
        };
      }

      /** Aplica un resultado de fitStage al canvas del escenario. */
      function applyStageSize(f) {
        el.canvas.width = f.w; el.canvas.height = f.h;
        el.canvas.style.width = f.cssW + 'px';
        el.canvas.style.height = f.cssH + 'px';
      }

      function showCrop() {
        stage = 'crop';
        el.title.textContent = 'Ajustar bordes';
        el.badge.textContent = '';
        el.cam.style.display = 'none';
        el.body.style.display = 'flex';
        el.camfoot.style.display = 'none';
        el.foot.style.display = 'flex';
        el.filters.hidden = true;
        el.strength.hidden = true;
        el.loupe.style.display = 'none';
        btn.back.style.display = (source === 'camera') ? '' : 'none';
        btn.back.textContent = 'Repetir';
        btn.full.style.display = '';
        btn.full.textContent = 'No recortar';
        btn.skip.style.display = 'none';   // la salida cruda ya no se ofrece aquí
        btn.next.style.display = '';
        btn.next.textContent = 'Continuar';
        btn.next.disabled = false;
        var f = fitStage(srcW, srcH);
        view = f;
        applyStageSize(f);
        drawCrop();
      }

      function drawCrop() {
        if (!viewCanvas || stage !== 'crop' || !quad) return;
        var c = el.canvas, ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(viewCanvas, 0, 0, c.width, c.height);
        var pts = quad.map(function (p) { return { x: p.x * view.s, y: p.y * view.s }; });

        ctx.save();
        ctx.fillStyle = 'rgba(6,10,22,.62)';
        ctx.beginPath();
        ctx.rect(0, 0, c.width, c.height);
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var i = 3; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill('evenodd');
        ctx.restore();

        var k = view.dpr || 1;
        ctx.strokeStyle = '#4c9ffe';
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();

        for (i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, (dragIdx === i ? 15 : 12) * k, 0, Math.PI * 2);
          ctx.fillStyle = dragIdx === i ? '#4c9ffe' : 'rgba(76,159,254,.35)';
          ctx.fill();
          ctx.lineWidth = 3 * k; ctx.strokeStyle = '#eaf0f8';
          ctx.stroke();
        }
      }

      function drawLoupe(idx) {
        var lp = el.loupe;
        if (idx < 0) { lp.style.display = 'none'; return; }
        lp.style.display = 'block';
        var k = Math.min(2.5, global.devicePixelRatio || 1);
        var want = Math.round(110 * k);
        if (lp.width !== want) { lp.width = want; lp.height = want; }
        var p = quad[idx], ZOOM = 3, S = lp.width, ctx = lp.getContext('2d');
        var half = S / (2 * ZOOM);
        ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, S, S);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(srcCanvas, p.x - half, p.y - half, half * 2, half * 2, 0, 0, S, S);
        ctx.strokeStyle = '#4c9ffe'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S);
        ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2);
        ctx.stroke();
        var onLeft = (p.x * view.s) > (el.canvas.width / 2);
        lp.style.left = onLeft ? '8px' : 'auto';
        lp.style.right = onLeft ? 'auto' : '8px';
      }

      function localPos(ev) {
        var r = el.canvas.getBoundingClientRect();
        return {
          x: (ev.clientX - r.left) * (el.canvas.width / r.width),
          y: (ev.clientY - r.top) * (el.canvas.height / r.height)
        };
      }
      function onDown(ev) {
        if (stage !== 'crop' || !quad) return;
        var p = localPos(ev), best = -1, bestD = 34 * (view.dpr || 1);
        for (var i = 0; i < 4; i++) {
          var d = Math.hypot(quad[i].x * view.s - p.x, quad[i].y * view.s - p.y);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best < 0) return;
        dragIdx = best;
        if (el.canvas.setPointerCapture) { try { el.canvas.setPointerCapture(ev.pointerId); } catch (e) {} }
        ev.preventDefault();
        drawCrop(); drawLoupe(dragIdx);
      }
      function onMove(ev) {
        if (dragIdx < 0) return;
        var p = localPos(ev);
        quad[dragIdx].x = Math.max(0, Math.min(srcW - 1, p.x / view.s));
        quad[dragIdx].y = Math.max(0, Math.min(srcH - 1, p.y / view.s));
        ev.preventDefault();
        drawCrop(); drawLoupe(dragIdx);
      }
      function onUp() {
        if (dragIdx < 0) return;
        dragIdx = -1; thumbCache = null;
        drawCrop(); drawLoupe(-1);
      }

      /* ==================================================================
         ETAPA 3 · FILTROS
         ================================================================== */

      function showFilters() {
        stage = 'filter';
        el.title.textContent = 'Filtro de escaneo';
        el.filters.hidden = false;
        el.strength.hidden = (filter !== 'bn');
        el.loupe.style.display = 'none';
        btn.back.style.display = '';
        btn.back.textContent = 'Atrás';
        btn.full.style.display = 'none';
        btn.skip.style.display = 'none';
        btn.next.textContent = 'Usar esta imagen';
        renderPreview();
        buildThumbs();
      }

      function paintResult() {
        if (!renderedCanvas) return;
        var f = fitStage(rendered.w, rendered.h);
        view = f;
        applyStageSize(f);
        var ctx = el.canvas.getContext('2d');
        ctx.clearRect(0, 0, f.w, f.h);
        ctx.drawImage(renderedCanvas, 0, 0, f.w, f.h);
      }

      function renderPreview() {
        var token = ++renderToken;
        busy(true, 'Aplicando filtro…');
        el.badge.textContent = '';
        engine.render(quad, filter, strength).then(function (r) {
          if (closed || token !== renderToken) return;
          rendered = r;
          renderedCanvas = imageDataToCanvas(r);
          encoded = encodeCanvas(renderedCanvas, filter);
          paintResult();
          busy(false);
          el.badge.textContent = r.w + '\u00d7' + r.h
            + (encoded ? ' \u00b7 ' + (encoded.mime === 'image/png' ? 'PNG' : 'JPG') + ' ' + fmtBytes(encoded.bytes) : '');
          el.hint.classList.remove('warn');
          el.hint.textContent = 'Elija el filtro que deje montos y fecha más legibles.';
        }).catch(function () {
          if (closed || token !== renderToken) return;
          busy(false);
          // Sin botón de escape visible, el fallo no puede dejar atascado al
          // usuario: se devuelve el control al flujo original del formulario.
          el.hint.textContent = 'No se pudo procesar. Se usará la foto original.';
          setTimeout(function () { finish({ skipped: true }); }, 1400);
        });
      }

      function buildThumbs() {
        if (thumbCache) { paintThumbs(thumbCache); return; }
        engine.thumbs(quad, strength).then(function (items) {
          if (closed) return;
          thumbCache = items.map(function (it) {
            return { filter: it.filter, url: imageDataToCanvas(it).toDataURL('image/jpeg', 0.7) };
          });
          paintThumbs(thumbCache);
        }).catch(function () {});
      }

      function paintThumbs(items) {
        el.filters.innerHTML = '';
        FILTERS.forEach(function (f) {
          var found = items.filter(function (i) { return i.filter === f.id; })[0];
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'scn-chip' + (f.id === filter ? ' on' : '');
          b.innerHTML = (found ? '<img alt="" src="' + found.url + '">' : '<span class="scn-noimg"></span>')
            + '<span>' + f.label + '</span>';
          b.addEventListener('click', function () {
            if (filter === f.id) return;
            filter = f.id;
            el.strength.hidden = (filter !== 'bn');
            Array.prototype.forEach.call(el.filters.children, function (c) { c.classList.remove('on'); });
            b.classList.add('on');
            renderPreview();
          });
          el.filters.appendChild(b);
        });
      }

      function syncStrength() {
        Array.prototype.forEach.call(el.strength.querySelectorAll('[data-str]'), function (b) {
          b.classList.toggle('on', b.getAttribute('data-str') === strength);
        });
      }

      /* ==================================================================
         Cierre y eventos
         ================================================================== */

      function finish(value) {
        if (closed) return;
        closed = true;
        stopCamera();
        try { if (engine) engine.destroy(); } catch (e) {}
        window.removeEventListener('resize', onResize);
        srcCanvas = viewCanvas = renderedCanvas = null;
        rendered = null; thumbCache = null; grabCanvas = null;
        document.body.classList.remove('scn-lock');
        if (root.parentNode) root.parentNode.removeChild(root);
        resolve(value);
      }

      function onResize() {
        if (stage === 'crop' && srcW) {
          var f = fitStage(srcW, srcH); view = f;
          applyStageSize(f);
          drawCrop();
        } else if (stage === 'filter') paintResult();
      }

      el.canvas.addEventListener('pointerdown', onDown, { passive: false });
      el.canvas.addEventListener('pointermove', onMove, { passive: false });
      el.canvas.addEventListener('pointerup', onUp);
      el.canvas.addEventListener('pointercancel', onUp);
      window.addEventListener('resize', onResize);

      btn.cancel.addEventListener('click', function () { finish(null); });
      btn.shot.addEventListener('click', function () { doCapture(); });
      btn.torch.addEventListener('click', toggleTorch);
      btn.auto.addEventListener('click', function () { autoCapture = !autoCapture; syncAuto(); });
      btn.skip.addEventListener('click', function () {
        if (stage === 'camera') finish({ needFile: true });
        else finish({ skipped: true });
      });
      btn.back.addEventListener('click', function () {
        if (stage === 'filter') { showCrop(); return; }
        if (stage === 'crop' && source === 'camera') {
          capturing = false; stableHits = 0; liveSmoothed = null; liveOk = false;
          quad = null; srcCanvas = null; viewCanvas = null;
          startCamera();
        }
      });
      /* Quien pulsa "No recortar" ya decidió no ajustar esquinas: se salta la
         confirmación del recorte y pasa directo a los filtros. La imagen sigue
         pasando por el aplanado de iluminación y el B/N, así que el resultado
         es legible aunque no esté recortado. */
      btn.full.addEventListener('click', function () {
        quad = [{ x: 0, y: 0 }, { x: srcW - 1, y: 0 }, { x: srcW - 1, y: srcH - 1 }, { x: 0, y: srcH - 1 }];
        thumbCache = null;
        showFilters();
      });
      btn.next.addEventListener('click', function () {
        if (stage === 'crop') { showFilters(); return; }
        if (!encoded) return;
        finish({ dataUrl: encoded.dataUrl, mime: encoded.mime, bytes: encoded.bytes, w: rendered.w, h: rendered.h });
      });
      el.strength.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest && ev.target.closest('[data-str]');
        if (!b) return;
        var v = b.getAttribute('data-str');
        if (v === strength) return;
        strength = v; syncStrength(); thumbCache = null;
        renderPreview(); buildThumbs();
      });

      /* ---------------- arranque ----------------
         El modal nace NEUTRO: sin escenario de recorte y sin pie de botones.
         Antes se mostraba el cuerpo y el pie por defecto, así que durante un
         par de fotogramas se veían "No recortar" y "Continuar" hasta que
         startCamera() reordenaba la interfaz. Cada etapa enciende ahora lo
         que le toca; aquí solo se muestra el indicador de carga. */
      syncStrength();
      el.cam.style.display = 'none';
      el.body.style.display = 'flex';
      el.camfoot.style.display = 'none';
      el.foot.style.display = 'none';
      btn.back.style.display = 'none';
      btn.full.style.display = 'none';
      btn.skip.style.display = 'none';
      btn.next.style.display = 'none';
      busy(true, 'Iniciando…');

      createEngine().then(function (eng) {
        if (closed) return null;
        engine = eng;
        if (source === 'camera') { busy(false); startCamera(); return null; }
        busy(true, 'Abriendo imagen…');
        return decodeToCanvas(source, SRC_MAX_SIDE).then(loadSource);
      }).catch(function () {
        if (closed) return;
        busy(false);
        el.hint.textContent = 'No se pudo abrir la imagen. Se usará la foto original.';
        btn.next.disabled = true;
        setTimeout(function () { finish({ skipped: true }); }, 1400);
      });
    });
  }

  /* ======================================================================
     Aviso previo de la función de recorte
     ---------------------------------------------------------------------
     Se muestra ANTES de abrir la cámara o la galería, una sola vez por
     dispositivo. La API es por callback y no por promesa a propósito: en el
     caso "ya visto" el callback se invoca de forma síncrona, para no romper
     el gesto del usuario que necesita input.click() en Android.
     ====================================================================== */
  var INTRO_KEY = 'intro';

  function introVisto() { return coachSeen(INTRO_KEY); }

  function showIntro(cb) {
    var orig = cb;
    var usado = false;
    cb = function () { if (usado) return; usado = true; if (typeof orig === 'function') orig(); };
    if (introVisto()) { cb(); return; }      // síncrono: conserva el gesto
    ensureCss().then(function () { pintarIntro(cb); });
  }

  function pintarIntro(cb) {

    var root = document.createElement('div');
    root.className = 'scn-intro';
    /* Estilos críticos en línea: si scanner.css no llegara (red caída, CDN
       lento), la tarjeta se sigue posicionando y el botón sigue siendo
       alcanzable. Sin esto quedaría como un div suelto al final de la página
       con el scroll del body bloqueado. */
    root.setAttribute('style',
      'position:fixed;inset:0;z-index:100020;background:rgba(4,10,24,.80);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;');
    root.innerHTML = ''
      /* Estilos mínimos en línea como respaldo: si scanner.css no llegara
         dentro del tope, la tarjeta sigue siendo legible y usable en vez de
         quedar como texto suelto a lo ancho de la pantalla. */
      + '<div class="scn-intro-card" role="dialog" aria-modal="true"'
      + '     style="background:#111c33;color:#eaf0f8;border-radius:16px;'
      + '            padding:20px;width:100%;max-width:330px;text-align:center;'
      + '            box-sizing:border-box">'
      + '  <div class="scn-intro-tag">Nuevo</div>'
      + '  <div class="scn-demo" aria-hidden="true">'
      + '    <div class="scn-demo-doc">'
      + '      <span></span><span></span><span></span><span></span><span></span><span></span>'
      + '      <i class="c tl"></i><i class="c tr"></i><i class="c br"></i><i class="c bl"></i>'
      + '    </div>'
      + '  </div>'
      + '  <h3>Recorte de facturas</h3>'
      + '  <p>Los bordes de la factura se detectan solos. Si el recuadro no calza, '
      + '     arrastre los puntos para ajustarlo a mano.</p>'
      + '  <p class="scn-intro-sub">Recortar deja los montos y la fecha mucho más legibles.</p>'
      + '  <button type="button" class="scn-intro-ok"'
      + '          style="width:100%;margin-top:14px;padding:13px 10px;border:0;'
      + '                 border-radius:10px;background:#4c9ffe;color:#06122a;'
      + '                 font-weight:700;font-size:15px">Entendido</button>'
      + '</div>';
    document.body.appendChild(root);
    document.body.classList.add('scn-lock');

    var listo = false;
    function cerrar() {
      if (listo) return;
      listo = true;
      coachMark(INTRO_KEY);
      document.body.classList.remove('scn-lock');
      if (root.parentNode) root.parentNode.removeChild(root);
      cb();                                  // el clic en Entendido es el gesto
    }
    var okBtn = root.querySelector('.scn-intro-ok');

    /* Confirmación táctil: la clase se aplica en pointerdown para que el
       hundido se vea de inmediato, sin esperar al click. Se retiene un
       instante para que el gesto se perciba aunque el toque sea muy rápido. */
    okBtn.addEventListener('pointerdown', function () {
      okBtn.classList.add('pressed');
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      okBtn.addEventListener(ev, function () {
        setTimeout(function () { okBtn.classList.remove('pressed'); }, 90);
      });
    });

    // Envuelto en una función: 'cerrar' se reasigna más abajo y hay que
    // resolverlo en tiempo de ejecución, no capturar la referencia vieja.
    okBtn.addEventListener('click', function () {
      okBtn.classList.add('pressed');
      // 110 ms de retención: el usuario alcanza a ver que el botón respondió
      setTimeout(function () { cerrar(); }, 110);
    });

    /* El cierre por toque fuera se retiró a propósito: un roce accidental
       descartaba el aviso sin leerlo y quedaba marcado como visto para
       siempre. La única salida deliberada es "Entendido"; Escape se conserva
       porque exige teclado físico y no ocurre por accidente. El tope de
       seguridad libera el scroll aunque el aviso siguiera en pantalla. */
    var onEsc = function (ev) {
      if (ev.key === 'Escape' || ev.keyCode === 27) cerrar();
    };
    document.addEventListener('keydown', onEsc);
    var soltar = setTimeout(function () {
      document.body.classList.remove('scn-lock');
    }, 20000);

    var cerrarOriginal = cerrar;
    cerrar = function () {
      clearTimeout(soltar);
      document.removeEventListener('keydown', onEsc);
      cerrarOriginal();
    };
  }

  global.FacturaScanner = {
    VERSION: VER,
    base: BASE,
    hasCamera: function () {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
                && (global.isSecureContext !== false));
    },
    intro: showIntro,
    introSeen: introVisto,
    openCamera: function () {
      return ensureCss().then(function () { return openScanner('camera'); });
    },
    open: function (file) {
      return ensureCss().then(function () { return openScanner(file); });
    }
  };

})(window);
