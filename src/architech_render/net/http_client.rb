# frozen_string_literal: true

require 'json'

module ArchitechRender
  module Net
    # 傳輸層抽象。
    #
    # 存在兩個後端的理由：`Sketchup::Http` 能不能正確傳送二進位 body
    # **尚未驗證**（可行性清單 5.2 仍是 🔴）。在確認之前，
    # 所有未驗證的假設集中在這個檔案裡，其餘模組完全不受影響 ——
    # 萬一驗證結果是不行，只要改這裡一個檔案，換掉 backend 就好。
    #
    # 全部非同步。Ruby 跑在主 UI 執行緒，任何同步等待都會凍結 SketchUp。
    module HttpClient
      DEFAULT_TIMEOUT = 30

      # SketchUp 自帶的 CA 憑證。優先用它而不是 /etc/ssl/cert.pem —— 跟著
      # SketchUp 走，不依賴使用者的系統狀態。
      # （實測：OpenSSL::X509::DEFAULT_CERT_FILE 指向打包機器路徑，該檔不存在。）
      CA_CANDIDATES = [
        '/Applications/SketchUp 2026/SketchUp.app/Contents/Resources/Tools/cacert.pem',
        '/etc/ssl/cert.pem'
      ].freeze

      Response = Struct.new(:status, :body, :headers, keyword_init: true) do
        def success? = (200..299).cover?(status)
      end

      class << self
        # :sketchup | :net_http
        # 預設值會在 probe_net.rb 驗證 5.2 之後定案。
        attr_accessor :backend
      end
      self.backend = :sketchup

      def self.ca_file
        @ca_file ||= CA_CANDIDATES.find { |p| File.exist?(p) }
      end

      # 唯一對外入口。callback 在主執行緒被呼叫，簽名為 (error, response)。
      # error 為 nil 表示成功。
      def self.request(method:, url:, headers: {}, body: nil, timeout: DEFAULT_TIMEOUT, &callback)
        case backend
        when :sketchup then SketchupBackend.request(method, url, headers, body, timeout, &callback)
        when :net_http then NetHttpBackend.request(method, url, headers, body, timeout, &callback)
        else raise ArgumentError, "未知的 backend：#{backend.inspect}"
        end
      end

      # ----------------------------------------------------------------------
      # Sketchup::Http 後端
      #
      # 🔴 以下三項在 probe_net.rb 跑完之前都是假設，不是已驗證的事實：
      #    1. `Request.new(url, method_constant)` 的建構子簽名
      #    2. response 物件有 `status_code` / `body` / `headers`
      #    3. `body =` 能原封不動送出二進位字串
      # 實測 dump 已確認 Request 的 instance methods 只有：
      #    body, body=, cancel, headers, headers=, method=,
      #    set_download_progress_callback, set_upload_progress_callback,
      #    start, status, url
      # 注意其中**沒有任何逾時設定方法** —— 逾時只能自己計時再 cancel。
      # ----------------------------------------------------------------------
      module SketchupBackend
        METHODS = {
          get:    -> { Sketchup::Http::GET },
          post:   -> { Sketchup::Http::POST },
          put:    -> { Sketchup::Http::PUT },
          delete: -> { Sketchup::Http::DELETE }
        }.freeze

        def self.request(method, url, headers, body, timeout)
          verb = METHODS.fetch(method) { raise ArgumentError, "不支援的 method：#{method}" }.call
          req  = Sketchup::Http::Request.new(url, verb)
          req.headers = headers unless headers.empty?
          req.body    = body if body

          timed_out = false
          finished  = false

          # Sketchup::Http 沒有逾時設定，所以自己計時。
          # 注意 timer 觸發時要先確認請求還沒結束，否則會 cancel 一個已完成的請求。
          timer = UI.start_timer(timeout, false) do
            next if finished
            timed_out = true
            begin
              req.cancel
            rescue StandardError
              # cancel 失敗不影響我們回報逾時
            end
            yield(Errors::Timeout.new(detail: { url: url, seconds: timeout }), nil)
          end

          req.start do |_request, response|
            next if timed_out
            finished = true
            UI.stop_timer(timer)
            handle(response, url) { |err, res| yield(err, res) }
          end

          req
        rescue StandardError => e
          yield(Errors::ConnectionFailed.new(detail: { url: url, error: e.message }), nil)
          nil
        end

        def self.handle(response, url)
          status = response.status_code
          body   = response.body
          err    = Errors.from_status(status, body)
          if err
            yield(err, nil)
          else
            headers = response.respond_to?(:headers) ? response.headers : {}
            yield(nil, Response.new(status: status, body: body, headers: headers))
          end
        rescue StandardError => e
          yield(Errors::ConnectionFailed.new(detail: { url: url, error: e.message }), nil)
        end
      end

      # ----------------------------------------------------------------------
      # net/http 後端
      #
      # 這是 Sketchup::Http 不能送二進位時的退路。
      # 必須顯式指定 ca_file，否則會在 TLS 握手階段靜默失敗 ——
      # 因為 OpenSSL::X509::DEFAULT_CERT_FILE 指向打包機器的路徑（實測不存在）。
      #
      # ⚠️ net/http 是**同步**的，會凍結 SketchUp。這裡不開執行緒
      # （SketchUp 的 Ruby API 不保證 thread-safe），所以只用在
      # 「已知很快」或「Sketchup::Http 不可用」的情況。
      # 若最終要靠這條路徑做上傳，必須改成分塊 + UI.start_timer 讓出主執行緒。
      # ----------------------------------------------------------------------
      module NetHttpBackend
        def self.request(method, url, headers, body, timeout)
          require 'net/http'
          require 'openssl'
          require 'uri'

          uri = URI(url)
          klass = {
            get: ::Net::HTTP::Get, post: ::Net::HTTP::Post,
            put: ::Net::HTTP::Put, delete: ::Net::HTTP::Delete
          }.fetch(method) { raise ArgumentError, "不支援的 method：#{method}" }

          req = klass.new(uri)
          headers.each { |k, v| req[k] = v }
          req.body = body if body

          http = ::Net::HTTP.new(uri.host, uri.port)
          if uri.scheme == 'https'
            http.use_ssl     = true
            http.verify_mode = OpenSSL::SSL::VERIFY_PEER
            ca = HttpClient.ca_file
            if ca
              http.ca_file = ca
            else
              yield(Errors::TlsFailed.new(detail: '找不到任何可用的 CA 憑證檔'), nil)
              return nil
            end
          end
          http.open_timeout = timeout
          http.read_timeout = timeout

          res    = http.start { |h| h.request(req) }
          status = res.code.to_i
          err    = Errors.from_status(status, res.body)
          if err
            yield(err, nil)
          else
            yield(nil, Response.new(status: status, body: res.body, headers: res.to_hash))
          end
          nil
        rescue OpenSSL::SSL::SSLError => e
          yield(Errors::TlsFailed.new(detail: e.message), nil)
          nil
        rescue ::Net::OpenTimeout, ::Net::ReadTimeout => e
          yield(Errors::Timeout.new(detail: e.message), nil)
          nil
        rescue StandardError => e
          yield(Errors::ConnectionFailed.new(detail: { url: url, error: e.message }), nil)
          nil
        end
      end
    end
  end
end
