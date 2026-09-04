# Phase 0 / Task 0.2 + 0.3 — 顯示行為探查
#
#   load '/Users/benson/sketch-up-202609/tools/spike/probe_view.rb'
#
# ⚠️ 這支腳本會「暫時」改動顯示設定與相機，並建立臨時幾何。
#    三層還原保護：
#      1. 開始前把所有設定寫入 <temp_dir>/architech_snapshot.txt（當機保險）
#      2. 全程包在 ensure 內，正常或例外都會還原
#      3. 臨時幾何建立在 start_operation 內，結束時 abort_operation 完整回滾
#    若仍出問題：load 'tools/spike/restore_snapshot.rb'
#
# 建議在一個「新開的空白模型」上跑，不要在重要的 .skp 上跑。

module ArchitechProbe
  OUT_DIR  = File.join(Sketchup.temp_dir, "architech_probe")
  SNAPSHOT = File.join(Sketchup.temp_dir, "architech_snapshot.txt")
  M        = 39.3701 # 1 公尺 = 39.3701 英吋（SketchUp 內部單位）

  # ---------- 快照與還原 ----------

  def self.serialize(v)
    case v
    when Sketchup::Color then "COLOR:#{v.red},#{v.green},#{v.blue},#{v.alpha}"
    when TrueClass, FalseClass, Integer, Float, String then v.to_s
    else "UNSERIALIZABLE:#{v.class}"
    end
  end

  def self.write_snapshot(model)
    File.open(SNAPSHOT, "w") do |f|
      f.puts "# architech probe snapshot #{Time.now}"
      model.rendering_options.each_pair { |k, v| f.puts "RO\t#{k}\t#{serialize(v)}" }
      model.shadow_info.each_pair       { |k, v| f.puts "SI\t#{k}\t#{serialize(v)}" }
      cam = model.active_view.camera
      f.puts "CAM\taspect_ratio\t#{cam.aspect_ratio}"
      f.puts "CAM\tfov\t#{cam.fov}"
    end
    puts "快照已存：#{SNAPSHOT}"
  end

  def self.capture_state(model)
    {
      ro:  model.rendering_options.to_h,
      si:  model.shadow_info.to_h,
      cam: {
        eye: model.active_view.camera.eye,
        target: model.active_view.camera.target,
        up: model.active_view.camera.up,
        fov: model.active_view.camera.fov,
        aspect_ratio: model.active_view.camera.aspect_ratio,
        perspective: model.active_view.camera.perspective?
      }
    }
  end

  def self.restore_state(model, st)
    st[:ro].each { |k, v| begin; model.rendering_options[k] = v; rescue; end }
    st[:si].each { |k, v| begin; model.shadow_info[k] = v;       rescue; end }
    cam = model.active_view.camera
    begin
      cam.perspective = st[:cam][:perspective]
      cam.set(st[:cam][:eye], st[:cam][:target], st[:cam][:up])
      cam.fov = st[:cam][:fov]
      cam.aspect_ratio = st[:cam][:aspect_ratio]
    rescue => e
      puts "！相機還原失敗：#{e.message}"
    end
  end

  def self.verify_restored(model, st)
    diff = st[:ro].reject { |k, v| model.rendering_options[k].to_s == v.to_s }
    if diff.empty?
      puts "✓ rendering_options 已完全還原"
    else
      puts "！以下 key 未還原：#{diff.keys.inspect}"
      puts "  請執行 load 'tools/spike/restore_snapshot.rb'"
    end
  end

  # ---------- 工具 ----------

  def self.shot(view, name, w, h)
    path = File.join(OUT_DIR, "#{name}.png")
    ok = view.write_image(filename: path, width: w, height: h)
    [name, ok, path, File.exist?(path) ? File.size(path) : 0]
  end

  # ---------- 測試 ----------

  def self.test_dimensions(f, view)
    f.puts "\n## A. viewport vs device 尺寸（Retina 倍率）"
    vw, vh = view.vpwidth, view.vpheight
    f.puts "vpwidth / vpheight         = #{vw} x #{vh}"
    if view.respond_to?(:device_width)
      dw, dh = view.device_width, view.device_height
      f.puts "device_width / device_height = #{dw} x #{dh}"
      f.puts "倍率 (device/vp)             = #{(dw.to_f / vw).round(4)} x #{(dh.to_f / vh).round(4)}"
    else
      f.puts "device_width 不存在"
    end
    cam = view.camera
    f.puts "camera.aspect_ratio         = #{cam.aspect_ratio}"
    f.puts "camera.fov                  = #{cam.fov}"
    f.puts "camera.fov_is_height?       = #{cam.fov_is_height?}" if cam.respond_to?(:fov_is_height?)
    f.puts "camera.image_width          = #{cam.image_width}"    if cam.respond_to?(:image_width)
    f.puts "view.graphics_engine        = #{view.graphics_engine.inspect}" if view.respond_to?(:graphics_engine)
  end

  def self.test_write_image_aspect(f, view)
    f.puts "\n## B. write_image 寬高比行為"
    f.puts "（三張圖請目視比對：被裁切 / 上下加邊 / 看到更多東西）"
    cam  = view.camera
    orig = cam.aspect_ratio
    rows = []
    rows << shot(view, "B1_native_#{view.vpwidth.to_i}x#{view.vpheight.to_i}", view.vpwidth.to_i, view.vpheight.to_i)
    rows << shot(view, "B2_square_ar0", 1024, 1024)
    cam.aspect_ratio = 1.0
    rows << shot(view, "B3_square_ar1", 1024, 1024)
    cam.aspect_ratio = orig
    rows << shot(view, "B4_wide_ar0", 1024, 576)
    rows.each { |n, ok, p, sz| f.puts "#{n}\twrite_image=#{ok}\tbytes=#{sz}" }
  end

  def self.test_render_modes(f, model, view)
    f.puts "\n## C. RenderMode 數值對應"
    ro   = model.rendering_options
    orig = ro["RenderMode"]
    f.puts "目前值 = #{orig}"
    (0..7).each do |mode|
      begin
        ro["RenderMode"] = mode
        view.refresh
        n, ok, _p, sz = shot(view, "C_rendermode_#{mode}", 512, 512)
        f.puts "RenderMode=#{mode}\t寫檔=#{ok}\tbytes=#{sz}\t（讀回=#{ro['RenderMode']}）"
      rescue => e
        f.puts "RenderMode=#{mode}\t！#{e.class}: #{e.message}"
      end
    end
    ro["RenderMode"] = orig
  end

  def self.test_fog_semantics(f, model)
    f.puts "\n## D. fog 的 -1.0 是什麼意思"
    ro = model.rendering_options
    f.puts "初始  Start=#{ro['FogStartDist']}  End=#{ro['FogEndDist']}  UseBk=#{ro['FogUseBkColor']}  Display=#{ro['DisplayFog']}"

    ro["DisplayFog"] = true
    f.puts "開霧後 Start=#{ro['FogStartDist']}  End=#{ro['FogEndDist']}   ← 若數值自己變了，-1.0 就是 auto 哨兵"

    ro["FogStartDist"] = 0.0
    ro["FogEndDist"]   = 60.0 * M
    f.puts "設 0 / 60m 後讀回  Start=#{ro['FogStartDist']}  End=#{ro['FogEndDist']}   ← 若讀回值 ≠ 寫入值，單位不是英吋"

    ro["FogEndDist"] = 30.0 * M
    f.puts "改 End=30m 後讀回  End=#{ro['FogEndDist']}"

    ro["FogStartDist"] = -1.0
    ro["FogEndDist"]   = -1.0
    f.puts "寫回 -1.0 後讀回   Start=#{ro['FogStartDist']}  End=#{ro['FogEndDist']}   ← 若讀回不是 -1.0，代表 -1.0 不可寫入"
  end

  def self.build_calibration_wall(model)
    ents = model.active_entities
    grp  = ents.add_group
    # 2m x 2m 白牆，位於原點，面朝 -Y（相機從 -Y 方向看過來）
    pts = [
      Geom::Point3d.new(-1 * M, 0, -1 * M),
      Geom::Point3d.new( 1 * M, 0, -1 * M),
      Geom::Point3d.new( 1 * M, 0,  1 * M),
      Geom::Point3d.new(-1 * M, 0,  1 * M)
    ]
    face = grp.entities.add_face(pts)
    face.material = nil
    grp
  end

  def self.test_fog_calibration(f, model, view)
    f.puts "\n## E. fog 深度標定（相機退後法：距離明確無歧義）"
    ro = model.rendering_options

    # 只留深度訊號
    ro["DisplayFog"]           = true
    ro["FogUseBkColor"]        = false
    ro["FogColor"]             = Sketchup::Color.new(0, 0, 0)
    ro["BackgroundColor"]      = Sketchup::Color.new(255, 255, 255)
    ro["DrawGround"]           = false
    ro["DrawHorizon"]          = false
    ro["Texture"]              = false
    ro["DisplayColorByLayer"]  = false
    ro["FaceFrontColor"]       = Sketchup::Color.new(255, 255, 255)
    ro["FaceBackColor"]        = Sketchup::Color.new(255, 255, 255)
    ro["EdgeDisplayMode"]      = 0     # 關邊線（0 的語意由 Test C 佐證）
    ro["DrawSilhouettes"]      = false
    ro["AmbientOcclusion"]     = false
    model.shadow_info["DisplayShadows"] = false

    cam = view.camera
    cam.perspective = true
    cam.fov = 35.0

    [[60.0, "end60"], [30.0, "end30"]].each do |end_m, tag|
      ro["FogStartDist"] = 0.0
      ro["FogEndDist"]   = end_m * M
      f.puts "\n-- FogEndDist = #{end_m} m（寫入 #{(end_m * M).round(1)} 英吋，讀回 #{ro['FogEndDist']}）"
      [1, 2, 5, 10, 20, 50].each do |d|
        cam.set(Geom::Point3d.new(0, -d * M, 0), Geom::Point3d.new(0, 0, 0), Geom::Vector3d.new(0, 0, 1))
        view.refresh
        n, ok, _p, sz = shot(view, "E_#{tag}_d#{d}m", 256, 256)
        f.puts "距離 #{d} m\t寫檔=#{ok}\tbytes=#{sz}"
      end
    end
    f.puts "\n（灰階值由 Claude 端讀 PNG 取樣，不在 Ruby 端解碼）"
  end

  def self.test_timing(f, model, view)
    f.puts "\n## F. 三 pass 耗時（1024x1024）"
    ro = model.rendering_options
    t0 = Time.now
    ro["Texture"] = true;  view.refresh; shot(view, "F_beauty", 1024, 1024)
    t1 = Time.now
    ro["Texture"] = false; ro["EdgeDisplayMode"] = 1; view.refresh; shot(view, "F_edge", 1024, 1024)
    t2 = Time.now
    ro["DisplayFog"] = true; view.refresh; shot(view, "F_depth", 1024, 1024)
    t3 = Time.now
    f.puts "beauty = #{(t1 - t0).round(3)}s"
    f.puts "edge   = #{(t2 - t1).round(3)}s"
    f.puts "depth  = #{(t3 - t2).round(3)}s"
    f.puts "合計   = #{(t3 - t0).round(3)}s   （spec 目標 p50 ≤ 3s）"
    f.puts "view.average_refresh_time = #{view.average_refresh_time}" if view.respond_to?(:average_refresh_time)
    f.puts "view.last_refresh_time    = #{view.last_refresh_time}"    if view.respond_to?(:last_refresh_time)
  end

  # ---------- 主流程 ----------

  def self.run
    model = Sketchup.active_model
    view  = model.active_view
    Dir.mkdir(OUT_DIR) unless File.directory?(OUT_DIR)

    write_snapshot(model)
    state         = capture_state(model)
    modified_before = model.modified?
    op_started    = false
    report        = File.join(OUT_DIR, "probe_report.txt")

    begin
      model.start_operation("Architech Probe", true)
      op_started = true
      wall = build_calibration_wall(model)

      File.open(report, "w") do |f|
        f.puts "# Architech Render — Task 0.2/0.3 探查報告"
        f.puts "# #{Time.now}"
        f.puts "# model.modified? 進場前 = #{modified_before}"
        test_dimensions(f, view)
        test_write_image_aspect(f, view)
        test_render_modes(f, model, view)
        test_fog_semantics(f, model)
        test_fog_calibration(f, model, view)
        test_timing(f, model, view)
      end
    rescue => e
      puts "！探查中發生例外：#{e.class}: #{e.message}"
      puts e.backtrace.first(5)
    ensure
      model.abort_operation if op_started      # 臨時幾何完整回滾
      restore_state(model, state)              # 顯示設定還原
      view.refresh
      verify_restored(model, state)
      puts "model.modified? 進場前=#{modified_before} 現在=#{model.modified?}"
      puts
      puts "輸出目錄：#{OUT_DIR}"
      puts "報告：#{report}"
    end
  end
end

ArchitechProbe.run
