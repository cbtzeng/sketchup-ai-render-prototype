/*
  app.js — Architech Render 面板前端
  ---------------------------------------------------------------------------
  無框架、無 CDN。所有跟 Ruby 的往來都經過同一個 envelope：

      送出   window.sketchup.architech(JSON.stringify({id, action, params}))
      收回   window.ArchitechBridge.__resolve(jsonString)   // {ok, data|code+message, id}
      推播   window.ArchitechBridge.__event(jsonString)     // {event, data}
      分塊   window.ArchitechBridge.__chunk(token, i, n, part, method)

  Ruby 送進 execute_script 的永遠是「一個 JS 字串字面值」，由這裡 JSON.parse，
  不是一段可執行的程式碼。反方向也一樣——bridge.rb 只查路由表，不 eval。

  沒有 window.sketchup 時（例如直接用瀏覽器打開這個檔案檢查版面）自動改走
  MockBridge，資料形狀與 Ruby 完全一致。
*/
'use strict';

(function () {

  /* =======================================================================
     Bridge client
     ======================================================================= */

  var pending = Object.create(null);
  var seq = 0;
  var listeners = Object.create(null);
  var chunks = Object.create(null);

  function deliver(method, text) {
    var msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      showError('UI-01', 'Malformed message from the plugin.', String(e));
      return;
    }
    if (method === '__event') {
      dispatchEvent(msg.event, msg.data);
    } else {
      var entry = pending[msg.id];
      if (!entry) { return; }
      delete pending[msg.id];
      entry(msg);
    }
  }

  window.ArchitechBridge = {
    __resolve: function (text) { deliver('__resolve', text); },
    __event: function (text) { deliver('__event', text); },
    // 分塊重組。Ruby 只在單次酬載超過保守上限時才用這條路。
    __chunk: function (token, index, total, part, method) {
      var buf = chunks[token] || (chunks[token] = new Array(total));
      buf[index] = part;
      for (var i = 0; i < total; i++) {
        if (typeof buf[i] !== 'string') { return; }
      }
      delete chunks[token];
      deliver(method, buf.join(''));
    }
  };

  function dispatchEvent(name, data) {
    (listeners[name] || []).forEach(function (fn) { fn(data); });
  }

  function on(name, fn) {
    (listeners[name] || (listeners[name] = [])).push(fn);
  }

  var HAS_SKETCHUP = !!(window.sketchup && typeof window.sketchup.architech === 'function');

  // 回傳 Promise。失敗時 reject 一個 {code, message, detail} —— 呼叫端不需要
  // 分辨「Ruby 例外」與「驗證失敗」，兩者形狀一樣。
  var CALL_TIMEOUT_MS = 20000;

  function call(action, params) {
    return new Promise(function (resolve, reject) {
      var id = 'c' + (++seq);
      // 逾時保護：如果 Ruby 連 envelope 都解不出來，它就不知道 id，
      // 也就永遠回不了這一筆。沒有逾時的話面板會靜靜地掛住 —— 那是最糟的失敗。
      var timer = setTimeout(function () {
        if (!pending[id]) { return; }
        delete pending[id];
        reject({ code: 'UI-08', message: 'No response from the plugin for "' + action +
          '" after ' + (CALL_TIMEOUT_MS / 1000) + 's.' });
      }, CALL_TIMEOUT_MS);

      pending[id] = function (msg) {
        clearTimeout(timer);
        if (msg && msg.ok) { resolve(msg.data); }
        else { reject(msg || { code: 'UI-08', message: 'empty response' }); }
      };
      var envelope = JSON.stringify({ id: id, action: action, params: params || {} });
      if (HAS_SKETCHUP) {
        try {
          window.sketchup.architech(envelope);
        } catch (e) {
          delete pending[id];
          reject({ code: 'UI-08', message: String(e) });
        }
      } else {
        MockBridge.handle(id, action, params || {});
      }
    });
  }

  /* =======================================================================
     Mock backend —— 只在瀏覽器單獨開啟時使用
     形狀必須跟 bridge.rb 的路由一模一樣，否則檢查版面時看到的不是真的。
     ======================================================================= */

  var MockBridge = (function () {
    var VIEWPORT = { width: 1512, height: 849 }; // Phase 0 實測值
    var render = null;
    var timers = [];

    function placeholder(label, hue, ratio) {
      var w = 640, h = Math.round(640 / (ratio || 1));
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<rect width="100%" height="100%" fill="hsl(' + hue + ',22%,62%)"/>' +
        '<rect x="8%" y="42%" width="38%" height="46%" fill="hsl(' + hue + ',20%,44%)"/>' +
        '<rect x="52%" y="26%" width="34%" height="62%" fill="hsl(' + hue + ',18%,52%)"/>' +
        '<rect x="0" y="88%" width="100%" height="12%" fill="hsl(' + hue + ',14%,34%)"/>' +
        '<text x="50%" y="16%" text-anchor="middle" font-family="monospace" font-size="26" ' +
        'fill="#ffffff">' + label + '</text></svg>';
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    function plan(longEdge, aspect) {
      longEdge = Math.max(256, Math.min(1536, parseInt(longEdge, 10) || 1024));
      var vpAspect = VIEWPORT.width / VIEWPORT.height;
      var outAspect = aspect === 'viewport' ? vpAspect : 1.0;
      var width, height;
      if (outAspect >= 1) { width = longEdge; height = Math.round(longEdge / outAspect); }
      else { height = longEdge; width = Math.round(longEdge * outAspect); }
      var ratio = (width / height) / vpAspect;
      return {
        width: width, height: height,
        viewport_aspect: round4(vpAspect),
        output_aspect: round4(width / height),
        visible_width_ratio: round4(ratio),
        crop_percent: Math.round((1 - ratio) * 1000) / 10,
        cropped: ratio < 0.999,
        aspect: aspect || 'square',
        long_edge: longEdge
      };
    }

    function round4(n) { return Math.round(n * 10000) / 10000; }

    function estimate(w, h) {
      var mp = (w * h) / 1000000;
      return {
        cost_cents: Math.round((1.5 + 6.0 * mp) * 10) / 10,
        seconds_p50: Math.round(12 + 26 * mp),
        seconds_p95: Math.round(30 + 60 * mp),
        source: 'local_stub'
      };
    }

    function step(delay, fn) {
      timers.push(setTimeout(fn, delay));
    }

    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    function status() {
      if (!render) { return { state: 'idle', elapsed_ms: 0 }; }
      return {
        state: render.state,
        step: render.step,
        total: render.total,
        label: render.label,
        elapsed_ms: Date.now() - render.startedAt,
        job_id: render.jobId,
        assets: render.assets,
        result: render.result,
        error: render.error
      };
    }

    function setState(state, label, stepN, total) {
      if (!render) { return; }
      render.state = state;
      render.label = label || null;
      render.step = stepN || null;
      render.total = total || null;
      dispatchEvent('status', status());
    }

    var ROUTES = {
      'ui.ready': function () {
        var p = plan(1024, 'square');
        return {
          protocol: 1,
          host: 'browser',
          backend: 'stub',
          capture: 'stub',
          sketchup_version: null,
          preview_transport: 'path',
          limits: { max_long_edge: 1536, min_long_edge: 256 },
          presets: ['exterior', 'interior', 'dusk'],
          aspects: ['square', 'viewport'],
          defaults: { preset: 'exterior', fidelity: 0.6, long_edge: 1024, aspect: 'square' },
          viewport: VIEWPORT,
          plan: p,
          estimate: estimate(p.width, p.height),
          passes: ['beauty', 'edge', 'depth'],
          pending_jobs: [],
          codes: {}
        };
      },
      'plan.preview': function (params) {
        var p = plan(params.long_edge, params.aspect);
        return { plan: p, viewport: VIEWPORT, estimate: estimate(p.width, p.height) };
      },
      'render.start': function (params) {
        if (!String(params.prompt || '').trim()) {
          throw { code: 'UI-04', message: 'prompt is empty' };
        }
        if (render && ['succeeded', 'failed', 'cancelled'].indexOf(render.state) < 0) {
          throw { code: 'UI-09', message: 'a render is already running' };
        }
        var p = plan(params.long_edge, params.aspect);
        render = {
          state: 'capturing', startedAt: Date.now(), jobId: null,
          assets: {}, result: null, error: null, plan: p
        };
        clearTimers();
        step(300, function () { setState('capturing', 'Capturing 1/3 (beauty)', 1, 3); });
        step(900, function () { setState('capturing', 'Capturing 2/3 (hidden-line)', 2, 3); });
        step(1500, function () {
          render.assets.beauty = {
            key: 'beauty', url: placeholder('beauty capture', 210, p.width / p.height),
            path: '/tmp/architech/beauty.png', bytes: 0
          };
          setState('capturing', 'Capturing 3/3 (fog depth)', 3, 3);
        });
        step(2100, function () { setState('uploading', 'Uploading control images'); });
        step(3000, function () { render.jobId = 'stub-demo'; setState('queued', 'Queued'); });
        step(4200, function () { setState('running', 'Rendering'); });
        step(7000, function () {
          render.result = {
            key: 'result', url: placeholder('rendered result', 28, p.width / p.height), stub: true
          };
          setState('succeeded', 'Done');
        });
        return { accepted: true, state: 'capturing', request: params };
      },
      'render.cancel': function () {
        clearTimers();
        if (render) { setState('cancelled', 'Cancelled'); }
        return { state: 'cancelled', server_cancel: false };
      },
      'render.status': status,
      'image.data': function () {
        throw { code: 'UI-04', message: 'no image keys in mock mode' };
      },
      'system.reveal': function () {
        throw { code: 'UI-06', message: 'UI.openURL is not available in a browser' };
      },
      'ui.log': function () { return { logged: true }; },
      'diag.dump': function () {
        return {
          entries: [], routes: Object.keys(ROUTES).sort(),
          transport: {
            preview: 'path', chunking: true, max_script_chars: 262144,
            chunk_chars: 65536, max_total_chars: 8388608, verified: false
          }
        };
      },
      'dialog.close': function () { return { closed: true }; }
    };

    return {
      handle: function (id, action, params) {
        setTimeout(function () {
          var fn = ROUTES[action];
          if (!fn) {
            deliver('__resolve', JSON.stringify(
              { ok: false, code: 'UI-03', message: 'unknown action: ' + action, id: id }));
            return;
          }
          try {
            deliver('__resolve', JSON.stringify({ ok: true, data: fn(params), id: id }));
          } catch (e) {
            deliver('__resolve', JSON.stringify({
              ok: false, id: id,
              code: e.code || 'UI-08',
              message: e.message || String(e)
            }));
          }
        }, 40);
      }
    };
  }());

  /* =======================================================================
     DOM
     ======================================================================= */

  function $(id) { return document.getElementById(id); }

  var el = {
    backendBadge: $('backend-badge'),
    errorBanner: $('error-banner'),
    errorCode: $('error-code'),
    errorMessage: $('error-message'),
    errorDetail: $('error-detail'),
    errorDismiss: $('error-dismiss'),
    prompt: $('prompt'),
    presetGroup: $('preset-group'),
    fidelity: $('fidelity'),
    fidelityOut: $('fidelity-out'),
    fidelityHint: $('fidelity-hint'),
    longEdge: $('long-edge'),
    aspectGroup: $('aspect-group'),
    dimsOut: $('dims-out'),
    cropFigure: $('crop-figure'),
    cropNote: $('crop-note'),
    cropBadge: $('crop-badge'),
    estCost: $('est-cost'),
    estTime: $('est-time'),
    estSource: $('est-source'),
    btnRender: $('btn-render'),
    btnCancel: $('btn-cancel'),
    statusCard: $('status-card'),
    statusLabel: $('status-label'),
    statusElapsed: $('status-elapsed'),
    statusFill: $('status-fill'),
    statusJob: $('status-job'),
    phaseList: $('phase-list'),
    resultCard: $('result-card'),
    compare: $('compare'),
    compareClip: $('compare-clip'),
    compareHandle: $('compare-handle'),
    compareRange: $('compare-range'),
    imgBefore: $('img-before'),
    imgAfter: $('img-after'),
    btnReveal: $('btn-reveal'),
    btnDiag: $('btn-diag'),
    btnDiagClose: $('btn-diag-close'),
    diagCard: $('diag-card'),
    diagList: $('diag-list'),
    diagLog: $('diag-log'),
    toggleBase64: $('toggle-base64')
  };

  var state = {
    boot: null,
    preset: 'exterior',
    aspect: 'square',
    fidelity: 0.6,
    longEdge: 1024,
    plan: null,
    status: { state: 'idle', elapsed_ms: 0 },
    elapsedTimer: null,
    localStart: null,
    previewTransport: 'path'
  };

  var PHASES = ['capturing', 'uploading', 'queued', 'running'];
  var BUSY_STATES = ['capturing', 'uploading', 'queued', 'running', 'retrying'];

  /* =======================================================================
     裁切框預覽
     ---------------------------------------------------------------------
     journal 002：write_image 的取景只由 width/height 決定，垂直 FOV 固定，
     所以輸出與 viewport 的**高度視野一律相同**，差別只在水平。
       visible_width_ratio < 1 → 使用者看得到但不會出現在輸出裡（水平被裁）
       visible_width_ratio > 1 → 輸出會包含目前看不到的東西
     兩種情形高度相同，所以兩個框只在水平方向有落差 —— 圖就這樣畫。
     ======================================================================= */

  function drawCropFigure(plan, viewport) {
    var r = plan.visible_width_ratio;
    var W = 320, vpW, outW, H;

    if (r <= 1) {
      vpW = W;
      outW = W * r;
      H = W / plan.viewport_aspect;
    } else {
      outW = W;
      vpW = W / r;
      H = W / plan.output_aspect;
    }

    var pad = 16;
    var svgW = W + pad * 2;
    var svgH = H + pad * 2 + 14;
    var vpX = pad + (W - vpW) / 2;
    var outX = pad + (W - outW) / 2;
    var y = pad;

    var parts = [];
    parts.push('<svg viewBox="0 0 ' + svgW + ' ' + fmt(svgH) + '" ' +
      'role="img" aria-label="Output framing versus SketchUp viewport">');

    // 斜線填滿：被裁掉的區域。用 pattern 而不是半透明色塊，
    // 深淺色主題下都看得出來是「不會被算進去的區域」。
    parts.push('<defs><pattern id="hatch" width="6" height="6" ' +
      'patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<line x1="0" y1="0" x2="0" y2="6" stroke="var(--crop-out)" ' +
      'stroke-width="1.4" opacity="0.55"/></pattern></defs>');

    // viewport 框
    parts.push(rect(vpX, y, vpW, H, 'none', 'var(--border-strong)', 1, '4 3'));

    if (r < 0.999) {
      // 左右兩塊被裁掉
      parts.push(rect(vpX, y, outX - vpX, H, 'url(#hatch)', 'none', 0));
      parts.push(rect(outX + outW, y, (vpX + vpW) - (outX + outW), H, 'url(#hatch)', 'none', 0));
    } else if (r > 1.001) {
      // 輸出比 viewport 寬：多出來的部分是使用者現在看不到的
      parts.push(rect(outX, y, vpX - outX, H, 'url(#hatch)', 'none', 0));
      parts.push(rect(vpX + vpW, y, (outX + outW) - (vpX + vpW), H, 'url(#hatch)', 'none', 0));
    }

    // 輸出框（實線、強調色）
    parts.push(rect(outX, y, outW, H, 'none', 'var(--crop-in)', 2));

    parts.push('<text class="crop-label" x="' + fmt(pad) + '" y="' + fmt(y + H + 11) + '">' +
      'viewport ' + viewport.width + '×' + viewport.height + '</text>');
    parts.push('<text class="crop-label crop-label-in" text-anchor="end" x="' +
      fmt(svgW - pad) + '" y="' + fmt(y + H + 11) + '">' +
      'output ' + plan.width + '×' + plan.height + '</text>');
    parts.push('</svg>');

    el.cropFigure.innerHTML = parts.join('');
  }

  function rect(x, y, w, h, fill, stroke, sw, dash) {
    if (w <= 0.5) { return ''; }
    return '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) +
      '" height="' + fmt(h) + '" fill="' + fill + '" stroke="' + (stroke || 'none') +
      '" stroke-width="' + (sw || 0) + '"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
  }

  function fmt(n) { return Math.round(n * 100) / 100; }

  function renderPlan(plan, viewport) {
    state.plan = plan;
    el.dimsOut.textContent = plan.width + ' × ' + plan.height;
    drawCropFigure(plan, viewport);

    if (plan.crop_percent > 0.1) {
      el.cropBadge.hidden = false;
      el.cropBadge.textContent = plan.crop_percent + '% cropped';
      el.cropNote.textContent =
        'The output is narrower than your viewport: about ' + plan.crop_percent +
        '% of what you see horizontally will not be rendered. Vertical framing is unchanged.';
    } else if (plan.crop_percent < -0.1) {
      el.cropBadge.hidden = false;
      el.cropBadge.textContent = Math.abs(plan.crop_percent) + '% wider';
      el.cropNote.textContent =
        'The output is wider than your viewport, so it will include geometry you cannot ' +
        'currently see on either side. Vertical framing is unchanged.';
    } else {
      el.cropBadge.hidden = true;
      el.cropNote.textContent = 'The output matches your viewport framing.';
    }

    el.compare.style.aspectRatio = plan.width + ' / ' + plan.height;
  }

  function renderEstimate(est) {
    el.estCost.textContent = '$' + (est.cost_cents / 100).toFixed(3).replace(/0$/, '');
    el.estTime.textContent = '~' + est.seconds_p50 + 's';
    el.estSource.textContent = est.source === 'cloud'
      ? 'Estimate from the server pricing table. p95 ~' + est.seconds_p95 + 's.'
      : 'Rough local estimate only — the server pricing table is not connected yet. ' +
        'p95 ~' + est.seconds_p95 + 's.';
  }

  var FIDELITY_HINTS = [
    [0.25, 'Loose: the model may reinterpret massing and openings.'],
    [0.55, 'Balanced: silhouette and openings preserved, surfaces free.'],
    [0.8, 'Faithful: edges and depth strongly constrain the result.'],
    [1.01, 'Locked: closest to your geometry, least creative freedom.']
  ];

  function renderFidelity() {
    el.fidelityOut.textContent = state.fidelity.toFixed(2);
    for (var i = 0; i < FIDELITY_HINTS.length; i++) {
      if (state.fidelity < FIDELITY_HINTS[i][0]) {
        el.fidelityHint.textContent = FIDELITY_HINTS[i][1];
        return;
      }
    }
  }

  /* =======================================================================
     狀態列
     ======================================================================= */

  function renderStatus(s) {
    state.status = s || { state: 'idle', elapsed_ms: 0 };
    var st = state.status.state;
    var busy = BUSY_STATES.indexOf(st) >= 0;

    el.statusCard.hidden = (st === 'idle');
    el.btnRender.disabled = busy;
    el.btnCancel.hidden = !busy;
    el.btnRender.textContent = (st === 'succeeded' || st === 'failed') ? 'Render again' : 'Render';

    el.statusLabel.textContent = state.status.label ||
      st.charAt(0).toUpperCase() + st.slice(1);

    var idx = PHASES.indexOf(st);
    Array.prototype.forEach.call(el.phaseList.children, function (li, i) {
      li.classList.toggle('is-active', i === idx);
      li.classList.toggle('is-done', idx < 0 ? st === 'succeeded' : i < idx);
    });

    var pct = 0;
    if (st === 'succeeded') { pct = 100; }
    else if (idx >= 0) {
      pct = ((idx + 1) / (PHASES.length + 1)) * 100;
      if (st === 'capturing' && state.status.total) {
        pct = (state.status.step / state.status.total) * (100 / (PHASES.length + 1));
      }
    }
    el.statusFill.style.width = pct + '%';
    el.statusFill.classList.toggle('is-error', st === 'failed');
    el.statusFill.classList.toggle('is-done', st === 'succeeded');

    el.statusJob.hidden = !state.status.job_id;
    if (state.status.job_id) { el.statusJob.textContent = 'job ' + state.status.job_id; }

    if (busy) { startElapsed(state.status.elapsed_ms); } else { stopElapsed(); }
    if (!busy && typeof state.status.elapsed_ms === 'number') {
      el.statusElapsed.textContent = (state.status.elapsed_ms / 1000).toFixed(1) + 's';
    }

    if (state.status.error) {
      showError(state.status.error.code, state.status.error.message, state.status.error.detail);
    }
    if (st === 'succeeded') { showResult(state.status); }
  }

  // elapsed 由前端自己跑，不靠 Ruby 每秒推播 —— 主 UI 執行緒不該為了
  // 一個計時器被反覆打擾（spec F4：主執行緒阻塞 <= 500ms）。
  function startElapsed(baseMs) {
    stopElapsed();
    state.localStart = Date.now() - (baseMs || 0);
    state.elapsedTimer = setInterval(function () {
      el.statusElapsed.textContent = ((Date.now() - state.localStart) / 1000).toFixed(1) + 's';
    }, 100);
  }

  function stopElapsed() {
    if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
  }

  /* =======================================================================
     結果與對比
     ======================================================================= */

  function showResult(s) {
    var beauty = s.assets && s.assets.beauty;
    var result = s.result;
    if (!result) { return; }

    el.resultCard.hidden = false;
    setImage(el.imgBefore, beauty, 'capture unavailable');
    setImage(el.imgAfter, result, 'result not available (stub backend)');
    setCompare(el.compareRange.value);
  }

  // 預設用本機檔案路徑（file://），酬載完全不進橋接。
  // 載入失敗時才退回 base64 —— 這是實測未做之前唯一負責任的順序。
  function setImage(img, asset, fallbackText) {
    if (!asset || !asset.url) {
      img.removeAttribute('src');
      img.alt = fallbackText;
      img.style.background = 'var(--surface-2)';
      return;
    }
    img.alt = asset.key || '';
    img.style.background = '';

    function viaBase64(reason) {
      if (!asset.key) { return; }
      log(reason + ' — loading "' + asset.key + '" as base64');
      call('image.data', { key: asset.key }).then(function (data) {
        img.src = 'data:' + data.mime + ';base64,' + data.base64;
      }).catch(function (err) {
        img.removeAttribute('src');
        img.alt = fallbackText;
        img.style.background = 'var(--surface-2)';
        showError(err.code, 'Preview could not be loaded: ' + err.message, err.detail);
      });
    }

    if (state.previewTransport === 'base64') {
      viaBase64('base64 transport selected');
      return;
    }

    img.onerror = function () {
      img.onerror = null;
      viaBase64('file:// preview failed');
    };
    img.src = asset.url;
  }

  function setCompare(value) {
    var pct = Math.max(0, Math.min(100, Number(value)));
    el.compareClip.style.clipPath = 'inset(0 0 0 ' + pct + '%)';
    el.compareHandle.style.left = pct + '%';
  }

  /* =======================================================================
     錯誤
     ======================================================================= */

  function showError(code, message, detail) {
    el.errorBanner.hidden = false;
    el.errorCode.textContent = code || 'UI-08';
    el.errorMessage.textContent = message || 'Unknown error.';
    if (detail) {
      el.errorDetail.hidden = false;
      el.errorDetail.textContent =
        typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    } else {
      el.errorDetail.hidden = true;
    }
  }

  function clearError() { el.errorBanner.hidden = true; }

  function log(message) {
    var line = new Date().toISOString().slice(11, 19) + '  ' + message;
    el.diagLog.textContent = (line + '\n' + el.diagLog.textContent).slice(0, 4000);
    call('ui.log', { message: message }).catch(function () { /* 日誌失敗不該蓋掉真正的錯誤 */ });
  }

  /* =======================================================================
     Wiring
     ======================================================================= */

  function segmented(group, onPick) {
    group.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.seg');
      if (!btn) { return; }
      Array.prototype.forEach.call(group.querySelectorAll('.seg'), function (b) {
        b.setAttribute('aria-checked', String(b === btn));
      });
      onPick(btn.getAttribute('data-value'));
    });
  }

  var refreshTimer = null;
  function refreshPlan() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      call('plan.preview', {
        long_edge: state.longEdge,
        aspect: state.aspect,
        preset: state.preset,
        fidelity: state.fidelity
      }).then(function (data) {
        renderPlan(data.plan, data.viewport);
        renderEstimate(data.estimate);
      }).catch(function (err) {
        showError(err.code, err.message, err.detail);
      });
    }, 80);
  }

  segmented(el.presetGroup, function (v) { state.preset = v; refreshPlan(); });
  segmented(el.aspectGroup, function (v) { state.aspect = v; refreshPlan(); });

  el.longEdge.addEventListener('change', function () {
    state.longEdge = parseInt(el.longEdge.value, 10);
    refreshPlan();
  });

  el.fidelity.addEventListener('input', function () {
    state.fidelity = Number(el.fidelity.value);
    renderFidelity();
  });
  el.fidelity.addEventListener('change', refreshPlan);

  el.compareRange.addEventListener('input', function () { setCompare(el.compareRange.value); });

  el.btnRender.addEventListener('click', function () {
    clearError();
    el.resultCard.hidden = true;
    call('render.start', {
      prompt: el.prompt.value,
      preset: state.preset,
      fidelity: state.fidelity,
      long_edge: state.longEdge,
      aspect: state.aspect
    }).then(function (data) {
      renderStatus({ state: data.state, elapsed_ms: 0, label: 'Starting' });
    }).catch(function (err) {
      showError(err.code, err.message, err.detail);
      renderStatus({ state: 'idle', elapsed_ms: 0 });
    });
  });

  el.btnCancel.addEventListener('click', function () {
    call('render.cancel', {}).then(function (data) {
      if (!data.server_cancel) {
        log('cancel is local only — no server job to cancel');
      }
    }).catch(function (err) { showError(err.code, err.message, err.detail); });
  });

  el.btnReveal.addEventListener('click', function () {
    call('system.reveal', { key: 'beauty' }).catch(function (err) {
      showError(err.code, err.message, err.detail);
    });
  });

  el.errorDismiss.addEventListener('click', clearError);
  el.btnDiag.addEventListener('click', function () {
    el.diagCard.hidden = !el.diagCard.hidden;
    if (!el.diagCard.hidden) { refreshDiag(); }
  });
  el.btnDiagClose.addEventListener('click', function () { el.diagCard.hidden = true; });

  // base64 只是備案。切換只影響前端優先順序 —— Ruby 端的 image.data
  // 本來就在，不需要重載面板。
  el.toggleBase64.addEventListener('change', function () {
    state.previewTransport = el.toggleBase64.checked ? 'base64' : 'path';
    log('preview transport set to ' + state.previewTransport);
    if (state.status && state.status.state === 'succeeded') { showResult(state.status); }
  });

  function refreshDiag() {
    call('diag.dump', {}).then(function (data) {
      var t = data.transport || {};
      var rows = [
        ['host', state.boot ? state.boot.host : '?'],
        ['backend', state.boot ? state.boot.backend : '?'],
        ['capture', state.boot ? state.boot.capture : '?'],
        ['sketchup', (state.boot && state.boot.sketchup_version) || 'n/a'],
        ['preview', t.preview],
        ['chunking', String(t.chunking)],
        ['max script', t.max_script_chars + ' chars'],
        ['chunk size', t.chunk_chars + ' chars'],
        ['limits verified', t.verified ? 'yes' : 'NO — conservative guess'],
        ['routes', (data.routes || []).join(', ')]
      ];
      el.diagList.innerHTML = rows.map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(String(r[1])) + '</dd>';
      }).join('');
    }).catch(function (err) { showError(err.code, err.message, err.detail); });
  }

  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* =======================================================================
     Boot
     ======================================================================= */

  on('status', renderStatus);
  on('fatal', function (d) { showError(d.code, d.message); });

  call('ui.ready', {}).then(function (boot) {
    state.boot = boot;
    state.preset = boot.defaults.preset;
    state.aspect = boot.defaults.aspect;
    state.fidelity = boot.defaults.fidelity;
    state.longEdge = boot.defaults.long_edge;
    state.previewTransport = boot.preview_transport;

    el.fidelity.value = String(state.fidelity);
    el.longEdge.value = String(state.longEdge);
    el.toggleBase64.checked = (boot.preview_transport === 'base64');
    renderFidelity();
    renderPlan(boot.plan, boot.viewport);
    renderEstimate(boot.estimate);

    var live = boot.backend === 'cloud';
    el.backendBadge.textContent = live ? 'live' : 'demo backend';
    el.backendBadge.className = 'badge ' + (live ? 'badge-ok' : 'badge-warn');
    el.backendBadge.title = live
      ? 'Connected to the render service.'
      : 'No render service connected. Capture and UI are real; job status is simulated.';

    if (boot.pending_jobs && boot.pending_jobs.length) {
      log(boot.pending_jobs.length + ' job(s) still running from a previous session');
    }
  }).catch(function (err) {
    showError(err.code || 'UI-08', 'Panel failed to start: ' +
      (err.message || 'unknown'), err.detail);
  });

}());
