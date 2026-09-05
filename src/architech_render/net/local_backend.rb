# frozen_string_literal: true

require 'json'

module ArchitechRender
  module Net
    # 本機生成後端。實作 ui/bridge.rb 要求的
    # submit(request, on_status:, on_done:, on_error:) 契約。
    #
    # 為什麼不走雲端：雲端層的 Supabase adapter 尚未實作，
    # 而且部署它對「外掛能不能出圖」沒有幫助 —— 生成能力在本機已經驗證可用。
    # CloudBackend 保留著，之後接上 adapter 就能切換。
    #
    # 跨行程的做法：Ruby 用 shell 把 Python 丟到背景，
    # 然後用 UI.start_timer 定期讀一個狀態檔。
    #
    # 為什麼不用執行緒或管線：SketchUp 的 Ruby 跑在主 UI 執行緒，
    # 沒有可靠的方式讀取子行程的即時輸出。**檔案是這兩個世界之間
    # 最不會出錯的介面** —— 寫入端用 rename 保證原子性，讀取端
    # 讀到壞掉的 JSON 就當作「還沒好」再等一輪。
    module LocalBackend
      module_function

      POLL_SECONDS   = 1.0
      TIMEOUT_SECONDS = 600   # 首次載入模型可能要一分鐘，給寬鬆一點

      # 外掛是從 Plugins 目錄的**符號連結**載入的（tools/install_dev.sh 建立），
      # 所以 File.dirname(__FILE__) 給的是 Plugins 路徑，往上三層會變成
      # 「.../SketchUp」而不是 repo —— 於是找不到 .venv-gen，
      # available? 回 false，整個退回未部署的雲端後端。
      #
      # realpath 先把符號連結解開，才拿得到真正的 repo 位置。
      def repo_root
        real = begin
          File.realpath(__FILE__)
        rescue StandardError
          File.expand_path(__FILE__)
        end
        File.expand_path('../../..', File.dirname(real))
      end

      def python_bin
        File.join(repo_root, '.venv-gen', 'bin', 'python')
      end

      def available?
        File.executable?(python_bin)
      end

      # 成品根目錄。放 Documents 而不是 temp —— 見 submit 內的說明。
      def output_root
        File.join(Dir.home, 'Documents', 'ArchitechRender')
      end

      def mkdir_p(dir)
        return if File.directory?(dir)
        parent = File.dirname(dir)
        mkdir_p(parent) unless File.directory?(parent) || parent == dir
        Dir.mkdir(dir)
      end

      # fidelity 滑桿（0..1）→ ControlNet 權重。
      #
      # 只給使用者一個旋鈕是刻意的（spec 2.1）：兩個獨立權重會讓人不知道從何調起。
      # edge 的權重範圍比 depth 高，因為邊線對結構的約束比深度直接 ——
      # 深度給的是「哪裡遠哪裡近」，邊線給的是「線在哪裡」。
      #
      # 下限刻意不低於 0.55：實測 0.48 時建築量體就整個跑掉了
      # （12 個窗變成完全不同的形狀）。低於這個值就不再是「這棟建築的算圖」，
      # 而是「用這張圖當靈感重新生成」—— 那不是渲染外掛該提供的東西。
      def weights_for(fidelity)
        f = clamp01(fidelity)
        { edge: (0.55 + 0.45 * f).round(3), depth: (0.30 + 0.35 * f).round(3) }
      end

      # denoise **不隨 fidelity 變動**，固定在偏高的值。
      #
      # 這一版是實測後修正的。第一版讓 denoise 隨 fidelity 反向變動
      # （低保真 = 高 denoise），結果兩端都不堪用：
      #   高保真：denoise 0.65 + 高權重 → 產出看起來像 SketchUp 截圖加了點材質
      #   低保真：denoise 0.79 + 低權重 → 像照片，但建築結構整個跑掉
      # 中間那個「照片般但結構正確」的區域反而到不了。
      #
      # 原因是我把兩個**獨立的軸**綁在一起了。ControlNet 的整個意義就是：
      # denoise 開高讓模型自由重畫材質與光影，同時由控制圖把幾何按住。
      # 讓它們同進同退，等於把 ControlNet 的好處抵銷掉。
      #
      # 所以：denoise 固定高（重畫材質光影），fidelity 只管控制圖權重（按住幾何）。
      DENOISE = 0.75

      def clamp01(v)
        [[v.to_f, 0.0].max, 1.0].min
      end

      PRESET_PROMPTS = {
        'exterior' => 'architectural photography of the building, natural daylight, ' \
                      'clear sky, professional real estate photo, sharp focus',
        'interior' => 'interior architectural photography, soft natural light from windows, ' \
                      'professional real estate photo, sharp focus',
        'dusk'     => 'architectural photography at dusk, warm interior lights, ' \
                      'blue hour sky, professional real estate photo, sharp focus'
      }.freeze

      NEGATIVE = 'blurry, distorted geometry, extra windows, warped walls, ' \
                 'text, watermark, cartoon, illustration'

      def submit(request, on_status:, on_done:, on_error:)
        unless available?
          return on_error.call(Errors::Base.new(
            "找不到本機生成環境（#{python_bin}）。請先建立 .venv-gen 並執行 tools/download_models.py",
            code: 'GEN-01'
          ))
        end

        assets = request[:assets] || request['assets'] || {}
        beauty = assets[:beauty] || assets['beauty']
        unless beauty && File.exist?(beauty.to_s)
          return on_error.call(Errors::Base.new('缺少 beauty pass，無法生成', code: 'GEN-02'))
        end

        # 成品放在使用者找得到、而且不會被系統清掉的地方。
        #
        # 先前放 Sketchup.temp_dir，那是 /var/folders/<亂碼>/T/... ——
        # Finder 預設不顯示，路徑是一串雜湊，而且 macOS 會自動清理。
        # 使用者跑了 60 秒的成品，重開機可能就沒了。
        #
        # 資料夾名用可讀的時間戳而不是 epoch，這樣按時間排序就是按產出順序。
        job_dir = File.join(output_root, Time.now.strftime('%Y-%m-%d_%H%M%S'))
        mkdir_p(job_dir)

        plan     = request[:plan] || {}
        fidelity = request[:fidelity] || 0.6
        preset   = (request[:preset] || 'exterior').to_s
        prompt   = [request[:prompt].to_s.strip, PRESET_PROMPTS[preset]].reject(&:empty?).join(', ')

        controls = {}
        %i[edge depth].each do |k|
          p = assets[k] || assets[k.to_s]
          controls[k] = p.to_s if p && File.exist?(p.to_s)
        end

        spec = {
          prompt: prompt,
          negative_prompt: NEGATIVE,
          init_image: beauty.to_s,
          controls: controls,
          weights: weights_for(fidelity),
          # 生成解析度受本機記憶體限制，與擷取的 1024 不同 ——
          # 三個 pass 一起降，像素對齊仍然成立。
          width: 640, height: 640,
          seed: request[:seed] || rand(1 << 31),
          steps: 30, cfg: 7.5, denoise: DENOISE,
          output: File.join(job_dir, 'result.png'),
          status: File.join(job_dir, 'status.json')
        }

        spec_path = File.join(job_dir, 'job.json')
        File.write(spec_path, JSON.generate(spec))

        # 用 shell 的 & 把行程丟到背景，system 立刻返回。
        # 不用 Process.spawn 是因為它在 SketchUp 內的行為未經驗證，
        # 而 shell 背景化是最保守可靠的做法。
        # 啟動新的之前先收掉舊的。
        #
        # 這一步是實測踩到的：面板報錯或使用者重按 Render 時，
        # 上一個 Python 行程仍在背景跑。實際看到過 4 個行程同時存在，
        # 而 MPS 是統一記憶體 —— 那正是先前害機器重開的情境。
        # 「使用者看不到它了」不等於「它停了」。
        reap_previous

        log = File.join(job_dir, 'run.log')
        # 把 pid 寫進檔案，這樣即使 Ruby 這邊的狀態丟了也收得回來。
        pid_file = File.join(job_dir, 'pid')
        cmd = "cd #{sh(repo_root)} && PYTORCH_ENABLE_MPS_FALLBACK=1 " \
              "#{sh(python_bin)} -m eval.generate_one #{sh(spec_path)} " \
              "> #{sh(log)} 2>&1 & echo $! > #{sh(pid_file)}"
        system(cmd)
        @current_pid_file = pid_file

        on_status.call(state: 'running', label: '啟動本機生成…')
        poll(spec[:status], spec[:output], log, Time.now, on_status, on_done, on_error)
        nil
      end

      def poll(status_path, output_path, log_path, started_at, on_status, on_done, on_error)
        timer = ::UI.start_timer(POLL_SECONDS, true) do
          begin
            elapsed = Time.now - started_at

            if elapsed > TIMEOUT_SECONDS
              ::UI.stop_timer(timer)
              reap_previous   # 逾時不代表它停了，要真的殺掉
              next on_error.call(Errors::Timeout.new("本機生成逾時（#{TIMEOUT_SECONDS}s）"))
            end

            st = read_status(status_path)
            unless st
              # 狀態檔還沒出現，或正好讀到寫到一半 —— 都當作「還沒好」。
              on_status.call(state: 'running', label: '準備中…',
                             elapsed_ms: (elapsed * 1000).round)
              next
            end

            case st['state']
            when 'succeeded'
              ::UI.stop_timer(timer)
              on_done.call('id' => File.basename(File.dirname(status_path)),
                           'status' => 'succeeded',
                           'result_url' => "file://#{st['result']}",
                           'result_path' => st['result'],
                           'latency_ms' => st['latency_ms'],
                           'device' => st['device'])
            when 'failed'
              ::UI.stop_timer(timer)
              reap_previous
              detail = st['traceback'] || tail(log_path)
              on_error.call(Errors::Base.new(st['label'] || '生成失敗',
                                             code: 'GEN-10', detail: { trace: detail }))
            else
              on_status.call(state: 'running',
                             label: st['label'] || '生成中…',
                             elapsed_ms: (elapsed * 1000).round)
            end
          rescue StandardError => e
            ::UI.stop_timer(timer)
            on_error.call(Errors::Base.new("輪詢失敗：#{e.message}", code: 'GEN-11'))
          end
        end
      end

      def read_status(path)
        return nil unless File.exist?(path)
        JSON.parse(File.read(path))
      rescue JSON::ParserError, Errno::ENOENT
        nil # 讀到寫到一半的檔案，下一輪再試
      end

      def tail(path, lines = 20)
        return nil unless File.exist?(path)
        File.readlines(path).last(lines).join
      rescue StandardError
        nil
      end

      # 收掉先前留下的生成行程。
      #
      # 找的是「這個 repo 底下的 eval.generate_one」，不是所有 python ——
      # 使用者可能有自己的 Python 工作在跑，誤殺別人的行程是不可接受的。
      def reap_previous
        pattern = "#{python_bin} -m eval.generate_one"
        out = `pgrep -f #{sh(pattern)} 2>/dev/null`.to_s.split("\n")
        out.each do |pid|
          next if pid.strip.empty?
          begin
            Process.kill('TERM', pid.strip.to_i)
          rescue StandardError
            # 已經結束了就算了
          end
        end
        out.size
      rescue StandardError
        0
      end

      # 本機生成沒有雲端 job 可取消，但**行程要真的殺掉**。
      # 先前這裡回 false 什麼都不做，結果使用者按 Cancel 或面板報錯後，
      # Python 仍在背景吃記憶體。
      def cancel(_job_id = nil)
        reap_previous.positive?
      end

      def sh(str)
        "'" + str.to_s.gsub("'", "'\\\\''") + "'"
      end
    end
  end
end
