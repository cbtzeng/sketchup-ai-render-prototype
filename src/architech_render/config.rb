# frozen_string_literal: true

module ArchitechRender
  # 所有「你需要自己填」的設定集中在這一個檔案。
  #
  # 刻意不從環境變數讀 —— SketchUp 不是從 shell 啟動的，
  # 它看不到你 .zshrc 裡的東西，那會變成很難查的「為什麼在我機器上不行」。
  #
  # ⚠️ 這個檔案會進版控，**不要把金鑰寫在這裡**。
  #    provider 的金鑰只存在雲端環境變數，Ruby 端永遠不該碰到。
  module Config
    VERSION = '0.1.0'

    # --- 你需要設定的 --------------------------------------------------

    # 雲端 API 的位址。本機開發用 vercel dev 的預設 port。
    # 部署到 Vercel 之後改成 https://<你的專案>.vercel.app/v1
    API_BASE_URL = 'http://127.0.0.1:3000/v1'

    # 短效 token。正式流程應由登入取得，原型階段可先寫死一個測試值，
    # 或留 nil 讓雲端的 unconfiguredAuth 回 501（那是預期行為，不是 bug）。
    AUTH_TOKEN = nil

    # --- 由尖刺結果決定的 ----------------------------------------------

    # :sketchup 或 :net_http
    #
    # 預設 :sketchup。**跑完 tools/spike/probe_net.rb 的 [B] 節再定案**：
    # 若 Sketchup::Http 送二進位會破壞內容（伺服器收到的 sha256 對不上），
    # 就改成 :net_http —— 但要注意 net/http 是同步的會凍結 SketchUp，
    # 真的要走那條路必須先解決讓出主執行緒的問題。
    HTTP_BACKEND = :sketchup

    # --- 通常不用改 ----------------------------------------------------

    DEFAULT_LONG_EDGE = 1024
    MAX_LONG_EDGE     = 1536   # 與 spec 4.2、Capture::Alignment::MAX_EDGE 一致
    REQUEST_TIMEOUT   = 30     # 秒

    def self.apply!
      Net::ApiClient.base_url   = API_BASE_URL
      Net::ApiClient.auth_token = AUTH_TOKEN
      Net::HttpClient.backend   = HTTP_BACKEND
    end

    # 給面板的診斷用。不要回傳 token 本身，只說有沒有設。
    def self.summary
      {
        version: VERSION,
        api_base_url: API_BASE_URL,
        auth_token_set: !AUTH_TOKEN.nil?,
        http_backend: HTTP_BACKEND,
        ca_file: Net::HttpClient.ca_file
      }
    end
  end
end
