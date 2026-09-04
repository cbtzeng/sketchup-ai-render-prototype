# frozen_string_literal: true

module ArchitechRender
  module Capture
    # 擷取編排：snapshot → 逐 pass 套用並寫檔 → 保證還原。
    #
    # 設計依據（Phase 0 實測）：
    # - rendering_options 不進 undo stack，SketchUp 不會幫我們還原任何東西。
    #   ViewState 的 ensure 是**唯一**的還原機制，不是雙保險。見 journal 005。
    # - 不需要 start_operation：包了也不會產生 undo 項目，只是多一層沒用的包裝。
    # - view.refresh 之後畫面立即正確，不需要等 timer tick，
    #   所以可以寫成同步迴圈而不是 timer 驅動的狀態機。
    class Session
      class CaptureError < StandardError; end

      Result = Struct.new(:paths, :metadata, :elapsed, keyword_init: true)

      def initialize(model, plan:, passes: Passes::ALL)
        @model  = model
        @view   = model.active_view
        @plan   = plan
        @passes = passes
      end

      # out_dir 由呼叫端決定（通常是 Sketchup.temp_dir 底下的一個子目錄）。
      # 回傳 Result；任何一個 pass 失敗都會拋 CaptureError，且設定必已還原。
      #
      # on_pass 在**每個 pass 開始前**被呼叫，簽名為 (name, index, total)。
      # 這是同步迴圈，所以 UI 要靠這個回呼才看得到中間進度；
      # 沒有它面板只會從 1/3 直接跳到 3/3。
      def run(out_dir, on_pass: nil)
        FileUtils_mkdir_p(out_dir)

        paths      = {}
        sizes      = {}
        metadata   = { plan: @plan.to_h, passes: {} }
        restore_failures = nil
        t0 = Time.now

        ViewState.with_temporary(@model, on_restore_failure: ->(f) { restore_failures = f }) do
          @passes.each_with_index do |pass, index|
            name = pass.name
            on_pass&.call(name, index + 1, @passes.size)
            meta = pass.apply(@model, @view)
            @view.refresh

            path = File.join(out_dir, "#{name}.png")
            ok = @view.write_image(
              filename: path,
              width:    @plan.width,
              height:   @plan.height,
              antialias: true
            )

            unless ok && File.exist?(path) && File.size(path) > 0
              raise CaptureError,
                    "pass #{name} 擷取失敗（write_image=#{ok.inspect}, " \
                    "exist=#{File.exist?(path)}, size=#{File.exist?(path) ? File.size(path) : 0}）"
            end

            paths[name]    = path
            sizes[name]    = [@plan.width, @plan.height]
            metadata[:passes][name] = meta.merge(bytes: File.size(path))
          end
        end

        # 尺寸一致性是整個方案的單點故障，所以是硬性檢查而不是警告。
        Alignment.assert_consistent!(sizes)

        if restore_failures && !restore_failures.empty?
          # 還原失敗不影響已產出的圖，但必須讓上層知道 —— 絕不靜默。
          metadata[:restore_failures] = restore_failures
        end

        Result.new(paths: paths, metadata: metadata, elapsed: Time.now - t0)
      end

      private

      # SketchUp 的 Ruby 有 fileutils，但為了少一個 require 相依，自己做。
      def FileUtils_mkdir_p(dir)
        return if File.directory?(dir)
        parent = File.dirname(dir)
        FileUtils_mkdir_p(parent) unless File.directory?(parent) || parent == dir
        Dir.mkdir(dir)
      end
    end
  end
end
