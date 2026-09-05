# frozen_string_literal: true
#
#   load '/Users/benson/sketch-up-202609/test/run_tests_staged.rb'
#
# 不使用 minitest 的 runner —— 它的 load_plugins 會掃 $LOAD_PATH，
# 在 SketchUp 環境下是已知的效能風險，而且卡住時完全看不出卡在哪。
# 這支自己跑，每一步都先印出來，所以一定看得到最後停在哪個階段。
#
# ⚠️ 會暫時改動顯示設定（並還原）。請用新開的空白模型跑。

AR_ROOT = File.expand_path('..', File.dirname(__FILE__)) unless defined?(AR_ROOT)

# runner 刻意從 repo 路徑重載，好吃到剛編輯的內容。但外掛已從 Plugins 的
# 符號連結載過同一份檔案，Ruby 視為不同檔案而對每個常數發出重複定義警告
# （幾十行，把真正的訊息淹掉）。重載是我們要的行為，所以壓掉警告而非跳過載入。
def quietly
  old = $VERBOSE
  $VERBOSE = nil
  yield
ensure
  $VERBOSE = old
end

def step(label)
  print "  → #{label} ... "
  t = Time.now
  begin
    result = yield
    puts "OK (#{((Time.now - t) * 1000).round} ms)"
    result
  rescue StandardError, ScriptError => e
    puts "失敗"
    puts "     #{e.class}: #{e.message}"
    e.backtrace.first(4).each { |l| puts "       #{l}" }
    :failed
  end
end

puts "\n===== Architech Render 分階段測試 ====="
puts "模型：#{Sketchup.active_model.path.empty? ? '(未存檔)' : Sketchup.active_model.path}"
puts "viewport：#{Sketchup.active_model.active_view.vpwidth.to_i}x#{Sketchup.active_model.active_view.vpheight.to_i}"
puts "modified? 執行前 = #{Sketchup.active_model.modified?}"

puts "\n[1] 載入模組"
{
  'capture' => %w[options_keys view_state alignment passes session],
  'net'     => %w[errors digest_util http_client uploader api_client poller],
  'jobs'    => %w[local_index],
  'ui'      => %w[bridge dialog]
}.each do |dir, files|
  files.each do |f|
    step("#{dir}/#{f}") { quietly { load File.join(AR_ROOT, 'src', 'architech_render', dir, "#{f}.rb") }; 'OK' }
  end
end
step('net/cloud_backend') { quietly { load File.join(AR_ROOT, 'src', 'architech_render', 'net', 'cloud_backend.rb') }; 'OK' }
step('net/local_backend')  { quietly { load File.join(AR_ROOT, 'src', 'architech_render', 'net', 'local_backend.rb') }; 'OK' }

# 重現 main.rb 的選擇邏輯，而不是硬塞一個 backend。
# 先前這裡寫死 CloudBackend，導致下方「Bridge 注入的是可用的後端」
# 驗的是測試自己剛設的值 —— 測試在對自己說謊，正式環境用哪個完全沒被驗到。
step('config')            { quietly { load File.join(AR_ROOT, 'src', 'architech_render', 'config.rb') }; 'OK' }
step('套用 config 設定')    { ArchitechRender::Config.apply!; ArchitechRender::Config.summary[:http_backend] }

# 呼叫正式環境用的那個方法本身，不是重現它的邏輯。
# 先前這裡複製了一份選擇邏輯，導致 main.rb 的對應那行改寫失敗時測試依然全綠。
step('Config.select_backend!（正式環境用的同一個方法）') do
  ArchitechRender::Config.select_backend!.name.split('::').last
end

M  = Sketchup.active_model
V  = M.active_view
K  = ArchitechRender::Capture::OptionsKeys
VS = ArchitechRender::Capture::ViewState
AL = ArchitechRender::Capture::Alignment
PS = ArchitechRender::Capture::Passes
SE = ArchitechRender::Capture::Session

fails = []
check = lambda do |label, &blk|
  ok = step(label, &blk)
  fails << label if ok == :failed || ok == false
  ok
end


