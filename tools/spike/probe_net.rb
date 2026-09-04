# frozen_string_literal: true
#
# Phase 1 尖刺 — EdgeColorMode / raytest / 網路
#
#   load '/Users/benson/sketch-up-202609/tools/spike/probe_net.rb'
#
# 前置（網路那節才需要）：另開終端機執行
#   python3 /Users/benson/sketch-up-202609/tools/spike/echo_server.py
#
# 執行順序是刻意的：**不需要網路的先跑完**，這樣即使網路那節掛掉，
# EdgeColorMode 與 raytest 的結果也已經拿到手。
#
# ⚠️ 會暫時改動顯示設定並建立臨時幾何，兩者都會還原。請用新開的模型跑。
#
# 網路那節是**非同步**的：Sketchup::Http 的回呼跑在主執行緒，
# 所以絕對不能用 sleep 迴圈等它 —— 那會把主執行緒佔住，回呼永遠不會觸發。
# 先前版本就是踩到這個坑，逾時是自己造成的假象。

AR_ROOT  = File.expand_path('../..', File.dirname(__FILE__)) unless defined?(AR_ROOT)
ECHO_URL = 'http://127.0.0.1:8787/upload'                     unless defined?(ECHO_URL)
NET_OUT  = File.join(Sketchup.temp_dir, 'architech_net')      unless defined?(NET_OUT)
Dir.mkdir(NET_OUT) unless File.directory?(NET_OUT)

def step(label)
  print "  → #{label} ... "
  t = Time.now
  begin
    r = yield
    puts "#{r} (#{((Time.now - t) * 1000).round} ms)"
    r
  rescue StandardError, ScriptError => e
    puts "失敗"
    puts "     #{e.class}: #{e.message[0, 100]}"
    e.backtrace.first(3).each { |l| puts "       #{l}" }
    :failed
  end
end

model = Sketchup.active_model
view  = model.active_view

puts "\n===== EdgeColorMode / raytest / 網路 尖刺 ====="

# ==========================================================================
puts "\n[A] SHA-256"
# 外掛啟動時已從 Plugins 符號連結載過，重複 load 會讓 Ruby 視為不同檔案
# 而重複定義常數。已經在就直接用。
unless defined?(ArchitechRender::Net::DigestUtil)
  load File.join(AR_ROOT, 'src', 'architech_render', 'net', 'digest_util.rb')
end
DU = ArchitechRender::Net::DigestUtil unless defined?(DU)

puts "     偵測過程：#{DU.detect_log.inspect}"
step("後端") do
  { digest: 'Digest::SHA256（最理想）', openssl: 'OpenSSL（可用）',
    pure_ruby: '純 Ruby（可用但慢）' }[DU.backend] || DU.backend.to_s
end
step("標準向量") do
  got = DU.hexdigest('abc')
  raise "不符：#{got}" unless got == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  'OK'
end

# ==========================================================================
puts "\n[B] EdgeColorMode 語意（不需網路）"
puts "     方法：ForegroundColor 設純紅，看哪些值會讓線變紅"

unless defined?(ArchitechRender::Capture::OptionsKeys)
  load File.join(AR_ROOT, 'src', 'architech_render', 'capture', 'options_keys.rb')
end
unless defined?(ArchitechRender::Capture::ViewState)
  load File.join(AR_ROOT, 'src', 'architech_render', 'capture', 'view_state.rb')
end
K  = ArchitechRender::Capture::OptionsKeys unless defined?(K)
VS = ArchitechRender::Capture::ViewState   unless defined?(VS)

op = false
begin
  model.start_operation('Architech Net Probe', true)
  op = true
  m_in = 39.3701
  g = model.active_entities.add_group
  f = g.entities.add_face(
    Geom::Point3d.new(-1 * m_in, 0, 0), Geom::Point3d.new(1 * m_in, 0, 0),
    Geom::Point3d.new(1 * m_in, 0, 2 * m_in), Geom::Point3d.new(-1 * m_in, 0, 2 * m_in)
  )
  mat = model.materials.add('ArchitechEdgeProbe')
  mat.color = Sketchup::Color.new(30, 200, 90)
  f.material = mat
  f.pushpull(0.5 * m_in) if f.respond_to?(:pushpull)

  view.camera.set(Geom::Point3d.new(0, -6 * m_in, 2 * m_in),
                  Geom::Point3d.new(0, 0, 1 * m_in), Geom::Vector3d.new(0, 0, 1))

  VS.with_temporary(model) do
    ro = model.rendering_options
    ro[K::RENDER_MODE]      = K::RENDER_MODE_MONOCHROME
    ro[K::TEXTURE]          = false
    ro[K::BACKGROUND_COLOR] = Sketchup::Color.new(255, 255, 255)
    ro[K::DRAW_GROUND]      = false
    ro[K::DRAW_HORIZON]     = false
    ro[K::FOREGROUND_COLOR] = Sketchup::Color.new(255, 0, 0)
    model.shadow_info[K::SHADOW_DISPLAY] = false

    (0..3).each do |mode|
      step("EdgeColorMode = #{mode}") do
        ro[K::EDGE_COLOR_MODE] = mode
        view.refresh
        path = File.join(NET_OUT, "edgecolor_#{mode}.png")
        ok = view.write_image(filename: path, width: 400, height: 300)
        "寫檔=#{ok} 讀回=#{ro[K::EDGE_COLOR_MODE]} bytes=#{File.exist?(path) ? File.size(path) : 0}"
      end
    end
  end

  puts "\n[C] raytest 速度（決定 journal 006 的 fog 範圍缺陷能不能修）"
  puts "     目標：32x32 = 1024 條射線 < 200 ms"
  [8, 16, 32].each do |n|
    step("#{n}x#{n} = #{n * n} 條") do
      hits = 0
      t = Time.now
      n.times do |iy|
        n.times do |ix|
          r = view.pickray((ix + 0.5) * view.vpwidth / n, (iy + 0.5) * view.vpheight / n)
          hits += 1 if r && model.raytest(r)
        end
      end
      "#{((Time.now - t) * 1000).round} ms，命中 #{hits}/#{n * n}"
    end
  end
