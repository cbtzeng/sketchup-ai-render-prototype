# frozen_string_literal: true

module ArchitechRender
  module Net
    # 用 UI.start_timer 做退避輪詢。
    #
    # SketchUp 沒有背景執行緒，這是做非同步等待的標準手法。
    #
    # 一條硬規則：**狀態一律以雲端回傳為準，Ruby 端不做任何本地推測。**
    # 這樣 SketchUp 崩潰、使用者關掉面板、甚至換一台機器，job 都還在，
    # 重開面板就能接回去。把狀態存在 Ruby 記憶體裡是最容易犯的錯。
    class Poller
      INTERVALS   = [2, 2, 2, 5, 5, 5, 10].freeze # 之後固定 10 秒
      MAX_SECONDS = 600                            # 與雲端的 expired 上限一致

      TERMINAL = %w[succeeded failed cancelled expired].freeze

      def initialize(job_id, on_update:, on_done:)
        @job_id    = job_id
        @on_update = on_update
        @on_done   = on_done
        @tick      = 0
        @started   = Time.now
        @timer     = nil
        @stopped   = false
      end

      def start
        schedule_next
        self
      end

      def stop
        @stopped = true
        UI.stop_timer(@timer) if @timer
        @timer = nil
      end

      def elapsed = Time.now - @started

      private

      def interval
        INTERVALS[@tick] || INTERVALS.last
      end

      def schedule_next
        return if @stopped

        if elapsed > MAX_SECONDS
          finish(Errors::Timeout.new('等待逾時，工作可能仍在雲端執行',
                                     detail: { job_id: @job_id, seconds: elapsed.round }), nil)
          return
        end

        @timer = UI.start_timer(interval, false) do
          @tick += 1
          poll_once
        end
      end

      def poll_once
        return if @stopped

        ApiClient.get_job(@job_id) do |err, job|
          next if @stopped

          if err
            # 輪詢途中的暫時性錯誤不該讓整個 job 失敗 —— 使用者的圖可能還在跑。
            # 可重試的就繼續等，不可重試的才收工。
            if err.retryable?
              @on_update&.call(status: 'polling_retry', error: err.to_h, elapsed: elapsed)
              schedule_next
            else
              finish(err, nil)
            end
            next
          end

          status = job['status'].to_s
          @on_update&.call(status: status, job: job, elapsed: elapsed)

          if TERMINAL.include?(status)
            finish(nil, job)
          else
            schedule_next
          end
        end
      end

      def finish(err, job)
        stop
        @on_done&.call(err, job)
      end
    end
  end
end
