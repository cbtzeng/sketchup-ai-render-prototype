# frozen_string_literal: true

module ArchitechRender
  module Capture
    # 本檔所有 key 名皆來自實機 dump，不得憑印象新增或修改。
    #
    # 來源：tools/spike/results/2026-09-04-env-dump.txt
    #      SketchUp 2026 (26.2.242) · Ruby 3.2.2 · macOS 15.7.1 · arm64
    #
    # 狀態欄：
    #   CONFIRMED — 已出現在 dump 中，key 名確定存在
    #   PENDING   — 需要 Task 0.2 / 0.3 的行為實驗才能決定值
    module OptionsKeys
      # ---- rendering_options：CONFIRMED（key 名來自 dump）----------------
      RENDER_MODE          = "RenderMode"            # dump 當前值 2
      EDGE_DISPLAY_MODE    = "EdgeDisplayMode"       # dump 當前值 1
      EDGE_TYPE            = "EdgeType"              # dump 當前值 0
      EDGE_COLOR_MODE      = "EdgeColorMode"         # dump 當前值 1
      TEXTURE              = "Texture"               # true
      DRAW_SILHOUETTES     = "DrawSilhouettes"       # true
      SILHOUETTE_WIDTH     = "SilhouetteWidth"       # 2
      DRAW_PROFILES_ONLY   = "DrawProfilesOnly"      # false
      JITTER_EDGES         = "JitterEdges"           # false
      EXTEND_LINES         = "ExtendLines"           # false
      DRAW_LINE_ENDS       = "DrawLineEnds"          # false

      FACE_FRONT_COLOR     = "FaceFrontColor"
      FACE_BACK_COLOR      = "FaceBackColor"
      DISPLAY_COLOR_BY_LAYER = "DisplayColorByLayer"
      MATERIAL_TRANSPARENCY  = "MaterialTransparency"
      MODEL_TRANSPARENCY     = "ModelTransparency"

      DISPLAY_FOG          = "DisplayFog"            # false
      FOG_COLOR            = "FogColor"
      FOG_START_DIST       = "FogStartDist"          # dump 值 -1.0（疑為 auto）
      FOG_END_DIST         = "FogEndDist"            # dump 值 -1.0（疑為 auto）
      FOG_USE_BK_COLOR     = "FogUseBkColor"         # true

      BACKGROUND_COLOR     = "BackgroundColor"
      SKY_COLOR            = "SkyColor"
      GROUND_COLOR         = "GroundColor"
      DRAW_GROUND          = "DrawGround"            # false
      DRAW_HORIZON         = "DrawHorizon"           # true

      # 注意這個 key 的拼字：SketchUp 寫的是 "Que" 不是 "Cue"。
      DRAW_DEPTH_QUE       = "DrawDepthQue"          # false
      DEPTH_QUE_WIDTH      = "DepthQueWidth"         # 4

      AMBIENT_OCCLUSION    = "AmbientOcclusion"      # false
      AO_INTENSITY         = "AmbientOcclusionIntensity"

      DISPLAY_SKETCH_AXES  = "DisplaySketchAxes"     # true
      DISPLAY_TEXT         = "DisplayText"           # true
      DISPLAY_DIMS         = "DisplayDims"           # true
      DISPLAY_WATERMARKS   = "DisplayWatermarks"     # true
      SHOW_VIEW_NAME       = "ShowViewName"          # true
      DISPLAY_SECTION_PLANES = "DisplaySectionPlanes"

      # ---- shadow_info：CONFIRMED ---------------------------------------
      SHADOW_DISPLAY       = "DisplayShadows"        # 在 shadow_info，不在 rendering_options
      SHADOW_EDGES_CAST    = "EdgesCastShadows"
      SHADOW_ON_ALL_FACES  = "DisplayOnAllFaces"
      SHADOW_ON_GROUND     = "DisplayOnGroundPlane"
      SHADOW_LIGHT         = "Light"
      SHADOW_DARK          = "Dark"
      SHADOW_USE_SUN_ALL   = "UseSunForAllShading"

      # dump 中「不存在」的 key —— 曾經被誤以為存在，記錄下來避免重蹈覆轍
      # FaceColorMode      → 不存在。面的顯示由 RenderMode + DisplayColorByLayer 決定。
      # DisplayShadows     → 不在 rendering_options，在 shadow_info。

      # ---- 已由 Task 0.2/0.3 實測確定 ------------------------------------
      # 來源：tools/spike/results/2026-09-04-probe-report.txt
      #      docs/journal/main/002-write-image-對齊方案.md
      #      docs/journal/main/003-fog-標定結果.md

      # 對齊策略：write_image 的取景只由 width/height 決定 —— 垂直 FOV 固定
      # （camera.fov_is_height? == true），水平視野由長寬比推導。
      # camera.aspect_ratio 對 write_image 完全沒有影響（設 0.0 與 1.0 產出
      # 的 PNG 位元組完全相同）。因此：三個 pass 只要用同一組 width/height，
      # 取景必然一致，像素對齊自動成立。不要去動 camera.aspect_ratio ——
      # 那只會在使用者的 viewport 上加黑邊，卻不改變輸出。
      ALIGNMENT_STRATEGY = :consistent_dimensions

      # Retina：device_width/height 是 vpwidth/height 的 2.0 倍。
      # 但 write_image 吃的是我們給的絕對像素數，與此無關，因此不影響對齊。
      # 僅在需要把螢幕座標換算成輸出座標時才要用到。
      DEVICE_PIXEL_RATIO = 2.0

      # RenderMode：0 與 1 已確認；2..7 在測試模型上無法區分（單一無貼圖面，
      # shaded 與 textured 產出相同）。需在有材質的真實場景上重測。
      RENDER_MODE_WIREFRAME   = 0   # 面不繪製，背景透出，且畫出背面邊線
      RENDER_MODE_HIDDEN_LINE = 1   # 面以背景色填滿遮擋後方，不畫背面邊線 ← edge pass 用這個
      RENDER_MODE_SHADED      = 2   # 目前預設值；2/3/4/7 在測試模型上位元組相同
      RENDER_MODE_MONOCHROME  = 5   # 純白面積最高(12.4%)且相異色數最少(79)，判定為單色，待複驗
      # 6 = 面呈 237 灰、無純白，用途未明，待複驗

      # ---- fog：完全線性，可用 ------------------------------------------
      # 12 個標定點（End=60m 與 30m 各 6 點）全部落在 ±0.5 灰階內，
      # 誤差即量化誤差本身。單位為英吋（寫入 60*39.3701 讀回 2362.206）。
      # -1.0 是可寫入的哨兵值，代表 auto（由模型範圍自動計算）。
      FOG_AUTO_SENTINEL = -1.0
      FOG_USABLE        = true
      FOG_CURVE         = :linear
      INCHES_PER_METER  = 39.3701

      # grey = 255 * (1 - (d - start) / (end - start))，clamp 到 [0, 255]
      # 反推：d = start + (1 - grey / 255.0) * (end - start)
      #
      # 注意：這是「線性公制距離」，不是 MiDaS 那種 scale/shift invariant 的
      # 相對視差。餵給 ControlNet depth adapter 前必須轉成視差域並正規化，
      # 見 docs/critique.md 第 2 點。
      def self.grey_to_distance(grey, start_in, end_in)
        start_in + (1.0 - grey / 255.0) * (end_in - start_in)
      end

      def self.distance_to_grey(dist_in, start_in, end_in)
        [[255.0 * (1.0 - (dist_in - start_in) / (end_in - start_in)), 0.0].max, 255.0].min
      end
    end
  end
end
