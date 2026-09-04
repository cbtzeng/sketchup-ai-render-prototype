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

      # ---- PENDING：需要行為實驗 ----------------------------------------
      # Task 0.2（write_image 對齊）
      ALIGNMENT_STRATEGY   = nil  # :lock_aspect_ratio | :native_viewport
      DEVICE_PIXEL_RATIO   = nil  # device_width / vpwidth，Retina 下可能為 2.0

      # Task 0.2b（RenderMode 列舉）
      RENDER_MODE_VALUES   = nil  # {wireframe:, hidden_line:, shaded:, textured:, monochrome:}

      # Task 0.3（fog 標定）
      FOG_AUTO_SENTINEL    = -1.0 # dump 觀察到的預設值，語意待確認
      FOG_USABLE           = nil  # true | false
      FOG_CURVE            = nil  # :linear | :exponential
      FOG_FIT              = nil  # 線性 {slope:, intercept:}；指數為查表陣列
    end
  end
end
