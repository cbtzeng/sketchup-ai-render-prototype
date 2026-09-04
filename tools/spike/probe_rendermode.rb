# Phase 0 補測 — RenderMode 數值對應（在「有材質、有貼圖」的模型上）
#
#   load '/Users/benson/sketch-up-202609/tools/spike/probe_rendermode.rb'
#
# 上一輪的測試模型只有一面無貼圖白牆，導致 RenderMode 2/3/4/7 產出的 PNG
# 位元組完全相同 —— shaded 與 textured 無從區分。這一輪由腳本自己建立
# 「一個貼圖面 + 一個純色面 + 一個預設面」的盒子，讓各模式必然產生差異。
#
# 還原保護與 probe_view.rb 相同：快照檔 + ensure + abort_operation。

module ArchitechRM
  OUT_DIR  = File.join(Sketchup.temp_dir, "architech_rendermode")
  SNAPSHOT = File.join(Sketchup.temp_dir, "architech_snapshot.txt")
  M        = 39.3701

  def self.serialize(v)
    case v
    when Sketchup::Color then "COLOR:#{v.red},#{v.green},#{v.blue},#{v.alpha}"
    when TrueClass, FalseClass, Integer, Float, String then v.to_s
    else "UNSERIALIZABLE:#{v.class}"
    end
  end

  def self.write_snapshot(model)
    File.open(SNAPSHOT, "w") do |f|
      f.puts "# architech rendermode snapshot #{Time.now}"
      model.rendering_options.each_pair { |k, v| f.puts "RO\t#{k}\t#{serialize(v)}" }
      model.shadow_info.each_pair       { |k, v| f.puts "SI\t#{k}\t#{serialize(v)}" }
      cam = model.active_view.camera
      f.puts "CAM\taspect_ratio\t#{cam.aspect_ratio}"
      f.puts "CAM\tfov\t#{cam.fov}"
    end
  end

  # 找一個內建的貼圖材質
  def self.load_textured_material(model)
    roots = [
      "/Applications/SketchUp 2026/SketchUp.app/Contents/Resources/Materials",
      File.join(ENV["HOME"].to_s, "Library/Application Support/SketchUp 2026/SketchUp/Materials")
    ]
    roots.each do |root|
      next unless File.directory?(root)
      Dir.glob(File.join(root, "**", "*.skm")).sort.each do |skm|
        begin
          mat = model.materials.load(skm)
          if mat && mat.respond_to?(:texture) && mat.texture
            puts "使用貼圖材質：#{File.basename(skm)}"
            return mat
          end
        rescue => e
          # 這一個載不起來就換下一個
        end
      end
    end
    puts "！找不到可載入的貼圖材質 —— textured 與 shaded 仍可能無法區分"
    nil
  end

  def self.build_scene(model)
    ents = model.active_entities
    grp  = ents.add_group
    g    = grp.entities

    # 三個相鄰的直立面板，各自不同材質狀態
    mk = lambda do |x0, x1|
      g.add_face(
        Geom::Point3d.new(x0 * M, 0, 0),
        Geom::Point3d.new(x1 * M, 0, 0),
        Geom::Point3d.new(x1 * M, 0, 2 * M),
        Geom::Point3d.new(x0 * M, 0, 2 * M)
      )
    end
    f_tex   = mk.call(-3, -1)   # 貼圖材質
    f_color = mk.call(-1,  1)   # 純色材質
    f_plain = mk.call( 1,  3)   # 預設面（無材質）

    tex = load_textured_material(model)
    f_tex.material = tex if tex

    solid = model.materials.add("ArchitechProbeSolid")
    solid.color = Sketchup::Color.new(200, 60, 60)
    f_color.material = solid

    # 加一個有厚度的量體，讓 hidden-line 與 wireframe 的背面邊線差異看得出來
    box = g.add_face(
      Geom::Point3d.new(-1 * M, 2 * M, 0), Geom::Point3d.new(1 * M, 2 * M, 0),
      Geom::Point3d.new(1 * M, 4 * M, 0),  Geom::Point3d.new(-1 * M, 4 * M, 0)
    )
    box.pushpull(1.5 * M) if box.respond_to?(:pushpull)

    grp
  end

  def self.run
    model = Sketchup.active_model
    view  = model.active_view
    Dir.mkdir(OUT_DIR) unless File.directory?(OUT_DIR)
    write_snapshot(model)

    ro_before = model.rendering_options.to_h
    si_before = model.shadow_info.to_h
    cam       = view.camera
    cam_before = { eye: cam.eye, target: cam.target, up: cam.up, fov: cam.fov }
    modified_before = model.modified?
    op = false
    report = File.join(OUT_DIR, "rendermode_report.txt")

    begin
      model.start_operation("Architech RenderMode Probe", true)
      op = true
      build_scene(model)

      # 固定相機，讓所有模式的取景一致
      cam.set(Geom::Point3d.new(0, -9 * M, 3 * M),
              Geom::Point3d.new(0, 1 * M, 1 * M),
              Geom::Vector3d.new(0, 0, 1))
      model.shadow_info["DisplayShadows"] = true   # 讓 shaded 與 monochrome 有差異
      view.refresh

      File.open(report, "w") do |f|
        f.puts "# RenderMode 補測（有貼圖 + 純色 + 預設面 + 立體量體）"
        f.puts "# #{Time.now}"
        f.puts
        orig = model.rendering_options["RenderMode"]
        f.puts "進場 RenderMode = #{orig}"
        (0..7).each do |m|
          begin
            model.rendering_options["RenderMode"] = m
            view.refresh
            path = File.join(OUT_DIR, "RM_#{m}.png")
            ok = view.write_image(filename: path, width: 640, height: 480)
            f.puts "RenderMode=#{m}\t寫檔=#{ok}\t讀回=#{model.rendering_options['RenderMode']}\tbytes=#{File.exist?(path) ? File.size(path) : 0}"
          rescue => e
            f.puts "RenderMode=#{m}\t！#{e.class}: #{e.message}"
          end
        end
        model.rendering_options["RenderMode"] = orig
      end
    rescue => e
      puts "！例外：#{e.class}: #{e.message}"
      puts e.backtrace.first(5)
    ensure
      model.abort_operation if op
      ro_before.each { |k, v| begin; model.rendering_options[k] = v; rescue; end }
      si_before.each { |k, v| begin; model.shadow_info[k] = v;       rescue; end }
      begin
        cam.set(cam_before[:eye], cam_before[:target], cam_before[:up])
        cam.fov = cam_before[:fov]
      rescue; end
      view.refresh
      diff = ro_before.reject { |k, v| model.rendering_options[k].to_s == v.to_s }
      puts diff.empty? ? "✓ rendering_options 已完全還原" : "！未還原：#{diff.keys.inspect}"
      puts "model.modified? 進場前=#{modified_before} 現在=#{model.modified?}"
      puts "輸出目錄：#{OUT_DIR}"
      puts "報告：#{report}"
    end
  end
end

ArchitechRM.run