rescue StandardError => e
  puts "！[B]/[C] 例外：#{e.class}: #{e.message}"
ensure
  model.abort_operation if op
  view.refresh
end

# ==========================================================================
# 網路：非同步。不能 sleep 等回呼 —— 回呼跑在主執行緒。
# ==========================================================================
puts "\n[D] Sketchup::Http 送二進位（非同步，結果會在下面陸續出現）"

test_png = File.join(NET_OUT, 'payload.png')
view.write_image(filename: test_png, width: 512, height: 512)
RAW = File.binread(test_png) unless defined?(RAW)
SHA = DU.hexdigest(RAW)      unless defined?(SHA)
puts "     本機：#{RAW.bytesize} bytes  sha256=#{SHA[0, 16]}…  開頭=#{RAW[0, 8].unpack1('H*')}"
puts "     PNG 的開頭應為 89504e470d0a1a0a。伺服器收到的若不同，代表二進位被破壞。"

module ArchitechNetProbe
  TIMEOUT = 8

  def self.request(label, method, url, headers, body, &done)
    print "  → #{label} ... "
    t0 = Time.now
    finished = false

    req = Sketchup::Http::Request.new(url, method)
    req.headers = headers unless headers.empty?
    req.body = body if body

    timer = UI.start_timer(TIMEOUT, false) do
      next if finished
      finished = true
      puts "逾時 #{TIMEOUT}s（echo server 沒開？）"
      done.call(nil)
    end

    req.start do |_r, res|
      next if finished
      finished = true
      UI.stop_timer(timer)
      puts "status=#{res.status_code} (#{((Time.now - t0) * 1000).round} ms)"
      done.call(res)
    end
  rescue StandardError => e
    puts "失敗 #{e.class}: #{e.message[0, 80]}"
    done.call(nil)
  end

  def self.run
    request('GET / 確認 echo server', Sketchup::Http::GET,
            ECHO_URL.sub('/upload', '/'), {}, nil) do |res|
      unless res
        puts "\n  echo server 沒開，網路項目到此為止。"
        puts "  【終端機】python3 #{AR_ROOT}/tools/spike/echo_server.py"
        next finish
      end
      put_binary
    end
  end

  def self.put_binary
    request('PUT image/png', Sketchup::Http::PUT, ECHO_URL,
            { 'Content-Type' => 'image/png' }, RAW) do |res|
      report(res, 'image/png')
      put_octet
    end
  end

  def self.put_octet
    request('PUT application/octet-stream', Sketchup::Http::PUT, ECHO_URL,
            { 'Content-Type' => 'application/octet-stream' },
            RAW.dup.force_encoding(Encoding::ASCII_8BIT)) do |res|
      report(res, 'octet-stream')
      finish
    end
  end

  def self.report(res, label)
    return unless res
    puts "     伺服器回覆：#{res.body}"
    ok_len = res.body.to_s.include?("\"bytes_received\": #{RAW.bytesize}")
    ok_sha = res.body.to_s.include?(SHA)
    ok_hdr = res.body.to_s.include?('89504e470d0a1a0a')
    verdict = (ok_len && ok_sha && ok_hdr) ? '完整' : '**內容不符 —— 二進位被破壞**'
    puts "     #{label}: byte 數#{ok_len ? '✓' : '✗'} sha256#{ok_sha ? '✓' : '✗'} " \
         "PNG 開頭#{ok_hdr ? '✓' : '✗'} → #{verdict}"
  end

  def self.finish
    puts "\n===== 完成 ====="
    puts "modified? = #{Sketchup.active_model.modified?}"
    puts "輸出目錄：#{NET_OUT}"
    puts "\n註：net/http 這條路已確認不可用（socket.so 不存在），"
    puts "    所以 Sketchup::Http 是唯一的網路選項。上面的結果決定它能不能用。"
  end
end

ArchitechNetProbe.run
puts "\n（網路測試進行中，結果會陸續出現在上方…）"
