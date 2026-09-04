# frozen_string_literal: true

module ArchitechRender
  module Net
    # 錯誤分類與短診斷碼。
    #
    # 診斷碼會顯示在面板上，使用者回報問題時可以直接對照，
    # 不必描述「就是有個錯誤視窗」。碼一旦發布就不要改動含義。
    #
    # 對應 docs/architecture.md 第 4 節的失敗分類表。
    module Errors
      class Base < StandardError
        attr_reader :code, :detail

        def initialize(message, code:, detail: nil)
          @code   = code
          @detail = detail
          super(message)
        end

        # 是否值得重試。判斷準則：重試有機會成功嗎？
        # 參數錯誤、額度不足重試一百次也是一樣的結果，只是浪費時間和錢。
        def retryable? = false

        def to_h
          { ok: false, code: @code, message: message, detail: @detail }
        end
      end

      # NET-1x：連線層
      class ConnectionFailed < Base
        def initialize(msg = '無法連線到伺服器', detail: nil)
          super(msg, code: 'NET-10', detail: detail)
        end
        def retryable? = true
      end

      class Timeout < Base
        def initialize(msg = '請求逾時', detail: nil)
          super(msg, code: 'NET-11', detail: detail)
        end
        def retryable? = true
      end

      class TlsFailed < Base
        # 這個特別標出來，是因為 SketchUp 的 OpenSSL 預設 CA 路徑指向打包機器，
        # 在使用者機器上不存在。看到這個碼幾乎可以確定是 ca_file 沒設對，
        # 而不是使用者的網路有問題 —— 訊息要講清楚，否則沒人查得出來。
        def initialize(msg = 'TLS 憑證驗證失敗（多半是 CA 檔路徑問題，不是你的網路）', detail: nil)
          super(msg, code: 'NET-12', detail: detail)
        end
        def retryable? = false
      end

      # NET-2x：伺服器回應
      class ServerError < Base
        attr_reader :status
        def initialize(status, body = nil)
          @status = status
          super("伺服器錯誤 #{status}", code: 'NET-20', detail: body)
        end
        def retryable? = true
      end

      class ClientError < Base
        attr_reader :status
        # 4xx 一律不重試。對著會失敗的請求反覆送，只會燒錢又拖慢使用者。
        def initialize(status, body = nil)
          @status = status
          super("請求被拒絕 #{status}", code: 'NET-21', detail: body)
        end
        def retryable? = false
      end

      # 這兩個獨立於 ClientError 而不是繼承它 —— 繼承會需要繞過父類別的
      # initialize 簽名，那種寫法很脆弱。它們都不可重試，語意上已足夠。
      class Unauthorized < Base
        def initialize(body = nil)
          super('授權已過期，請重新登入', code: 'NET-22', detail: body)
        end
      end

      class QuotaExceeded < Base
        def initialize(body = nil)
          super('已達今日用量上限', code: 'NET-23', detail: body)
        end
      end

      # NET-3x：資料完整性
      class IntegrityFailed < Base
        # 上傳「成功」但內容對不上。二進位被當文字處理時伺服器一樣回 200，
        # 所以這是必須主動比對才抓得到的錯誤。
        def initialize(expected, actual)
          super('上傳的檔案內容與本機不符（可能是二進位被破壞）',
                code: 'NET-30', detail: { expected: expected, actual: actual })
        end
        def retryable? = true
      end

      # 依 HTTP 狀態碼挑出對應的錯誤類別
      def self.from_status(status, body = nil)
        case status
        when 200..299 then nil
        when 401, 403 then Unauthorized.new(body)
        when 402, 429 then QuotaExceeded.new(body)
        when 400..499 then ClientError.new(status, body)
        else ServerError.new(status, body)
        end
      end
    end
  end
end
