# frozen_string_literal: true

require 'json'

module ArchitechRender
  module Net
    # 與雲端編排層對話。
    #
    # 設計原則（architecture.md 第 1 節）：**只送意圖，不送實作參數**。
    # Ruby 端送 `{scene, prompt, preset, fidelity}`，
    # 不送 model id、controlnet 權重、sampler 這類東西 ——
    # 那些放雲端才能熱修，不必讓使用者重裝 RBZ。
    module ApiClient
      class << self
        attr_accessor :base_url, :auth_token
      end
      self.base_url = 'http://127.0.0.1:3000/v1' # 開發預設，正式值由 config.rb 覆寫

      def self.headers
        h = { 'Content-Type' => 'application/json' }
        h['Authorization'] = "Bearer #{auth_token}" if auth_token
        h
      end

      # 取得每個 pass 的簽名上傳 URL
      def self.request_upload_urls(pass_names:, &callback)
        post('/uploads', { passes: pass_names }, &callback)
      end

      # 建立 job。idempotency_key 由雲端依 controls_sha256 + params + user 計算，
      # 但 Ruby 端要把 controls_sha256 帶上去，否則雲端算不出來。
      def self.create_job(scene:, prompt:, preset:, fidelity:, manifest:, plan:, &callback)
        payload = {
          scene: scene,
          prompt: prompt,
          preset: preset,
          fidelity: fidelity,
          controls: manifest.transform_values { |m| m[:sha256] },
          output: { width: plan[:width], height: plan[:height] }
        }
        post('/jobs', payload, &callback)
      end

      def self.get_job(id, &callback)
        get("/jobs/#{id}", &callback)
      end

      def self.cancel_job(id, &callback)
        post("/jobs/#{id}/cancel", {}, &callback)
      end

      def self.get(path, &callback)
        HttpClient.request(method: :get, url: base_url + path, headers: headers) do |err, res|
          deliver(err, res, &callback)
        end
      end

      def self.post(path, payload, &callback)
        HttpClient.request(method: :post, url: base_url + path,
                           headers: headers, body: JSON.generate(payload)) do |err, res|
          deliver(err, res, &callback)
        end
      end

      def self.deliver(err, res, &callback)
        return callback.call(err, nil) if err

        begin
          callback.call(nil, JSON.parse(res.body))
        rescue JSON::ParserError => e
          callback.call(
            Errors::Base.new('伺服器回傳的不是合法 JSON', code: 'NET-50',
                             detail: { error: e.message, body: res.body.to_s[0, 200] }),
            nil
          )
        end
      end
    end
  end
end
