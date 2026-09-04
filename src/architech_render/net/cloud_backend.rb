# frozen_string_literal: true

module ArchitechRender
  module Net
    # 把 net/ 的各個零件接成 ui/bridge.rb 要求的單一介面。
    #
    #   ArchitechRender::UI::Bridge.backend = ArchitechRender::Net::CloudBackend
    #
    # bridge 刻意不用 `defined?(ArchitechRender::Net)` 偵測雲端，而是要求明確注入 ——
    # 那是對的判斷：猜錯介面形狀，錯誤會出現在 render 跑到一半的時候，最難查。
    # 這個檔案就是那個「明確」的接點，介面不合的話會在載入期就爆，不是執行期。
    #
    # 流程：取簽名 URL → 上傳並校驗 sha256 → 建 job → 輪詢到終態。
    # 任何一步失敗都走 on_error，不會靜默降級。
    module CloudBackend
      module_function

      # request 需含：prompt, preset, fidelity, plan{width,height}, seed, assets{name => path}
      def submit(request, on_status:, on_done:, on_error:)
        assets = request[:assets] || request['assets'] || {}
        if assets.empty?
          on_error.call(Errors::Base.new('沒有可上傳的控制圖', code: 'NET-41'))
          return nil
        end

        on_status.call(state: 'uploading', label: 'Requesting upload URLs')

        ApiClient.request_upload_urls(pass_names: assets.keys.map(&:to_s)) do |err, res|
          next on_error.call(err) if err

          urls = symbolize(res['urls'] || {})
          upload(request, assets, urls, on_status, on_done, on_error)
        end
        nil
      end

      def upload(request, assets, urls, on_status, on_done, on_error)
        progress = lambda do |name, done, total|
          on_status.call(state: 'uploading', label: "Uploading #{name} (#{done}/#{total})",
                         step: done, total: total)
        end

        Uploader.upload_all(assets: assets, signed_urls: urls, on_progress: progress) do |err, manifest|
          next on_error.call(err) if err

          on_status.call(state: 'uploading', label: 'Creating job')
          create(request, manifest, on_status, on_done, on_error)
        end
      end

      def create(request, manifest, on_status, on_done, on_error)
        ApiClient.create_job(
          scene: request[:scene] || current_scene_name,
          prompt: request[:prompt],
          preset: request[:preset],
          fidelity: request[:fidelity],
          manifest: manifest,
          plan: request[:plan]
        ) do |err, job|
          next on_error.call(err) if err

          job_id = job['id']
          # 先記進模型，再開始輪詢。順序不能反 ——
          # 若輪詢途中 SketchUp 崩潰而 job 沒記下來，使用者就永遠找不回那張圖了
          # （而且已經計費）。這是 spec F5 的實際需求。
          Jobs::LocalIndex.record(active_model, job_id, request)

          on_status.call(state: 'queued', label: 'Queued', job_id: job_id)
          poll(job_id, on_status, on_done, on_error)
        end
      end

      def poll(job_id, on_status, on_done, on_error)
        Poller.new(
          job_id,
          on_update: lambda do |status:, job: nil, elapsed: nil, error: nil|
            on_status.call(state: status, label: label_for(status), job_id: job_id,
                           elapsed_ms: elapsed ? (elapsed * 1000).round : nil,
                           warning: error)
          end,
          on_done: lambda do |err, job|
            Jobs::LocalIndex.forget(active_model, job_id)
            next on_error.call(err) if err

            case job['status']
            when 'succeeded' then on_done.call(job)
            when 'cancelled' then on_error.call(Errors::Base.new('工作已取消', code: 'NET-60'))
            when 'expired'   then on_error.call(Errors::Timeout.new('工作在雲端逾時'))
            else
              on_error.call(Errors::Base.new(job['error_msg'] || '工作失敗',
                                             code: job['error_code'] || 'NET-61',
                                             detail: job))
            end
          end
        ).start
      end

      def cancel(job_id, &callback)
        ApiClient.cancel_job(job_id) do |err, res|
          Jobs::LocalIndex.forget(active_model, job_id)
          callback&.call(err, res)
        end
      end

      LABELS = {
        'queued'         => 'Queued',
        'running'        => 'Rendering',
        'retrying'       => 'Retrying after a server error',
        'polling_retry'  => 'Connection hiccup, still waiting',
        'succeeded'      => 'Done'
      }.freeze

      def label_for(status) = LABELS[status] || status.to_s

      def symbolize(hash)
        hash.each_with_object({}) { |(k, v), acc| acc[k.to_sym] = v }
      end

      def active_model
        defined?(Sketchup) ? Sketchup.active_model : nil
      end

      def current_scene_name
        m = active_model
        return nil unless m
        page = m.pages.selected_page
        page ? page.name : nil
      rescue StandardError
        nil
      end
    end
  end
end
