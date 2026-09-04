# frozen_string_literal: true

module ArchitechRender
  module Capture
    # 快照與還原顯示狀態。
    #
    # 這是整個外掛最危險的模組：擷取途中若沒還原使用者的樣式設定，
    # 等於毀掉他的工作環境 —— 比出圖失敗嚴重得多。
    # 因此對外只暴露 with_temporary，強制走 ensure 路徑。
    module ViewState
      Snapshot = Struct.new(:rendering_options, :shadow_info, :camera, keyword_init: true)

      CAMERA_KEYS = %i[eye target up fov perspective aspect_ratio].freeze

      def self.snapshot(model)
        cam = model.active_view.camera
        Snapshot.new(
          rendering_options: model.rendering_options.to_h,
          shadow_info:       model.shadow_info.to_h,
          camera: {
            eye:          cam.eye,
            target:       cam.target,
            up:           cam.up,
            fov:          cam.fov,
            perspective:  cam.perspective?,
            aspect_ratio: cam.aspect_ratio
          }
        )
      end

      # 逐 key 寫回。個別 key 失敗不應中斷其餘還原 —— 還原是盡最大努力，
      # 回傳無法還原的 key 清單供呼叫端判斷。
      def self.restore(model, snap)
        failed = []

        snap.rendering_options.each do |k, v|
          begin
            model.rendering_options[k] = v
          rescue StandardError => e
            failed << "RO:#{k}(#{e.class})"
          end
        end

        snap.shadow_info.each do |k, v|
          begin
            model.shadow_info[k] = v
          rescue StandardError => e
            failed << "SI:#{k}(#{e.class})"
          end
        end

        cam = model.active_view.camera
        c   = snap.camera
        begin
          cam.perspective  = c[:perspective]
          cam.set(c[:eye], c[:target], c[:up])
          cam.fov          = c[:fov]
          cam.aspect_ratio = c[:aspect_ratio]
        rescue StandardError => e
          failed << "CAM(#{e.class})"
        end

        failed
      end

      # 回傳與快照不一致的 key。用來驗證還原是否真的完整。
      def self.diff(model, snap)
        d = {}
        snap.rendering_options.each do |k, v|
          now = model.rendering_options[k]
          d["RO:#{k}"] = [v, now] unless equivalent?(now, v)
        end
        snap.shadow_info.each do |k, v|
          now = model.shadow_info[k]
          d["SI:#{k}"] = [v, now] unless equivalent?(now, v)
        end
        d
      end

      # Sketchup::Color 沒有可靠的 ==，浮點也需要容差，所以自己比。
      def self.equivalent?(a, b)
        return true if a.equal?(b)
        if a.is_a?(Sketchup::Color) && b.is_a?(Sketchup::Color)
          return a.red == b.red && a.green == b.green && a.blue == b.blue && a.alpha == b.alpha
        end
        if a.is_a?(Float) || b.is_a?(Float)
          return false unless a.is_a?(Numeric) && b.is_a?(Numeric)
          return (a - b).abs <= 1e-6
        end
        a == b
      end

      # 唯一對外的入口。無論 block 正常結束或拋例外，都會還原。
      #
      # 回傳 block 的值。若還原有 key 失敗，會透過 on_restore_failure 回報，
      # 但不會吞掉原本的例外。
      def self.with_temporary(model, on_restore_failure: nil)
        snap = snapshot(model)
        begin
          yield snap
        ensure
          failed = restore(model, snap)
          model.active_view.refresh
          if !failed.empty? && on_restore_failure
            on_restore_failure.call(failed)
          end
        end
      end
    end
  end
end
