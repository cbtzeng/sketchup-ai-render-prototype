# frozen_string_literal: true

require 'digest'
require 'json'

module ArchitechRender
  module Net
    # 把控制圖上傳到雲端發的簽名 URL。
    #
    # 這個模組唯一的非顯而易見之處：**上傳後必須比對 sha256**。
    # 二進位 body 若被當成文字處理，伺服器一樣會回 200，PNG 卻已經壞了。
    # 只看狀態碼的上傳流程會讓壞掉的控制圖一路送進 ControlNet，
    # 而症狀是「結果莫名其妙很差」，幾乎查不出來。
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

          # 伺服器沒回 sha256 時不能當作通過。
          # 「無法驗證」和「驗證通過」是兩回事，這裡不做樂觀假設。
          if remote_digest.nil?
            callback.call(
              Errors::Base.new('伺服器沒有回傳 sha256，無法確認上傳完整性',
                               code: 'NET-31', detail: { url: url }),
              nil
            )
          elsif remote_digest != local_digest
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