puts "\n[0] 靜態檢查（不需要 SketchUp 狀態）"
check.call("沒有裸的 UI. 呼叫（會被 ArchitechRender::UI 遮蔽）") do
  # ArchitechRender::UI 會在外掛的詞法範圍內遮蔽 SketchUp 的頂層 ::UI。
  # 寫 UI.start_timer 會解析到我們自己的模組並拋
  # NoMethodError: undefined method `start_timer' for ArchitechRender::UI:Module。
  #
  # 這個錯誤只在**執行到那一行**才會出現 —— 對 net/ 這種
  # 「只有真的送出請求才會跑到」的程式碼，等於要到使用者按下 Render
  # 才炸。所以用靜態掃描擋在載入期。
  offenders = []
  Dir.glob(File.join(AR_ROOT, 'src', '**', '*.rb')).each do |f|
    File.readlines(f).each_with_index do |line, i|
      next if line.strip.start_with?('#')          # 註解
      code = line.sub(/#.*$/, '')                  # 去掉行末註解
      code = code.gsub(/'[^']*'|"[^"]*"/, '')      # 去掉字串字面值
      next unless code =~ /(?<![:\w.])UI\.(start_timer|stop_timer|messagebox|openURL)\b/
      offenders << "#{File.basename(f)}:#{i + 1}"
    end
  end
  raise "發現裸的 UI. 呼叫：#{offenders.join(', ')}" unless offenders.empty?
  "掃描 #{Dir.glob(File.join(AR_ROOT, 'src', '**', '*.rb')).size} 個檔案，無違規"
end

check.call("LocalBackend 的 repo_root 能穿透符號連結") do
  lb = ArchitechRender::Net::LocalBackend
  root = lb.repo_root
  raise "repo_root 不對：#{root}" unless File.directory?(File.join(root, 'eval'))
  raise "找不到 python：#{lb.python_bin}" unless lb.available?
  root
end

puts "\n[2] ViewState"
check.call("snapshot 取得 #{M.rendering_options.to_h.size} 個 key") do
  VS.snapshot(M).rendering_options.size > 40
end

check.call("改設定後 restore 完全一致") do
  snap = VS.snapshot(M)
  M.rendering_options[K::DISPLAY_FOG] = !M.rendering_options[K::DISPLAY_FOG]
  M.rendering_options[K::RENDER_MODE] = K::RENDER_MODE_WIREFRAME
  VS.restore(M, snap)
  d = VS.diff(M, snap)
  raise "還原後不一致：#{d.keys.inspect}" unless d.empty?
  true
end

check.call("block 拋例外時仍還原（最重要的一項）") do
  before = M.rendering_options.to_h
  begin
    VS.with_temporary(M) do
      M.rendering_options[K::DISPLAY_FOG] = true
      raise 'boom'
    end
  rescue RuntimeError => e
    raise "拋出的不是預期的例外：#{e.message}" unless e.message == 'boom'
  end
  d = before.reject { |key, v| VS.equivalent?(M.rendering_options[key], v) }
  raise "例外後未還原：#{d.keys.inspect}" unless d.empty?
  true
end

puts "\n[3] Alignment（純計算，不出圖）"
check.call("square 1024") do
  p = AL.plan(V, long_edge: 1024, aspect: :square)
  raise "尺寸錯：#{p.width}x#{p.height}" unless p.width == 1024 && p.height == 1024
  true
end
check.call("viewport 長寬比不裁切") do
  p = AL.plan(V, long_edge: 1024, aspect: :viewport)
  raise "不該被判定為裁切（ratio=#{p.visible_width_ratio}）" if p.cropped?
  true
end
check.call("寬 viewport 出正方形 → 裁切比例") do
  p = AL.plan(V, long_edge: 1024, aspect: :square)
  puts "\n     viewport 長寬比 #{p.viewport_aspect.round(3)}，" \
       "可見水平範圍 #{(p.visible_width_ratio * 100).round(1)}%，裁掉 #{p.crop_percent}%"
  print "     "
  true
end
check.call("尺寸不一致要拋錯") do
  AL.assert_consistent!(a: [1024, 1024], b: [1024, 1024])
  begin
    AL.assert_consistent!(a: [1024, 1024], b: [1024, 768])
    raise "應該拋錯卻沒有"
  rescue RuntimeError
    true
  end
end

puts "\n[4] 單一 pass 出圖（逐個測，找出是哪個 pass 卡住）"
dir = File.join(Sketchup.temp_dir, 'architech_test')
Dir.mkdir(dir) unless File.directory?(dir)

[PS::Beauty, PS::Edge, PS::Depth].each do |pass|
  check.call("#{pass.name} 套用設定") do
    VS.with_temporary(M) { pass.apply(M, V) }
    true
  end
end

check.call("write_image 256x256（不開 antialias）") do
  path = File.join(dir, 'plain.png')
  ok = V.write_image(filename: path, width: 256, height: 256)
  raise "write_image 回 #{ok.inspect}" unless ok && File.exist?(path)
  true
end

check.call("write_image 256x256（開 antialias — 嫌疑對象）") do
  path = File.join(dir, 'aa.png')
  ok = V.write_image(filename: path, width: 256, height: 256, antialias: true)
  raise "write_image 回 #{ok.inspect}" unless ok && File.exist?(path)
  true
end

puts "\n[5] 完整 Session（三 pass）"
check.call("Session#run 256x256") do
  before = M.rendering_options.to_h
  plan   = AL.plan(V, long_edge: 256, aspect: :square)
  res    = SE.new(M, plan: plan).run(dir)
  raise "pass 數不對：#{res.paths.keys.inspect}" unless res.paths.size == 3
  res.paths.each { |n, p| raise "#{n} 沒產出" unless File.exist?(p) && File.size(p) > 0 }
  d = before.reject { |key, v| VS.equivalent?(M.rendering_options[key], v) }
  raise "擷取後未還原：#{d.keys.inspect}" unless d.empty?
  dm = res.metadata[:passes][:depth]
  puts "\n     fog #{dm[:fog_start_m].round(2)}m ~ #{dm[:fog_end_m].round(2)}m（來源 #{dm[:fog_range_source]}）"
  puts "     三 pass 耗時 #{res.elapsed.round(3)}s"
  print "     "
  true
end

puts "\n[6] net / jobs / ui（不觸網，只驗邏輯與接線）"
E  = ArchitechRender::Net::Errors
LI = ArchitechRender::Jobs::LocalIndex

check.call("SHA-256 後端可用（SketchUp 沒有 digest.so）") do
  du = ArchitechRender::Net::DigestUtil
  got = du.hexdigest('abc')
  want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  raise "雜湊值不對：#{got}" unless got == want
  "後端 = #{du.backend}"
end

check.call("錯誤分類：4xx 不重試、5xx 可重試") do
  raise '400 不該可重試' if E.from_status(400).retryable?
  raise '500 應該可重試' unless E.from_status(500).retryable?
  raise '401 應為 NET-22' unless E.from_status(401).code == 'NET-22'
  raise '200 應回 nil'    unless E.from_status(200).nil?
  true
end

check.call("完整性錯誤可重試（可能只是傳輸壞掉）") do
  E::IntegrityFailed.new('a', 'b').retryable?
end

check.call("LocalIndex 記錄 → 讀回 → 遺忘（spec F5）") do
  # 這一項會寫 model 的 attribute dictionary，本來就會把 model 標成 dirty ——
  # 那是 LocalIndex 的正常行為（job 要跟著 .skp 走）。
  # 記下進場前的狀態，結尾才知道 dirty 是這一項造成的、不是擷取造成的。
  $li_modified_before = M.modified?
  LI.forget(M, 'test-job-1')
  LI.record(M, 'test-job-1', prompt: 'hello', scene: 'Scene 1')
  found = LI.pending(M).find { |e| e['job_id'] == 'test-job-1' }
  raise '記錄後讀不到' unless found
  raise "prompt 沒存到：#{found.inspect}" unless found['prompt'] == 'hello'
  LI.forget(M, 'test-job-1')
  raise '遺忘後仍讀得到' if LI.pending(M).any? { |e| e['job_id'] == 'test-job-1' }
  true
end

check.call("本機生成環境存在") do
  lb = ArchitechRender::Net::LocalBackend
  raise "找不到 #{lb.python_bin}" unless lb.available?
  "python = #{lb.python_bin}"
end

check.call("fidelity 映射到 ControlNet 權重") do
  lb = ArchitechRender::Net::LocalBackend
  lo = lb.weights_for(0.0)
  hi = lb.weights_for(1.0)
  raise "低保真的權重不該比高保真大：#{lo.inspect} vs #{hi.inspect}" unless hi[:edge] > lo[:edge] && hi[:depth] > lo[:depth]
  "0.0→#{lo.inspect}  1.0→#{hi.inspect}"
end

check.call("denoise 不隨 fidelity 變動（兩個獨立的軸）") do
  lb = ArchitechRender::Net::LocalBackend
  raise 'denoise 應為固定值' unless lb.const_defined?(:DENOISE)
  # 下限不得低於 0.55 —— 實測 0.48 時建築量體整個跑掉
  lo = lb.weights_for(0.0)[:edge]
  raise "edge 權重下限太低（#{lo}），結構會跑掉" if lo < 0.55
  "denoise 固定 #{lb::DENOISE}，edge 權重 #{lo}..#{lb.weights_for(1.0)[:edge]}"
end

check.call("Bridge 注入的是可用的後端（不是 stub）") do
  b = ArchitechRender::UI::Bridge.backend
  raise 'backend 是 nil，會走模擬後端' if b.nil?
  raise "backend 沒有 submit：#{b.inspect}" unless b.respond_to?(:submit)
  raise 'backend 沒有 cancel' unless b.respond_to?(:cancel)
  b.name.split('::').last
end

check.call("Session 的 on_pass 會逐個回報（spec 2.1 的 1/3 → 2/3 → 3/3）") do
  seen = []
  plan = AL.plan(V, long_edge: 128, aspect: :square)
  SE.new(M, plan: plan).run(dir, on_pass: ->(name, i, total) { seen << [name, i, total] })
  raise "回報次數不對：#{seen.inspect}" unless seen.length == 3
  raise "順序或編號不對：#{seen.inspect}" unless seen.map { |x| x[1] } == [1, 2, 3]
  seen.map { |x| x[0] }.join(' → ')
end

puts "\n===== 結果 ====="
if fails.empty?
  puts "全部通過"
else
  puts "#{fails.size} 項失敗："
  fails.each { |f| puts "  ✗ #{f}" }
end
puts "modified? 執行後 = #{Sketchup.active_model.modified?}"
puts "輸出目錄：#{dir}"
