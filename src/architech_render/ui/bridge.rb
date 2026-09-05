# frozen_string_literal: true

require 'json'

module ArchitechRender
  # ⚠️ 命名陷阱：這個 module 叫 `UI`，會在 ArchitechRender 的詞法範圍內
  # 遮蔽 SketchUp 的頂層 `::UI`。本檔案與 ui/dialog.rb 內凡是要用 SketchUp 的
  # UI（HtmlDialog / start_timer / openURL / messagebox）**一律寫 `::UI`**。
  # 少寫兩個冒號就會變成 NameError，而且訊息很難懂。
  module UI
    # ui/bridge.rb —— 前端 ↔ Ruby 的**唯一**路由。
    #
    # 設計原則（違反任何一條都應該視為 bug）：
    #
    # 1. **只有一個 add_action_callback。** 前端全部的呼叫都包成同一個 envelope
    #    走 `sketchup.architech(json)`。多個 callback 名稱等於多個沒人管的縫，
    #    錯誤包裝與日誌就會各做各的。
    #
    # 2. **絕不 eval 前端傳來的字串。** 前端送來的 action 只用來查一張表
    #    （`@routes[action]`），查不到就回 UI-03。params 只做型別/範圍驗證，
    #    永遠不會被當成程式碼、方法名或檔案路徑直接使用。
    #
    # 3. **回應形狀固定。** 成功 `{ok:true, data:...}`，失敗
    #    `{ok:false, code:"UI-03", message:"..."}`（可選 `detail`）。
    #    前端不需要知道 Ruby 的例外類別。
    #
    # 4. **酬載上限尚未實測**（tools/spike/probe_dialog.rb 還沒跑過），
    #    所以這裡用保守上限 + 分塊傳輸 + 不預設走 base64 三層防護。見 PAYLOAD 一節。
    module Bridge
      # 前端呼叫的名稱：`sketchup.architech(jsonString)`
      CALLBACK_NAME    = 'architech'
      PROTOCOL_VERSION = 1

      # ---- PAYLOAD 防護 ---------------------------------------------------
      # 🔴 HtmlDialog 的 execute_script 酬載上限**尚未在實機驗證**。
      # 這些數字是保守猜測，不是實測值。跑完 tools/spike/probe_dialog.rb
      # 之後應該回來改，並把 journal 補上。
      #
      # 防護分三層：
      #   a. 預覽圖預設走本機檔案路徑（`file://`），根本不進橋接（見 route image.data）。
      #   b. 單次 execute_script 超過 MAX_SCRIPT_CHARS 就自動改走分塊傳輸。
      #   c. 分塊也超過 MAX_TOTAL_CHARS 就直接回 UI-07，不試、不猜、不截斷。
      # 2026-09-05 實測（tools/spike/probe_dialog.rb，SketchUp 2026 / macOS）：
      # 1K → 8M 字元逐級測試，**雙向全部完整無截斷**。
      #   1M 字元  rb2js 16 ms / js2rb 11 ms
      #   2M 字元  rb2js 31 ms / js2rb 19 ms
      #   8M 字元  rb2js 127 ms / js2rb 76 ms
      # 1024² 的 PNG 轉 base64 約 1–2 MB，遠在上限之內。
      #
      # 上限訂在實測值的一半而不是實測值本身：這是單一機器單一版本的觀察，
      # 留一倍餘裕給其他機器與未來版本。分塊機制保留 ——
      # 它已經有測試，成本是零，而萬一某台機器真的比較差，它就是那道保險。
      MAX_SCRIPT_CHARS = 2_000_000 # 單次 execute_script 上限（實測 8M 可用，取 1/4）
      CHUNK_CHARS      =   500_000 # 分塊大小（實測 500K 僅需 8 ms）
      MAX_TOTAL_CHARS  = 4_000_000 # 就算分塊也不送超過這個量（實測 8M 可用，取一半）

      # 診斷碼。使用者回報問題時直接對照這張表，所以碼一旦發佈就不要改用途。
      CODES = {
        'UI-01' => '前端酬載不是合法 JSON',
        'UI-02' => 'envelope 結構不合法（缺 id 或 action）',
        'UI-03' => '未知的 action（不在路由白名單內）',
        'UI-04' => '參數驗證失敗',
        'UI-05' => '沒有可用的 model / view',
        'UI-06' => '相依模組尚未載入（net / jobs 尚未實作）',
        'UI-07' => '回應酬載超過上限',
        'UI-08' => 'handler 拋出未預期的例外',
        'UI-09' => '已有進行中的 render（用戶端並發護欄）',
        'CAP-01' => '擷取失敗',
        'CAP-02' => '三個 pass 的尺寸不一致'
      }.freeze

      # handler 用 `Bridge.fail!` 拋這個，會被包成固定形狀的錯誤回應。
      class HandlerError < StandardError
        attr_reader :code, :detail

        def initialize(code, message, detail = nil)
          @code   = code
          @detail = detail
          super(message)
        end
      end

      Ctx = Struct.new(:dialog, :action, :id, keyword_init: true)

      class << self
        attr_accessor :dialog
        # 雲端後端注入點（見 cloud_available?）。nil = 用內建模擬後端。
        attr_accessor :backend
        # 分塊傳輸開關。🔴 分塊路徑本身也未在實機驗證過，
        # 若實機出問題可以關掉退回「超過就報 UI-07」。
        attr_accessor :chunking_enabled
        # 預覽圖傳輸方式：:path（預設，走 file://）或 :base64（備案）。
        # 這是「酬載上限未驗證」的主要防護——預設路徑根本不讓大字串進橋接。
        attr_accessor :preview_transport
      end
      self.backend           = nil
      self.chunking_enabled  = true
      self.preview_transport = :path

      @routes        = {}
      @allowed_files = {} # 白名單：只有我們自己產出的檔案才准被讀成 base64
      @render        = nil
      @log           = []

      # --- 路由註冊 -------------------------------------------------------
      # handler 簽名：->(params, ctx) { ... } → 回傳可 JSON 化的 data
      def self.route(name, &blk)
        @routes[name.to_s] = blk
      end

      def self.route_names
        @routes.keys.sort
      end

      def self.fail!(code, message, detail = nil)
        raise HandlerError.new(code, message, detail)
      end

      # --- 生命週期 -------------------------------------------------------

      # dialog 必須是 ::UI::HtmlDialog。整個外掛只在這裡註冊 action callback。
      def self.attach(dialog)
        self.dialog = dialog
        dialog.add_action_callback(CALLBACK_NAME) do |_action_context, payload|
          handle(payload)
          nil
        end
        self
      end

      def self.detach
        cancel_render_timer
        @render      = nil
        self.dialog  = nil
        @allowed_files = {}
        self
      end

      # --- 入口：所有前端呼叫都在這裡收斂 ---------------------------------
      def self.handle(raw)
        envelope = parse_envelope(raw)
        id       = envelope[:id]
        action   = envelope[:action]
        params   = envelope[:params]

        # 白名單查表。action 是資料，不是程式碼——這裡沒有 send、沒有 eval、
        # 沒有 const_get，前端無法叫到任何我們沒明確註冊的東西。
        handler = @routes[action]
        unless handler
          return respond(id, error_body('UI-03', "unknown action: #{action.inspect}"))
        end

        ctx = Ctx.new(dialog: dialog, action: action, id: id)
        begin
          data = handler.call(params, ctx)
          respond(id, { ok: true, data: data })
        rescue HandlerError => e
          log(:warn, "#{action} → #{e.code}: #{e.message}")
          respond(id, error_body(e.code, e.message, e.detail))
        rescue StandardError => e
          # 未預期的例外一律轉成 UI-08，而且**永遠不靜默**。
          log(:error, "#{action} → #{e.class}: #{e.message}")
          respond(id, error_body('UI-08', "#{e.class}: #{e.message}",
                                 { backtrace: Array(e.backtrace).first(6) }))
        end
      rescue StandardError => e
        # 連 envelope 都解不出來時 id 未知，只能發成不帶 id 的事件。
        log(:error, "envelope 失敗: #{e.class}: #{e.message}")
        emit('fatal', { code: 'UI-01', message: e.message })
        nil
      end

      def self.parse_envelope(raw)
        obj = ::JSON.parse(raw.to_s)
        raise 'envelope 必須是 JSON object' unless obj.is_a?(Hash)

        id     = obj['id']
        action = obj['action']
        # id 只會被原封不動地放回 JSON 回應，不會被求值；仍然做長度與型別檢查。
        raise 'envelope 缺少合法的 id' unless id.is_a?(String) && !id.empty? && id.length <= 64
        raise 'envelope 缺少合法的 action' unless action.is_a?(String) && action.length <= 64

        params = obj['params']
        params = {} unless params.is_a?(Hash)
        { id: id, action: action, params: params }
      rescue ::JSON::ParserError => e
        raise "UI-01 #{e.message}"
      end

      # --- 回應 -----------------------------------------------------------

      def self.error_body(code, message, detail = nil)
        body = { ok: false, code: code, message: message.to_s }
        body[:detail] = detail if detail
        body
      end

      def self.respond(id, body)
        payload = body.merge(id: id)
        send_json('__resolve', payload)
      end

      # Ruby → JS 的單向推播（狀態列、進度、非同步錯誤都走這裡）
      def self.emit(event, data = {})
        send_json('__event', { event: event.to_s, data: data })
      end

      def self.send_json(js_method, obj)
        json = ::JSON.generate(obj)

        if json.length <= MAX_SCRIPT_CHARS
          exec("window.ArchitechBridge.#{js_method}(#{js_literal(json)});")
          return true
        end

        unless chunking_enabled
          return send_oversize_error(obj, json.length)
        end
        if json.length > MAX_TOTAL_CHARS
          return send_oversize_error(obj, json.length)
        end

        # 分塊：每塊都是小字串，即使真正的上限比我們猜的低很多也能通過。
        token = "c#{Time.now.to_i}#{rand(100_000)}"
        total = (json.length.to_f / CHUNK_CHARS).ceil
        index = 0
        while index < total
          part = json[index * CHUNK_CHARS, CHUNK_CHARS]
          exec("window.ArchitechBridge.__chunk(#{js_literal(token)},#{index},#{total}," \
               "#{js_literal(part)},#{js_literal(js_method)});")
          index += 1
        end
        true
      end

      def self.send_oversize_error(obj, size)
        id = obj[:id] || obj['id']
        body = error_body('UI-07',
                          "response payload #{size} chars exceeds transport limit",
                          { chars: size, limit: MAX_SCRIPT_CHARS,
                            chunking: chunking_enabled, max_total: MAX_TOTAL_CHARS })
        body[:id] = id if id
        exec("window.ArchitechBridge.__resolve(#{js_literal(::JSON.generate(body))});")
        false
      end

      # 把任意字串包成安全的 JS 字串字面值。
      # 前端拿到的是字串，再自己 JSON.parse——所以我們送進 execute_script 的
      # 內容永遠是「一個字串字面值」，不是「一段程式」。
      def self.js_literal(str)
        lit = ::JSON.generate(str.to_s)
        # JSON 允許裸的 U+2028 / U+2029，但 JS 的字串字面值不允許——
        # 不換掉的話 execute_script 會拋 SyntaxError。`</` 是防 </script> 提前收尾。
        lit = lit.gsub("\u2028", '\\u2028')
                 .gsub("\u2029", '\\u2029')
                 .gsub('</', '<\\/')
        lit
      end

      def self.exec(script)
        d = dialog
        return false unless d
        d.execute_script(script)
        true
      rescue StandardError => e
        log(:error, "execute_script 失敗: #{e.class}: #{e.message}")
        false
      end

      # --- 診斷日誌（環狀緩衝，只在記憶體，不寫檔） -----------------------
      def self.log(level, message)
        @log << { at: Time.now.strftime('%H:%M:%S'), level: level.to_s, message: message.to_s }
        @log.shift while @log.length > 200
        puts "[ArchitechRender][#{level}] #{message}" if $VERBOSE || level == :error
        nil
      end

      def self.log_entries
        @log.dup
      end

      # ====================================================================
      # 環境探測（不臆造 API：任何不確定的呼叫都先 defined? / respond_to?）
      # ====================================================================

      def self.sketchup?
        defined?(::Sketchup) && ::Sketchup.respond_to?(:active_model)
      end

      def self.active_model
        return nil unless sketchup?

        ::Sketchup.active_model
      end

      def self.require_view!
        model = active_model
        fail!('UI-05', 'no active SketchUp model') unless model
        view = model.active_view
        fail!('UI-05', 'no active view') unless view
        view
      end

      # 雲端後端是**明確注入**的，不是靠 defined? 猜的。
      #
      #   ArchitechRender::UI::Bridge.backend = SomeObject
      #
      # 為什麼不直接偵測 ArchitechRender::Net：net/ 由別的模組負責，
      # 它的介面（方法名、callback 形狀）不是我這一層能假設的東西。
      # 猜錯的話錯誤會出現在 render 進行到一半的時候，最難查。
      # 注入之前一律走內建模擬後端，而且 bootstrap 會把 backend:"stub"
      # 一路送到前端，面板必須把這個事實顯示出來——不假裝有雲端。
      #
      # backend 必須回應 submit(request, on_status:, on_done:, on_error:)。
      def self.cloud_available?
        !backend.nil?
      end

      def self.capture_available?
        defined?(::ArchitechRender::Capture::Session) &&
          defined?(::ArchitechRender::Capture::Alignment)
      end

      # --- 尺寸與裁切 -----------------------------------------------------

      MAX_LONG_EDGE     = 1536 # spec 4.2；與 Capture::Alignment::MAX_EDGE 一致
      DEFAULT_LONG_EDGE = 1024
      ASPECTS           = %w[square viewport].freeze
      PRESETS           = %w[exterior interior dusk].freeze

      # viewport 尺寸。SketchUp 不在時用實測值當預設，讓前端能單獨開啟檢查。
      FALLBACK_VIEWPORT = { width: 1512, height: 849 }.freeze

      def self.viewport_size
        view = active_model && active_model.active_view
        return FALLBACK_VIEWPORT unless view

        { width: view.vpwidth.to_i, height: view.vpheight.to_i }
      rescue StandardError
        FALLBACK_VIEWPORT
      end

      # 有 Capture::Alignment 就用它（單一事實來源）；沒有就用同一條公式算，
      # 這樣前端在瀏覽器單獨開啟時也看得到正確的裁切框。
      def self.build_plan(long_edge, aspect)
        long_edge = validate_long_edge(long_edge)
        aspect    = validate_aspect(aspect)

        if capture_available? && active_model
          view = require_view!
          plan = ::ArchitechRender::Capture::Alignment.plan(
            view, long_edge: long_edge, aspect: aspect.to_sym
          )
          h = plan.to_h
          h.merge(crop_percent: plan.crop_percent, cropped: plan.cropped?,
                  aspect: aspect, long_edge: long_edge)
        else
          vp = viewport_size
          vp_aspect  = vp[:width].to_f / vp[:height]
          out_aspect = aspect == 'square' ? 1.0 : vp_aspect
          if out_aspect >= 1.0
            width  = long_edge
            height = (long_edge / out_aspect).round
          else
            height = long_edge
            width  = (long_edge * out_aspect).round
          end
          ratio = (width.to_f / height) / vp_aspect
          { width: width, height: height,
            viewport_aspect: vp_aspect.round(4),
            output_aspect: (width.to_f / height).round(4),
            visible_width_ratio: ratio.round(4),
            crop_percent: ((1.0 - ratio) * 100).round(1),
            cropped: ratio < 0.999,
            aspect: aspect, long_edge: long_edge }
        end
      end

      def self.validate_long_edge(value)
        n = value.to_i
        fail!('UI-04', "long_edge must be 256..#{MAX_LONG_EDGE}", { got: value }) if n < 256 || n > MAX_LONG_EDGE
        n
      end

      def self.validate_aspect(value)
        s = value.nil? ? 'square' : value.to_s
        fail!('UI-04', "aspect must be one of #{ASPECTS.join('/')}", { got: value }) unless ASPECTS.include?(s)
        s
      end

      def self.validate_preset(value)
        s = value.nil? ? 'exterior' : value.to_s
        fail!('UI-04', "preset must be one of #{PRESETS.join('/')}", { got: value }) unless PRESETS.include?(s)
        s
      end

      def self.validate_fidelity(value)
        f = value.to_f
        fail!('UI-04', 'fidelity must be 0.0..1.0', { got: value }) if f < 0.0 || f > 1.0
        (f * 100).round / 100.0
      end

      def self.validate_prompt(value)
        s = value.to_s.strip
        fail!('UI-04', 'prompt is empty') if s.empty?
        fail!('UI-04', 'prompt too long (max 2000 chars)', { chars: s.length }) if s.length > 2000
        s
      end

      # 🔴 估算只是本機佔位值。architecture.md 5.1 明訂定價表由雲端提供，
      # 不可硬編在 Ruby。所以這裡回傳的 source 一定要是 "local_stub"，
      # 前端必須把「概估」講清楚，不能顯示成權威數字。
      def self.estimate(width, height, _preset, _fidelity)
        mp = (width * height) / 1_000_000.0
        { cost_cents: ((1.5 + 6.0 * mp) * 10).round / 10.0,
          seconds_p50: (12 + 26 * mp).round,
          seconds_p95: (30 + 60 * mp).round,
          source: cloud_available? ? 'cloud' : 'local_stub' }
      end

      # ====================================================================
      # 路由
      # ====================================================================

      # 面板載入完成 → 取得全部啟動資料。前端在這之前不該假設任何預設值。
      route 'ui.ready' do |_params, _ctx|
        plan = build_plan(DEFAULT_LONG_EDGE, 'square')
        {
          protocol: PROTOCOL_VERSION,
          host: sketchup? ? 'sketchup' : 'browser',
          backend: cloud_available? ? 'cloud' : 'stub',
          capture: capture_available? ? 'real' : 'stub',
          sketchup_version: (sketchup? && ::Sketchup.respond_to?(:version) ? ::Sketchup.version : nil),
          preview_transport: preview_transport.to_s,
          limits: { max_long_edge: MAX_LONG_EDGE, min_long_edge: 256 },
          presets: PRESETS,
          aspects: ASPECTS,
          defaults: { preset: 'exterior', fidelity: 0.6,
                      long_edge: DEFAULT_LONG_EDGE, aspect: 'square' },
          viewport: viewport_size,
          plan: plan,
          estimate: estimate(plan[:width], plan[:height], 'exterior', 0.6),
          passes: %w[beauty edge depth],
          # 🔴 job 恢復（spec F5）需要 jobs/local_index.rb，尚未實作。
          pending_jobs: [],
          codes: CODES
        }
      end

      # 使用者改解析度 / 長寬比時即時重算裁切框與估算。
      route 'plan.preview' do |params, _ctx|
        plan     = build_plan(params['long_edge'] || DEFAULT_LONG_EDGE, params['aspect'])
        preset   = validate_preset(params['preset'])
        fidelity = validate_fidelity(params['fidelity'] || 0.6)
        { plan: plan,
          viewport: viewport_size,
          estimate: estimate(plan[:width], plan[:height], preset, fidelity) }
      end

      route 'render.start' do |params, _ctx|
        fail!('UI-09', 'a render is already running',
              { state: @render[:state] }) if @render && !terminal?(@render[:state])

        req = {
          prompt: validate_prompt(params['prompt']),
          preset: validate_preset(params['preset']),
          fidelity: validate_fidelity(params['fidelity']),
          plan: build_plan(params['long_edge'] || DEFAULT_LONG_EDGE, params['aspect']),
          seed: params['seed'].nil? ? nil : params['seed'].to_i
        }

        @render = { state: 'capturing', started_at: Time.now, request: req,
                    job_id: nil, timer: nil, assets: {}, result: nil }

        start_capture(req)
        { accepted: true, state: @render[:state], request: req }
      end

      route 'render.cancel' do |_params, _ctx|
        fail!('UI-04', 'nothing to cancel') unless @render
        cancel_render_timer

        # 停本機輪詢之外，還要通知雲端，否則使用者按了 Cancel、
        # job 仍會在雲端跑完並計費。best-effort：雲端取消失敗不影響本機收工。
        server_cancelled = false
        if cloud_available? && @render[:job_id] && backend.respond_to?(:cancel)
          begin
            backend.cancel(@render[:job_id])
            server_cancelled = true
          rescue StandardError
            server_cancelled = false
          end
        end

        @render[:state] = 'cancelled'
        emit('status', status_payload)
        { state: 'cancelled', server_cancel: server_cancelled }
      end

      route 'render.status' do |_params, _ctx|
        status_payload
      end

      # base64 備案。預設不用（預覽走 file:// 路徑），只有前端 img 載入失敗
      # 或使用者手動切換時才會呼叫。
      # 只讀白名單內的檔案——前端傳來的路徑永遠不會被直接 open。
      route 'image.data' do |params, _ctx|
        key  = params['key'].to_s
        path = @allowed_files[key]
        fail!('UI-04', "unknown image key: #{key.inspect}", { known: @allowed_files.keys }) unless path
        fail!('UI-05', "file missing: #{key}") unless File.exist?(path)

        bytes = File.size(path)
        # base64 大約 1.37×。先擋在讀檔之前，不要先吃掉記憶體才發現送不出去。
        approx = (bytes * 4 / 3.0).ceil
        if approx > MAX_TOTAL_CHARS
          fail!('UI-07', "image too large for base64 transport (#{bytes} bytes)",
                { bytes: bytes, approx_chars: approx, limit: MAX_TOTAL_CHARS })
        end

        { key: key, mime: 'image/png', bytes: bytes,
          base64: [File.binread(path)].pack('m0') }
      end

      # 讓使用者自己去看產出的檔案。UI.openURL 是已知存在的 API；
      # 🟡 用它開 file:// 目錄在 macOS 實測可行，Windows 未驗證。
      route 'system.reveal' do |params, _ctx|
        key  = params['key'].to_s
        path = @allowed_files[key]
        fail!('UI-04', "unknown key: #{key.inspect}") unless path
        fail!('UI-06', 'UI.openURL unavailable') unless defined?(::UI) && ::UI.respond_to?(:openURL)

        ::UI.openURL("file://#{File.dirname(path)}")
        { opened: File.dirname(path) }
      end

      route 'ui.log' do |params, _ctx|
        log(:info, "[frontend] #{params['message']}")
        { logged: true }
      end

      route 'diag.dump' do |_params, _ctx|
        { entries: log_entries,
          routes: route_names,
          transport: { preview: preview_transport.to_s,
                       chunking: chunking_enabled,
                       max_script_chars: MAX_SCRIPT_CHARS,
                       chunk_chars: CHUNK_CHARS,
                       max_total_chars: MAX_TOTAL_CHARS,
                       verified: true } }
      end

      route 'dialog.close' do |_params, ctx|
        d = ctx.dialog
        d.close if d && d.respond_to?(:close)
        { closed: true }
      end

      # ====================================================================
      # Render 流程編排
      #
      # Ruby 端只維護 idle / capturing / uploading / tracking（architecture.md 3）。
      # queued / running / succeeded 一律以雲端回傳為準，這裡不做本地推測。
      # ====================================================================

      TERMINAL_STATES = %w[succeeded failed cancelled expired].freeze

      def self.terminal?(state)
        TERMINAL_STATES.include?(state.to_s)
      end

      def self.elapsed_ms
        return 0 unless @render && @render[:started_at]

        ((Time.now - @render[:started_at]) * 1000).round
      end

      def self.status_payload
        return { state: 'idle', elapsed_ms: 0 } unless @render

        {
          state: @render[:state],
          step: @render[:step],
          total: @render[:total],
          label: @render[:label],
          elapsed_ms: elapsed_ms,
          job_id: @render[:job_id],
          assets: @render[:assets],
          result: @render[:result],
          error: @render[:error]
        }
      end

      def self.set_state(state, label: nil, step: nil, total: nil)
        return unless @render

        @render[:state] = state
        @render[:label] = label
        @render[:step]  = step
        @render[:total] = total
        emit('status', status_payload)
      end

      def self.fail_render(code, message, detail = nil)
        return unless @render

        cancel_render_timer
        @render[:state] = 'failed'
        @render[:error] = { code: code, message: message, detail: detail }
        log(:error, "render failed #{code}: #{message}")
        emit('status', status_payload)
      end

      # 註冊可被前端讀取的檔案。前端拿到的是 key，不是可任意指定的路徑。
      def self.publish_asset(key, path)
        @allowed_files[key] = path
        @render[:assets][key] = {
          key: key,
          # file:// URL 供 <img src> 直接使用（預設傳輸方式，不進橋接）
          url: "file://#{path}",
          path: path,
          bytes: (File.exist?(path) ? File.size(path) : 0)
        }
      end

      def self.start_capture(req)
        unless capture_available? && active_model
          # 沒有 SketchUp（或 capture 尚未載入）時走模擬，讓面板流程可被完整檢視。
          return simulate_capture
        end

        set_state('capturing', label: 'Capturing 1/3', step: 1, total: 3)

        # 擷取本身是同步迴圈（journal 005：view.refresh 後畫面立即正確）。
        # 放進一個 0 秒的 timer 只是為了先讓 emit 的狀態送到前端再開始阻塞主執行緒，
        # 否則使用者在整段擷取期間看到的還是上一個狀態。
        # 🔴 三個 pass 的逐步進度目前無法回報：Capture::Session#run 是一個
        # 不可中斷的迴圈，沒有 per-pass callback。要做到 1/3 → 2/3 → 3/3
        # 需要改 capture/session.rb（本次不動該檔）。
        ::UI.start_timer(0, false) do
          begin
            model   = active_model
            plan    = ::ArchitechRender::Capture::Alignment.plan(
              model.active_view,
              long_edge: req[:plan][:long_edge],
              aspect: req[:plan][:aspect].to_sym
            )
            out_dir = File.join(::Sketchup.temp_dir, 'architech_render',
                                Time.now.strftime('%Y%m%d-%H%M%S'))
            result = ::ArchitechRender::Capture::Session.new(model, plan: plan).run(out_dir)
            result.paths.each { |name, path| publish_asset(name.to_s, path) }
            @render[:capture_metadata] = result.metadata
            set_state('capturing', label: 'Capturing 3/3', step: 3, total: 3)
            start_upload
          rescue StandardError => e
            code = e.class.name.include?('CaptureError') ? 'CAP-01' : 'UI-08'
            fail_render(code, e.message, { klass: e.class.name })
          end
        end
        nil
      end

      def self.start_upload
        unless cloud_available?
          # net/ 尚未實作。不假裝有雲端——simulate_job 會把 backend:"stub"
          # 的事實一路帶到前端，面板要顯示 demo 標記。
          return simulate_job
        end

        set_state('uploading', label: 'Uploading control images')

        # assets 不在 request 裡（request 是使用者的意圖，assets 是擷取的產物），
        # 所以在這裡合併。backend 的契約是 submit(request, on_status:, on_done:, on_error:)。
        paths = @render[:assets].each_with_object({}) { |(k, v), acc| acc[k.to_sym] = v[:path] }
        payload = @render[:request].merge(assets: paths)

        backend.submit(
          payload,
          on_status: lambda do |state:, label: nil, job_id: nil, **extra|
            @render[:job_id] = job_id if job_id

            # 只轉發 set_state 真的接受的 key，不要盲目 splat。
            #
            # 這裡原本是 `set_state(state, label: label, **extra)`，
            # backend 一旦多送一個 key（例如 elapsed_ms）就會拋
            # ArgumentError: unknown keyword，而且是在使用者按下 Render
            # 之後才爆 —— 兩個模組的契約不匹配被 **extra 藏起來，延後到執行期。
            #
            # elapsed_ms 不需要轉發：status_payload 自己從 @render[:started_at]
            # 算，backend 送來的那份是多餘的。
            set_state(state, label: label,
                      step: extra[:step], total: extra[:total])
          end,
          on_done: lambda do |job|
            @render[:job_id] = job['id'] if job.is_a?(Hash) && job['id']
            url = job.is_a?(Hash) ? (job['result_url'] || job.dig('result', 'url')) : nil
            @render[:result] = { key: 'result', url: url, stub: false, job: job }
            set_state('succeeded', label: 'Done')
          end,
          on_error: lambda do |err|
            h = err.respond_to?(:to_h) ? err.to_h : { code: 'UI-08', message: err.to_s }
            fail_render(h[:code] || 'UI-08', h[:message] || 'render failed', h[:detail])
          end
        )
      rescue StandardError => e
        fail_render('UI-08', e.message, { klass: e.class.name })
      end

      # --- 模擬後端（只在 net/ 未實作或不在 SketchUp 內時使用）------------

      def self.simulate_capture
        steps = [[1, 'Capturing 1/3 (beauty)'], [2, 'Capturing 2/3 (hidden-line)'],
                 [3, 'Capturing 3/3 (fog depth)']]
        schedule_sequence(steps.map { |(n, label)|
          [0.4, -> { set_state('capturing', label: label, step: n, total: 3) }]
        } + [[0.4, -> { simulate_job }]])
      end

      def self.simulate_job
        @render[:job_id] = "stub-#{Time.now.to_i}"
        schedule_sequence([
                            [0.3, -> { set_state('uploading', label: 'Uploading control images') }],
                            [0.8, -> { set_state('queued', label: 'Queued') }],
                            [0.8, -> { set_state('running', label: 'Rendering') }],
                            [2.0, -> { finish_simulated }]
                          ])
      end

      def self.finish_simulated
        @render[:result] = {
          key: 'result',
          # 沒有真的結果圖。前端拿到 url:nil 時要自己畫佔位圖，
          # 絕對不要在這裡塞假圖假裝成功。
          url: nil,
          stub: true
        }
        set_state('succeeded', label: 'Done')
      end

      # 用一連串 one-shot timer 串起模擬流程。UI.start_timer(seconds, false)
      # 是已驗證可用的 API；不用 sleep，因為 sleep 會凍結主 UI 執行緒。
      def self.schedule_sequence(pairs)
        run_next = lambda do |index|
          return if index >= pairs.length
          return if @render.nil? || terminal?(@render[:state])

          delay, action = pairs[index]

          # 不在 SketchUp 內（單元測試）時沒有 ::UI.start_timer，
          # 直接同步跑完——這條路只影響模擬後端，不影響真正的擷取。
          unless defined?(::UI) && ::UI.respond_to?(:start_timer)
            action.call
            return run_next.call(index + 1)
          end

          @render[:timer] = ::UI.start_timer(delay, false) do
            begin
              action.call unless @render.nil? || terminal?(@render[:state])
              run_next.call(index + 1)
            rescue StandardError => e
              fail_render('UI-08', "#{e.class}: #{e.message}")
            end
          end
        end
        run_next.call(0)
        nil
      end

      def self.cancel_render_timer
        return unless @render && @render[:timer]
        return unless defined?(::UI) && ::UI.respond_to?(:stop_timer)

        ::UI.stop_timer(@render[:timer])
        @render[:timer] = nil
      rescue StandardError => e
        log(:warn, "stop_timer 失敗: #{e.message}")
      end
    end
  end
end
