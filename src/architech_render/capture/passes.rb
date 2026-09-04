# frozen_string_literal: true

module ArchitechRender
  module Capture
    # 三個 pass 的設定套用。
    #
    # 每個 pass 只負責「把 rendering_options 調成該 pass 需要的樣子」，
    # 不負責寫檔 —— 寫檔由 Session 統一處理，這樣三個 pass 必然共用同一組輸出參數。
    # 這是像素對齊的結構性保證，不是靠紀律。
    #
    # 呼叫端必須已經在 ViewState.with_temporary 內，這些方法不做任何還原。
    module Passes
      K = OptionsKeys

      WHITE = [255, 255, 255].freeze
      BLACK = [0, 0, 0].freeze

      def self.color(rgb)
        Sketchup::Color.new(rgb[0], rgb[1], rgb[2])
      end

      # 關掉所有會干擾控制圖判讀的東西。三個 pass 共用。
      #
      # 這裡的每一項都不是「順便關一下」——
      # 輔助線、隱藏幾何、地下幾何若出現在圖上，ControlNet 會把它們當成真實結構，
      # 生成出不存在的牆和線。而且三個 pass 若不一致，條件會互相打架。
      def self.strip_decorations(ro)
        ro[K::DISPLAY_SKETCH_AXES]    = false
        ro[K::DISPLAY_TEXT]           = false
        ro[K::DISPLAY_DIMS]           = false
        ro[K::DISPLAY_WATERMARKS]     = false
        ro[K::SHOW_VIEW_NAME]         = false
        ro[K::DISPLAY_SECTION_PLANES] = false
        ro[K::DISPLAY_INSTANCE_AXES]  = false

        # 以下四項的預設值會讓幾何跑進控制圖，實測 dump 確認：
        #   HideConstructionGeometry 預設 false → 輔助線會被畫出來
        #   DrawUnderground          預設 true  → 地面下的幾何會被畫出來
        ro[K::HIDE_CONSTRUCTION_GEOMETRY] = true
        ro[K::DRAW_UNDERGROUND]           = false
        ro[K::DRAW_HIDDEN]                = false
        ro[K::DRAW_HIDDEN_GEOMETRY]       = false
        ro[K::DRAW_HIDDEN_OBJECTS]        = false
      end

      # ---- pass A：beauty ------------------------------------------------
      # 使用者當前的樣式，但把裝飾關掉。這是 img2img 的輸入，也是 A/B 組的 baseline。
      module Beauty
        def self.name = :beauty

        def self.apply(model, _view)
          ro = model.rendering_options
          Passes.strip_decorations(ro)
          ro[K::RENDER_MODE] = K::RENDER_MODE_SHADED
          ro[K::TEXTURE]     = true
          ro[K::DISPLAY_FOG] = false
          { render_mode: K::RENDER_MODE_SHADED, texture: true }
        end
      end

      # ---- pass B：hidden-line edge ---------------------------------------
      # 白底黑線。用 RenderMode 5（單色）而非 1（隱藏線）——
      # mode 1 的面採背景色，多一個隱性相依；mode 5 的面恆為純白。見 journal 004。
      module Edge
        def self.name = :edge

        def self.apply(model, _view)
          ro = model.rendering_options
          Passes.strip_decorations(ro)
          ro[K::RENDER_MODE]       = K::RENDER_MODE_FOR_EDGE_PASS
          ro[K::TEXTURE]           = false
          ro[K::DISPLAY_FOG]       = false
          ro[K::AMBIENT_OCCLUSION] = false
          ro[K::BACKGROUND_COLOR]  = Passes.color(WHITE)
          ro[K::DRAW_GROUND]       = false
          ro[K::DRAW_HORIZON]      = false
          ro[K::EDGE_DISPLAY_MODE] = 1
          ro[K::DRAW_SILHOUETTES]  = true
          ro[K::DRAW_BACK_EDGES]   = false   # 要遮擋正確的線稿，不要透視背面
          # 邊線強制為黑。注意：若 EDGE_COLOR_MODE 代表「依材質決定邊線顏色」，
          # 這一行會無效而產出彩色線稿 —— 該 key 的語意尚未驗證，見 options_keys.rb 註記。
          ro[K::FOREGROUND_COLOR]  = Passes.color(BLACK)
          ro[K::JITTER_EDGES]      = false
          ro[K::EXTEND_LINES]      = false
          ro[K::DRAW_LINE_ENDS]    = false
          model.shadow_info[K::SHADOW_DISPLAY] = false
          { render_mode: K::RENDER_MODE_FOR_EDGE_PASS, silhouettes: true }
        end
      end

      # ---- pass C：fog depth ----------------------------------------------
      # 白面 + 黑霧 + 無邊線。fog 為精確線性（journal 003），
      # 灰階可無損反推公制距離，所以必須把 start/end 記進 metadata。
      module Depth
        def self.name = :depth

        # 依模型包圍盒與相機位置決定霧的起訖，讓灰階動態範圍用滿。
        # 取不到 bounds 時退回一個保守的固定範圍，並在 metadata 標明。
        def self.fog_range(model, view)
          eye = view.camera.eye
          if model.respond_to?(:bounds)
            bb = model.bounds
            if bb && !bb.empty?
              dists = (0..7).map { |i| eye.distance(bb.corner(i)) }
              near  = dists.min
              far   = dists.max
              # 留一點邊界，避免最近/最遠面正好落在 0 或 255 被 clamp
              pad = [(far - near) * 0.05, 1.0].max
              return [[near - pad, 0.0].max, far + pad, :bounds]
            end
          end
          [0.0, 50.0 * K::INCHES_PER_METER, :fallback]
        rescue StandardError
          [0.0, 50.0 * K::INCHES_PER_METER, :fallback]
        end

        def self.apply(model, view)
          ro = model.rendering_options
          Passes.strip_decorations(ro)

          start_in, end_in, source = fog_range(model, view)

          ro[K::RENDER_MODE]        = K::RENDER_MODE_MONOCHROME
          ro[K::TEXTURE]            = false
          ro[K::AMBIENT_OCCLUSION]  = false
          ro[K::DISPLAY_COLOR_BY_LAYER] = false
          ro[K::FACE_FRONT_COLOR]   = Passes.color(WHITE)
          ro[K::FACE_BACK_COLOR]    = Passes.color(WHITE)
          ro[K::BACKGROUND_COLOR]   = Passes.color(WHITE)
          ro[K::DRAW_GROUND]        = false
          ro[K::DRAW_HORIZON]       = false
          ro[K::EDGE_DISPLAY_MODE]  = 0
          ro[K::DRAW_SILHOUETTES]   = false
          ro[K::DISPLAY_FOG]        = true
          ro[K::FOG_USE_BK_COLOR]   = false
          ro[K::FOG_COLOR]          = Passes.color(BLACK)
          ro[K::FOG_START_DIST]     = start_in
          ro[K::FOG_END_DIST]       = end_in
          model.shadow_info[K::SHADOW_DISPLAY] = false

          # 這些數字是評估端把灰階換算回公尺的唯一依據，遺失就等於深度圖作廢。
          {
            render_mode: K::RENDER_MODE_MONOCHROME,
            fog_start_inches: start_in,
            fog_end_inches:   end_in,
            fog_start_m: start_in / K::INCHES_PER_METER,
            fog_end_m:   end_in   / K::INCHES_PER_METER,
            fog_range_source: source,
            grey_to_distance: "d = start + (1 - grey/255) * (end - start)"
          }
        end
      end

      ALL = [Beauty, Edge, Depth].freeze
    end
  end
end
