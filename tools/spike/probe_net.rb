# frozen_string_literal: true
#
# Phase 1 尖刺 — 網路、EdgeColorMode、raytest 速度
#
#   load '/Users/benson/sketch-up-202609/tools/spike/probe_net.rb'
#
# 前置：請先在另一個終端機視窗執行本機 echo server
#   python3 /Users/benson/sketch-up-202609/tools/spike/echo_server.py
# 沒開也可以跑，網路那幾項會標為 SKIP，其餘照跑。
#
# 對外連線：只有 [C] 節會對 https://example.com 發一次 HEAD，
# 用來驗證 TLS 憑證鏈。不送任何專案資料。
#
# ⚠️ [D] 節會暫時改動顯示設定並建立臨時幾何，兩者都會還原。請用新開的模型跑。

AR_ROOT = File.expand_path('../..', File.dirname(__FILE__)) unless defined?(AR_ROOT)
ECHO    = 'http://127.0.0.1:8787/upload'
OUT     = File.join(Sketchup.temp_dir, 'architech_net')
Dir.mkdir(OUT) unless File.directory?(OUT)

def step(label)
  print "  → #{label} ... "
  t = Time.now
  begin
    r = yield
    puts r == :skip ? "SKIP" : "#{r} (#{((Time.now - t) * 1000).round} ms)"
  rescue StandardError, ScriptError => e
    puts "失敗"
    puts "     #{e.class}: #{e.message}"
    e.backtrace.first(3).each { |l| puts "       #{l}" }
  end
end

puts "\n===== 網路 / EdgeColorMode / raytest 尖刺 ====="

# --------------------------------------------------------------------------
puts "\n[A] 準備測試檔"
require 'digest'
test_png = File.join(OUT, 'payload.png')
step("產生一張 512x512 的 PNG") do
  Sketchup.active_model.active_view.write_image(filename: test_png, width: 512, height: 512)
  "#{File.size(test_png)} bytes"
end
raw    = File.binread(test_png)
sha    = Digest::SHA256.hexdigest(raw)
header = raw[0, 8].unpack1('H*')
puts "     sha256 = #{sha}"
puts "     開頭 8 bytes = #{header}   （PNG 應為 89504e470d0a1a0a）"

# --------------------------------------------------------------------------
puts "\n[B] Sketchup::Http::Request 送二進位（可行性清單 5.2）"
puts "     期待：bytes_received 與 sha256 都與上面相符"

server_up = false
step("確認 echo server 有沒有開") do
  req = Sketchup::Http::Request.new(ECHO.sub('/upload', '/'), Sketchup::Http::GET)
  done = false
  req.start { |_r, res| server_up = (res.status_code == 200); done = true }
  # Sketchup::Http 是非同步的，這裡短暫等待回呼
  60.times { break if done; sleep(0.05) }
  server_up ? "已開啟" : "未開啟（後續網路項目會 SKIP）"
end

step("PUT 二進位 body") do
  next :skip unless server_up
  req = Sketchup::Http::Request.new(ECHO, Sketchup::Http::PUT)
  req.headers = { 'Content-Type' => 'image/png' }
  req.body = raw
  done = nil
  req.start { |_r, res| done = res }
  100.times { break if done; sleep(0.05) }
  next "逾時，沒收到回呼" unless done
  puts "\n     伺服器回覆：#{done.body}"
  print "     "
  "status=#{done.status_code}"
end

step("PUT 明確標記為 binary 的 body（若 API 支援）") do
  next :skip unless server_up
  req = Sketchup::Http::Request.new(ECHO, Sketchup::Http::PUT)
  req.headers = { 'Content-Type' => 'application/octet-stream' }
  # 有些 Ruby HTTP 實作會依字串 encoding 決定要不要轉碼
  req.body = raw.dup.force_encoding(Encoding::ASCII_8BIT)
  done = nil
  req.start { |_r, res| done = res }
  100.times { break if done; sleep(0.05) }
  next "逾時" unless done
  puts "\n     伺服器回覆：#{done.body}"
  print "     "
  "status=#{done.status_code}"
end

# --------------------------------------------------------------------------
puts "\n[C] net/http + OpenSSL 憑證（可行性清單 5.4）"
puts "     背景：DEFAULT_CERT_FILE 指向打包機器路徑，該檔不存在 → 預設驗證應會失敗"

require 'net/http'
require 'openssl'
require 'uri'

CACERT_CANDIDATES = [
  '/Applications/SketchUp 2026/SketchUp.app/Contents/Resources/Tools/cacert.pem',
  '/etc/ssl/cert.pem'
].freeze

step("DEFAULT_CERT_FILE 是否存在") do
  p = OpenSSL::X509::DEFAULT_CERT_FILE
  "#{File.exist?(p)}  (#{p})"
end

CACERT_CANDIDATES.each do |p|
  step("候選 CA 檔存在？ #{File.basename(p)}") { "#{File.exist?(p)}  (#{p})" }
end

