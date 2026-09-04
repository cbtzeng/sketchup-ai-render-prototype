# frozen_string_literal: true

require 'digest'
require 'json'

module ArchitechRender
  module Net
    # 把控制圖上傳到雲端發的簽名 URL。
    #
    # 核心保證：**壞掉的控制圖絕對不能一路送進 ControlNet。**
    # 二進位 body 若被當文字處理，儲存服務一樣回 200，PNG 卻已經壞了，
    # 而症狀是「結果莫名其妙很差」，事後幾乎查不出來。
    #
    # 校驗發生在哪裡（2026-09-04 修訂，見 journal 007）：
    # 這裡**先本機算出 sha256**，隨 create_job 一起送上雲端；
    # 雲端在建 job 時從儲存體重算並比對，不符就回 JOB-42 且不計費。
    #
    # 原本的設計是「要求 PUT 回應帶 sha256，沒帶就視為失敗」。
    # 那條路走不通 —— Supabase Storage 的簽名 URL 上傳幾乎確定不回傳 checksum，
    # 於是每一次上傳都會被判失敗。保證沒有變弱，只是移到做得到的地方。
    #
    # 若儲存體**有**回 sha256，這裡仍然會比對 —— 那是提早一步發現問題的機會，
    # 沒有理由放棄。
    module Uploader
      # assets: { beauty: "/path/a.png", edge: "...", depth: "..." }
      # 依序上傳（不並行 —— 主執行緒單線，並行沒有好處只會更難除錯）。
      # 全部完成呼叫 on_done.call(nil, manifest)；任一失敗即中止並回報。
      def self.upload_all(assets:, signed_urls:, on_progress: nil, &on_done)
        queue    = assets.to_a
        manifest = {}

        step = lambda do
          if queue.empty?
            on_done.call(nil, manifest)
            next
          end

          name, path = queue.shift
          url = signed_urls[name]
          unless url
            on_done.call(Errors::Base.new("缺少 #{name} 的上傳 URL", code: 'NET-40'), nil)
            next
          end

          on_progress&.call(name, assets.size - queue.size, assets.size)

          upload_one(path: path, url: url) do |err, digest|
            if err
              on_done.call(err, nil)
            else
              manifest[name] = { path: path, sha256: digest, bytes: File.size(path) }
              step.call
            end
          end
        end

        step.call
      end

      def self.upload_one(path:, url:, &callback)
        raw = File.binread(path)
        local_digest = Digest::SHA256.hexdigest(raw)

        HttpClient.request(
          method: :put,
          url: url,
          headers: { 'Content-Type' => 'image/png' },
          body: raw
        ) do |err, res|
          next callback.call(err, nil) if err

          remote_digest = extract_digest(res)

          # 儲存體有回 checksum 就當場比對（提早發現）；
          # 沒回也不算失敗 —— 雲端會在 create_job 時重算並比對（JOB-42）。
          # 這裡回傳的 local_digest 就是送上去給雲端比對的那個值。
          if remote_digest && remote_digest != local_digest
            callback.call(Errors::IntegrityFailed.new(local_digest, remote_digest), nil)
          else
            callback.call(nil, local_digest)
          end
        end
      end

      # 伺服器回應中取出 sha256。優先讀 JSON body，其次讀 header。
      def self.extract_digest(res)
        if res.body && !res.body.empty?
          begin
            parsed = JSON.parse(res.body)
            d = parsed['sha256'] || parsed['digest']
            return d.downcase if d.is_a?(String)
          rescue JSON::ParserError
            # 不是 JSON 就往下試 header
          end
        end
        h = res.headers
        return nil unless h.respond_to?(:each)
        h.each do |k, v|
          return Array(v).first.to_s.downcase if k.to_s.downcase == 'x-content-sha256'
        end
        nil
      end
    end
  end
end
