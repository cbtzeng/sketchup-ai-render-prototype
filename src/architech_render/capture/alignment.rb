# frozen_string_literal: true

module ArchitechRender
  module Capture
    # 決定三個 pass 的輸出尺寸，並計算與 viewport 的取景落差。
    #
    # Phase 0 實測結論（journal 002）：
    #   write_image 的取景**只由 width/height 決定** —— 垂直 FOV 固定
    #   （camera.fov_is_height? == true），水平視野由長寬比推導。
    #   camera.aspect_ratio 對 write_image 完全沒有影響。
    #
    # 所以像素對齊不需要任何機制：三次呼叫傳同一組尺寸即可。
    # 這個模組存在的理由不是「讓它們對齊」，而是「保證我們真的傳了同一組尺寸」，
    # 以及「算出裁切比例讓 UI 可以畫框」。
    module Alignment
      MAX_EDGE = 1536 # spec 4.2 的解析度上限

      Plan = Struct.new(:width, :height, :viewport_aspect, :output_aspect,
                        :visible_width_ratio, keyword_init: true) do
        # 輸出畫面涵蓋 viewport 水平範圍的比例。
        #   < 1.0 → 使用者在 SketchUp 看得到、但不會出現在輸出裡（水平被裁切）
        #   > 1.0 → 輸出會包含使用者目前看不到的東西
        def cropped?
          visible_width_ratio < 0.999
        end

        def crop_percent
          ((1.0 - visible_width_ratio) * 100).round(1)
        end

        def to_h
          { width: width, height: height,
            viewport_aspect: viewport_aspect.round(4),
            output_aspect: output_aspect.round(4),
            visible_width_ratio: visible_width_ratio.round(4) }
        end
      end

      # aspect:
      #   :square   1:1
      #   :viewport 沿用 viewport 的長寬比
      #   Float     直接指定寬/高
      def self.plan(view, long_edge: 1024, aspect: :square)
        raise ArgumentError, "long_edge 超過上限 #{MAX_EDGE}" if long_edge > MAX_EDGE
        raise ArgumentError, "long_edge 必須為正" if long_edge <= 0

        vp_aspect = view.vpwidth.to_f / view.vpheight

        out_aspect =
          case aspect
          when :square   then 1.0
          when :viewport then vp_aspect
          when Numeric   then aspect.to_f
          else raise ArgumentError, "不支援的 aspect: #{aspect.inspect}"
          end
        raise ArgumentError, "aspect 必須為正" if out_aspect <= 0

        if out_aspect >= 1.0
          width  = long_edge
          height = (long_edge / out_aspect).round
        else
          height = long_edge
          width  = (long_edge * out_aspect).round
        end
        width  = 1 if width  < 1
        height = 1 if height < 1

        Plan.new(
          width: width, height: height,
          viewport_aspect: vp_aspect,
          output_aspect: width.to_f / height,
          # 垂直 FOV 固定，所以水平可見範圍與長寬比成正比
          visible_width_ratio: (width.to_f / height) / vp_aspect
        )
      end

      # 驗證三個 pass 真的產出同尺寸的圖。
      # 這對應 spec 驗收條件 F1，是整個方案的單點故障，所以寫成硬性檢查而非警告。
      def self.assert_consistent!(paths_with_sizes)
        sizes = paths_with_sizes.values.uniq
        return true if sizes.size <= 1
        raise "pass 之間尺寸不一致：#{paths_with_sizes.inspect}"
      end
    end
  end
end