step("HTTPS 不指定 ca_file（預期失敗）") do
  uri  = URI('https://example.com')
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.open_timeout = 10
  http.read_timeout = 10
  begin
    http.start { |h| "成功 status=#{h.head('/').code} ← 竟然過了，代表系統另有 CA 來源" }
  rescue OpenSSL::SSL::SSLError => e
    "如預期失敗：#{e.message[0, 80]}"
  end
end

CACERT_CANDIDATES.select { |p| File.exist?(p) }.each do |ca|
  step("HTTPS 指定 ca_file = #{File.basename(ca)}") do
    uri  = URI('https://example.com')
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl     = true
    http.ca_file     = ca
    http.verify_mode = OpenSSL::SSL::VERIFY_PEER
    http.open_timeout = 10
    http.read_timeout = 10
    http.start { |h| "成功 status=#{h.head('/').code}" }
  end
end

step("net/http PUT 二進位到本機 echo") do
  next :skip unless server_up
  uri = URI(ECHO)
  req = Net::HTTP::Put.new(uri)
  req['Content-Type'] = 'image/png'
  req.body = raw
  res = Net::HTTP.start(uri.host, uri.port) { |h| h.request(req) }
  puts "\n     伺服器回覆：#{res.body}"
  print "     "
  "status=#{res.code}"
end

# --------------------------------------------------------------------------
puts "\n[D] EdgeColorMode 語意（edge pass 的邊線顏色是否可控）"
puts "     方法：ForegroundColor 設純紅，看哪些 EdgeColorMode 值會讓線變紅"

model = Sketchup.active_model
view  = model.active_view
load File.join(AR_ROOT, 'src', 'architech_render', 'capture', 'options_keys.rb')
load File.join(AR_ROOT, 'src', 'architech_render', 'capture', 'view_state.rb')
K  = ArchitechRender::Capture::OptionsKeys
VS = ArchitechRender::Capture::ViewState

op = false
begin
  model.start_operation('Architech Net Probe', true)
  op = true
  g = model.active_entities.add_group
  m_inches = 39.3701
  f = g.entities.add_face(
    Geom::Point3d.new(-1 * m_inches, 0, 0), Geom::Point3d.new(1 * m_inches, 0, 0),
    Geom::Point3d.new(1 * m_inches, 0, 2 * m_inches), Geom::Point3d.new(-1 * m_inches, 0, 2 * m_inches)
  )
  mat = model.materials.add('ArchitechEdgeProbe')
  mat.color = Sketchup::Color.new(30, 200, 90)   # 鮮綠，好分辨
  f.material = mat
  f.pushpull(0.5 * m_inches) if f.respond_to?(:pushpull)

  view.camera.set(Geom::Point3d.new(0, -6 * m_inches, 2 * m_inches),
                  Geom::Point3d.new(0, 0, 1 * m_inches),
                  Geom::Vector3d.new(0, 0, 1))

  VS.with_temporary(model) do
    ro = model.rendering_options
    ro[K::RENDER_MODE]      = K::RENDER_MODE_MONOCHROME
    ro[K::TEXTURE]          = false
    ro[K::BACKGROUND_COLOR] = Sketchup::Color.new(255, 255, 255)
    ro[K::DRAW_GROUND]      = false
    ro[K::DRAW_HORIZON]     = false
    ro[K::FOREGROUND_COLOR] = Sketchup::Color.new(255, 0, 0)   # 純紅
    model.shadow_info[K::SHADOW_DISPLAY] = false

    (0..3).each do |mode|
      step("EdgeColorMode = #{mode}") do
        ro[K::EDGE_COLOR_MODE] = mode
        view.refresh
        path = File.join(OUT, "edgecolor_#{mode}.png")
        ok = view.write_image(filename: path, width: 400, height: 300)
        "寫檔=#{ok} 讀回=#{ro[K::EDGE_COLOR_MODE]} bytes=#{File.exist?(path) ? File.size(path) : 0}"
      end
    end
  end

  # ------------------------------------------------------------------------
  puts "\n[E] raytest 速度（決定 journal 006 的 C 方案可不可行）"
  puts "     目標：32x32 = 1024 條射線若 < 200ms，就值得用它取代 model bounds"

  [8, 16, 32].each do |n|
    step("#{n}x#{n} = #{n * n} 條射線") do
      hits = 0
      t = Time.now
      n.times do |iy|
        n.times do |ix|
          x = (ix + 0.5) * view.vpwidth / n
          y = (iy + 0.5) * view.vpheight / n
          r = view.pickray(x, y)
          hits += 1 if r && model.raytest(r)
        end
      end
      ms = ((Time.now - t) * 1000).round
      "#{ms} ms，命中 #{hits}/#{n * n}"
    end
  end
rescue StandardError => e
  puts "！[D]/[E] 發生例外：#{e.class}: #{e.message}"
  puts e.backtrace.first(4)
ensure
  model.abort_operation if op
  view.refresh
end

puts "\n===== 完成 ====="
puts "modified? = #{Sketchup.active_model.modified?}"
puts "輸出目錄：#{OUT}"
