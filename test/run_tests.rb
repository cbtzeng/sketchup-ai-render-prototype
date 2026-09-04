# frozen_string_literal: true
#
# 在 SketchUp 的 Ruby Console 執行：
#   load '/Users/benson/sketch-up-202609/test/run_tests.rb'
#
# ⚠️ 這些測試會暫時改動顯示設定（並還原）。請用新開的空白模型或不重要的模型跑。
#
# 不使用 minitest/autorun —— 它裝的是 at_exit hook，而 SketchUp 不會結束。
# 改為顯式呼叫 Minitest.run。

require 'minitest'
require 'stringio'

# 用 load 而非 require，讓修改後重跑能生效（require 只會執行一次）。
# 逐檔載入而不是走 architech_render.rb，因為那支用的是 require。
AR_ROOT = File.expand_path('..', File.dirname(__FILE__)) unless defined?(AR_ROOT)
%w[
  options_keys view_state alignment passes session
].each { |f| load File.join(AR_ROOT, 'src', 'architech_render', 'capture', "#{f}.rb") }

module ArchitechTestHelper
  def model = Sketchup.active_model
  def view  = Sketchup.active_model.active_view
  def ro    = Sketchup.active_model.rendering_options
  def k     = ArchitechRender::Capture::OptionsKeys
  def vs    = ArchitechRender::Capture::ViewState

  def tmp_dir
    d = File.join(Sketchup.temp_dir, 'architech_test')
    Dir.mkdir(d) unless File.directory?(d)
    d
  end
end

# ---------------------------------------------------------------------------

class ViewStateTest < Minitest::Test
  include ArchitechTestHelper

  def test_snapshot_captures_all_rendering_options
    snap = vs.snapshot(model)
    assert_operator snap.rendering_options.size, :>, 40,
                    "rendering_options 應有 50+ 個 key，實得 #{snap.rendering_options.size}"
    assert snap.camera.key?(:eye)
    assert snap.camera.key?(:fov)
  end

  def test_restore_is_lossless
    snap = vs.snapshot(model)
    ro[k::DISPLAY_FOG] = !ro[k::DISPLAY_FOG]
    ro[k::TEXTURE]     = !ro[k::TEXTURE]
    ro[k::RENDER_MODE] = k::RENDER_MODE_WIREFRAME

    failed = vs.restore(model, snap)
    assert_empty failed, "還原時有 key 失敗：#{failed.inspect}"

    diff = vs.diff(model, snap)
    assert_empty diff, "還原後不一致：#{diff.keys.inspect}"
  end

  # 這是整個專案最重要的測試。
  # 擷取途中拋例外卻沒還原使用者的樣式設定，比出圖失敗嚴重得多，
  # 而且 rendering_options 不進 undo stack，使用者自己也救不回來。
  def test_with_temporary_restores_even_when_block_raises
    before = ro.to_h

    assert_raises(RuntimeError) do
      vs.with_temporary(model) do
        ro[k::DISPLAY_FOG] = true
        ro[k::RENDER_MODE] = k::RENDER_MODE_WIREFRAME
        raise 'boom'
      end
    end

    diff = before.reject { |key, v| vs.equivalent?(ro[key], v) }
    assert_empty diff, "例外後未還原：#{diff.keys.inspect}"
  end

  def test_with_temporary_returns_block_value
    result = vs.with_temporary(model) { 42 }
    assert_equal 42, result
  end

  def test_equivalent_handles_color_and_float
    assert vs.equivalent?(Sketchup::Color.new(1, 2, 3), Sketchup::Color.new(1, 2, 3))
    refute vs.equivalent?(Sketchup::Color.new(1, 2, 3), Sketchup::Color.new(1, 2, 4))
    assert vs.equivalent?(1.0, 1.0 + 1e-9)
    refute vs.equivalent?(1.0, 1.1)
  end
end

# ---------------------------------------------------------------------------

