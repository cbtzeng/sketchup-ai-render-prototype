# frozen_string_literal: true

module ArchitechRender
  module Net
    # SHA-256，不使用 `require 'digest'`。
    #
    # 為什麼不能直接 require：SketchUp 2026 的 Ruby **幾乎沒有原生擴充檔**
    # （整個 lib 目錄只有 debug.bundle 與 rbs_extension.bundle）。
    # `require 'digest'` 會走到 digest/loader.rb，它去載入不存在的 digest.so，
    # 直接拋 LoadError。
    #
    # 但功能其實是在的 —— Init_digest / Init_sha1 / Init_sha2 / Init_openssl
    # 都靜態連進了 Ruby 二進位檔（用 nm 驗證過）。所以正確做法是
    # **探測已經存在的東西，而不是要求載入檔案**。
    #
    # 三層回退，載入期決定一次：
    #   1. Digest::SHA256 已經定義（最可能，因為 Init_sha2 靜態連入）
    #   2. OpenSSL::Digest::SHA256（openssl 亦為靜態連入，dump_env 已驗證可 require）
    #   3. 純 Ruby 實作（保證正確，但慢；1MB 大約要數百毫秒）
    #
    # 這是外掛在使用者機器上「能不能上傳」的關鍵路徑，
    # 不能因為某台機器的 Ruby 打包方式不同就整個不能用。
    module DigestUtil
      class << self
        attr_reader :backend
      end

      # 已知向量：sha256("abc")。用「真的算一次」來判斷後端可不可用，
      # 而不是檢查常數存不存在 —— 常數檢查會被 autoload、部分載入、
      # 相依缺失等狀況騙過去，而我們真正要問的問題只有一個：
      # 「這條路能不能算出正確的 SHA-256？」
      KNOWN_INPUT  = 'abc'
      KNOWN_DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

      CANDIDATES = [
        [:digest, lambda do |data|
          require 'digest'
          require 'digest/sha2'   # Digest::SHA256 在這裡才會被定義
          ::Digest::SHA256.hexdigest(data)
        end],
        [:openssl, lambda do |data|
          require 'openssl'
          # 這條路不需要 OpenSSL::Digest::SHA256 常數，
          # 在 openssl/digest.rb 的相依有問題時仍可能可用。
          ::OpenSSL::Digest.digest('SHA256', data).unpack1('H*')
        end],
        [:pure_ruby, ->(data) { PureSha256.hexdigest(data) }]
      ].freeze

      # 實測在同一台機器上看過兩種相反結果 —— 有時 require 'digest' 直接
      # LoadError（找不到 digest.so），有時完全正常。原因未明（見 journal 008）。
      # 所以這裡不做任何靜態假設，每次載入都實際驗證一遍。
      def self.detect!
        @detect_log = []
        CANDIDATES.each do |name, fn|
          begin
            got = fn.call(KNOWN_INPUT)
            if got == KNOWN_DIGEST
              @detect_log << "#{name}: OK"
              @impl = fn
              return @backend = name
            end
            @detect_log << "#{name}: 算出的值不對（#{got.to_s[0, 16]}…）"
          rescue LoadError => e
            @detect_log << "#{name}: LoadError #{e.message[0, 40]}"
          rescue StandardError, ScriptError => e
            @detect_log << "#{name}: #{e.class}"
          end
        end
        # PureSha256 是自己實作的，理論上不可能走到這裡。
        raise "沒有任何可用的 SHA-256 實作：#{@detect_log.inspect}"
      end

      # 給診斷用：偵測過程中每一層發生了什麼。
      # backend 落到 pure_ruby 時，這是唯一看得出「為什麼」的地方。
      def self.detect_log = @detect_log || []

      def self.hexdigest(data)
        detect! unless @impl
        @impl.call(data)
      end

      def self.file_hexdigest(path)
        hexdigest(File.binread(path))
      end

      # 純 Ruby 的 SHA-256（FIPS 180-4）。只在前兩層都不可用時才會走到。
      # 已用標準測試向量驗證過（空字串、"abc"、448-bit 訊息）。
      module PureSha256
        K = [
          0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
          0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
          0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
          0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
          0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
          0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
          0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
          0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ].freeze

        MASK = 0xffffffff

        def self.rotr(x, n) = ((x >> n) | (x << (32 - n))) & MASK

        def self.hexdigest(message)
          msg = message.dup.force_encoding(Encoding::ASCII_8BIT)
          bit_len = msg.bytesize * 8

          msg += "\x80".b
          msg += "\x00".b while (msg.bytesize % 64) != 56
          msg += [bit_len >> 32, bit_len & MASK].pack('N2')

          h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

          msg.bytes.each_slice(64) do |chunk|
            w = chunk.each_slice(4).map { |b| (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3] }
            (16..63).each do |i|
              s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
              s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
              w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK
            end

            a, b, c, d, e, f, g, hh = h
            64.times do |i|
              s1  = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
              ch  = (e & f) ^ (~e & MASK & g)
              t1  = (hh + s1 + ch + K[i] + w[i]) & MASK
              s0  = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
              maj = (a & b) ^ (a & c) ^ (b & c)
              t2  = (s0 + maj) & MASK
              hh = g; g = f; f = e
              e = (d + t1) & MASK
              d = c; c = b; b = a
              a = (t1 + t2) & MASK
            end

            h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d,
                 h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map { |x| x & MASK }
          end

          h.map { |x| format('%08x', x) }.join
        end
      end

      detect!
    end
  end
end
