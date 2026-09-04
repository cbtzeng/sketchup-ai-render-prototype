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
%w[options_keys view_state alignment passes session].each do |f|
  step(f) { load File.join(AR_ROOT, 'src', 'architech_render', 'capture', "#{f}.rb") }
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

puts "\n===== 結果 ====="
if fails.empty?
  puts "全部通過"
else
  puts "#{fails.size} 項失敗："
  fails.each { |f| puts "  ✗ #{f}" }
end
puts "modified? 執行後 = #{Sketchup.active_model.modified?}"
puts "輸出目錄：#{dir}"