class AlignmentTest < Minitest::Test
  include ArchitechTestHelper
  def a = ArchitechRender::Capture::Alignment

  def test_square_plan_is_square
    p = a.plan(view, long_edge: 1024, aspect: :square)
    assert_equal 1024, p.width
    assert_equal 1024, p.height
  end

  def test_viewport_plan_matches_viewport_aspect
    p = a.plan(view, long_edge: 1024, aspect: :viewport)
    assert_in_delta p.viewport_aspect, p.output_aspect, 0.01
    # 沿用 viewport 長寬比時不應有裁切
    assert_in_delta 1.0, p.visible_width_ratio, 0.01
    refute p.cropped?
  end

  # 對應 journal 002：1512x849 出 1024x1024 會水平裁掉約 44%
  def test_square_output_from_wide_viewport_is_cropped
    skip '此測試需要非正方形的 viewport' if (view.vpwidth.to_f / view.vpheight - 1.0).abs < 0.05
    p = a.plan(view, long_edge: 1024, aspect: :square)
    assert p.cropped?, '寬 viewport 出正方形應判定為裁切'
    assert_in_delta 1.0 / p.viewport_aspect, p.visible_width_ratio, 0.001
  end

  def test_rejects_oversize
    assert_raises(ArgumentError) { a.plan(view, long_edge: 2048) }
  end

  def test_assert_consistent_raises_on_mismatch
    assert a.assert_consistent!(a: [1024, 1024], b: [1024, 1024])
    assert_raises(RuntimeError) { a.assert_consistent!(a: [1024, 1024], b: [1024, 768]) }
  end
end

# ---------------------------------------------------------------------------

class SessionTest < Minitest::Test
  include ArchitechTestHelper
  def a = ArchitechRender::Capture::Alignment
  def s = ArchitechRender::Capture::Session

  def test_run_produces_three_aligned_images_and_restores
    before = ro.to_h
    plan   = a.plan(view, long_edge: 512, aspect: :square)
    result = s.new(model, plan: plan).run(tmp_dir)

    assert_equal %i[beauty edge depth].sort, result.paths.keys.sort
    result.paths.each do |name, path|
      assert File.exist?(path), "#{name} 沒有產出檔案"
      assert_operator File.size(path), :>, 0, "#{name} 產出 0 bytes"
    end

    diff = before.reject { |key, v| vs.equivalent?(ro[key], v) }
    assert_empty diff, "擷取後未還原：#{diff.keys.inspect}"

    refute_nil result.metadata[:passes][:depth][:fog_start_inches]
    refute_nil result.metadata[:passes][:depth][:fog_end_inches]
    assert_operator result.metadata[:passes][:depth][:fog_end_inches], :>,
                    result.metadata[:passes][:depth][:fog_start_inches],
                    'fog 的 end 必須大於 start，否則灰階換算會爆掉'
  end

  def test_depth_metadata_allows_grey_to_metre_roundtrip
    plan   = a.plan(view, long_edge: 256, aspect: :square)
    result = s.new(model, plan: plan).run(tmp_dir)
    m      = result.metadata[:passes][:depth]

    # 灰階 255 應對應 fog start，灰階 0 應對應 fog end
    d0 = k.grey_to_distance(255.0, m[:fog_start_inches], m[:fog_end_inches])
    d1 = k.grey_to_distance(0.0,   m[:fog_start_inches], m[:fog_end_inches])
    assert_in_delta m[:fog_start_inches], d0, 0.01
    assert_in_delta m[:fog_end_inches],   d1, 0.01
  end
end

# ---------------------------------------------------------------------------

puts "\n=== Architech Render 測試 ==="
puts "模型：#{Sketchup.active_model.path.empty? ? '(未存檔的模型)' : Sketchup.active_model.path}"
puts "viewport：#{Sketchup.active_model.active_view.vpwidth.to_i}x#{Sketchup.active_model.active_view.vpheight.to_i}"
puts "modified? 執行前 = #{Sketchup.active_model.modified?}"

# SketchUp 的 $stdout 是 Sketchup::Console，它的 puts 是 private method，
# minitest 的 reporter 直接呼叫 io.puts 會炸。所以把輸出導進 StringIO，
# 跑完再用 Kernel#puts 一次印出。
buffer     = StringIO.new
old_stdout = $stdout
begin
  $stdout = buffer
  Minitest.run(['--verbose'])
ensure
  $stdout = old_stdout
end
puts buffer.string
puts "modified? 執行後 = #{Sketchup.active_model.modified?}"
