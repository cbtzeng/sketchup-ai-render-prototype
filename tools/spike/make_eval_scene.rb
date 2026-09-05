# frozen_string_literal: true
#
# 用程式建立一個簡單的建築場景並擷取控制圖，讓評估管線能在**真實 SketchUp 輸出**
# 上跑通，不必等你手工建 6 個場景。
#
#   load '/Users/benson/sketch-up-202609/tools/spike/make_eval_scene.rb'
#
# 這**不是** 6 個評估場景的替代品 —— 它只有一種量體，測不出曲面、玻璃、
# 細長構件那些真正會讓結構走鐘的情境。它的用途是「證明管線在真資料上能動」，
# 好讓我們在你建場景的同時就能驗證分析流程。
#
# ⚠️ 會建立臨時幾何並改動顯示設定，兩者都會還原。請用新開的空白模型跑。

AR_ROOT = File.expand_path('../..', File.dirname(__FILE__)) unless defined?(AR_ROOT)
EVAL_CAPTURES = File.join(AR_ROOT, 'eval', 'captures') unless defined?(EVAL_CAPTURES)

# 外掛啟動時已從 Plugins 的符號連結載過這些檔案。從 repo 路徑再 load 一次，
# Ruby 會視為不同檔案而重複定義每一個常數（幾十行警告）。
# 已經在就直接用 —— 符號連結指向同一份原始碼，內容必然一致。
unless defined?(ArchitechRender::Capture::Session)
  %w[options_keys view_state alignment passes session].each do |f|
    load File.join(AR_ROOT, 'src', 'architech_render', 'capture', "#{f}.rb")
  end
end

module ArchitechScene
  M  = 39.3701
  AL = ArchitechRender::Capture::Alignment
  SE = ArchitechRender::Capture::Session

  # 兩個相機角度：一點透視與斜角。刻意不同，讓兩個 shot 不是同一張圖。
  # 相機距離的算法：垂直 FOV 35 度、輸出 1:1，所以在距離 d 時可見高度約
  # 2*d*tan(17.5°) ≈ 0.63d。量體 16m 寬 9m 高，第一版放 26m 剛好被facade塞滿，
  # 變成「一面窗牆」而不是建築 —— 看不到屋頂、側面與側翼，深度圖也幾乎是平的。
  # 拉到 48m 讓可見高度約 30m，量體佔約三分之一，周圍留白給地面與天空。
  CAMERAS = [
    { name: 'cam1', eye: [6, -48, 16],  target: [1, 0, 4] },   # 略偏一點透視
    { name: 'cam2', eye: [-34, -34, 22], target: [3, 0, 4] }   # 斜角，看得到側翼
  ].freeze

  # 材質是必要的，不是裝飾。沒有材質時 beauty pass 就是白牆黑線，
  # 跟 edge pass 幾乎一樣 —— A 組（純 img2img）就沒有「顏色可以漂」，
  # 測不出控制圖到底救回了什麼。
  def self.material(model, name, rgb)
    m = model.materials[name] || model.materials.add(name)
    m.color = Sketchup::Color.new(*rgb)
    m
  end

  def self.build(model)
    ents = model.active_entities
    grp  = ents.add_group
    g    = grp.entities

    mat_ground = material(model, 'ArchGround', [122, 126, 118])
    mat_wall   = material(model, 'ArchWall',   [196, 188, 174])
    mat_glass  = material(model, 'ArchGlass',  [92, 116, 132])
    mat_wing   = material(model, 'ArchWing',   [150, 120, 100])

    # 地面
    ground = g.add_face([-40 * M, -40 * M, 0], [40 * M, -40 * M, 0],
                        [40 * M, 40 * M, 0], [-40 * M, 40 * M, 0])
    ground.reverse! if ground.normal.z < 0
    ground.material = mat_ground

    # 主量體
    base = g.add_face([-8 * M, -4 * M, 0], [8 * M, -4 * M, 0],
                      [8 * M, 4 * M, 0], [-8 * M, 4 * M, 0])
    base.reverse! if base.normal.z < 0
    base.pushpull(9 * M)
    grp.material = mat_wall

    # 在正面挖窗 —— 開口是「結構幻覺」最容易發生的地方，
    # 也是 spec 4.3 的「開口數量幻覺率」指標要測的東西。
    front_y = -4 * M
    3.times do |row|
      4.times do |col|
        x0 = (-6.5 + col * 3.5) * M
        z0 = (1.5 + row * 2.5) * M
        w  = 2.0 * M
        h  = 1.6 * M
        win = g.add_face(
          Geom::Point3d.new(x0,      front_y, z0),
          Geom::Point3d.new(x0 + w,  front_y, z0),
          Geom::Point3d.new(x0 + w,  front_y, z0 + h),
          Geom::Point3d.new(x0,      front_y, z0 + h)
        )
        next unless win

        # ⚠️ pushpull 會**刪掉原本那個面** —— 它不是「把面推進去」，
        # 而是建立新幾何並取代原面。在 pushpull 之後對它設材質會拋
        # TypeError: reference to deleted DrawingElement。
        #
        # 所以順序是：先上材質（新幾何會繼承），再 pushpull，
        # 最後用 valid? 守衛（有些情況原面會留著）。
        win.material = mat_glass
        if win.respond_to?(:pushpull)
          begin
            win.pushpull(-0.35 * M)
          rescue StandardError
            # 窗洞挖失敗不該讓整個場景生不出來 —— 平面的窗戶仍有顏色對比
          end
        end
        win.material = mat_glass if win.valid?
      end
    end

    # 一個較矮的側翼，製造遮擋關係（深度圖才有意義）
    wing = g.add_face([8 * M, -2 * M, 0], [15 * M, -2 * M, 0],
                      [15 * M, 3 * M, 0], [8 * M, 3 * M, 0])
    wing.reverse! if wing.normal.z < 0
    wing.pushpull(4 * M)
    wing.material = mat_wing if wing.valid?

    grp
  end

  def self.run
    model = Sketchup.active_model
    view  = model.active_view
    op = false
    made = []

    begin
      model.start_operation('Architech Eval Scene', true)
      op = true
      build(model)

      CAMERAS.each do |cam|
        view.camera.set(
          Geom::Point3d.new(*cam[:eye].map { |v| v * M }),
          Geom::Point3d.new(*cam[:target].map { |v| v * M }),
          Geom::Vector3d.new(0, 0, 1)
        )
        view.refresh

        shot_id = "generated-massing-#{cam[:name]}"
        dir = File.join(EVAL_CAPTURES, shot_id)
        FileUtils_mkdir_p(dir)

        plan = AL.plan(view, long_edge: 1024, aspect: :square)
        res  = SE.new(model, plan: plan).run(dir) do |name, i, total|
          print "  #{shot_id} #{name} (#{i}/#{total})... "
        end
        puts "完成 #{res.elapsed.round(2)}s"

        meta = {
          'synthetic' => false,
          'source'    => 'tools/spike/make_eval_scene.rb',
          'shot_id'   => shot_id,
          'camera'    => cam,
          'plan'      => res.metadata[:plan],
          'passes'    => res.metadata[:passes].each_with_object({}) { |(k, v), h|
            h[k.to_s] = v.each_with_object({}) { |(kk, vv), hh| hh[kk.to_s] = vv }
          }
        }
        File.write(File.join(dir, 'capture.json'), pretty_json(meta))
        made << shot_id
      end
    rescue StandardError => e
      puts "！例外：#{e.class}: #{e.message}"
      puts e.backtrace.first(5)
    ensure
      model.abort_operation if op
      view.refresh
      puts "\n產出 #{made.size} 個 shot 於 #{EVAL_CAPTURES}"
      made.each { |s| puts "  #{s}" }
      puts "modified? = #{model.modified?}"
    end
  end

  # SketchUp 的 Ruby 沒有可靠的 JSON 產生器可用，自己寫一個夠用的。
  def self.pretty_json(obj, indent = 0)
    pad = '  ' * indent
    case obj
    when Hash
      return '{}' if obj.empty?
      inner = obj.map { |k, v| "#{pad}  #{k.to_s.inspect}: #{pretty_json(v, indent + 1)}" }
      "{\n#{inner.join(",\n")}\n#{pad}}"
    when Array
      "[#{obj.map { |v| pretty_json(v, indent) }.join(', ')}]"
    when String  then obj.inspect
    when Symbol  then obj.to_s.inspect
    when Numeric then obj.to_s
    when true, false then obj.to_s
    when nil     then 'null'
    else obj.to_s.inspect
    end
  end

  def self.FileUtils_mkdir_p(dir)
    return if File.directory?(dir)
    parent = File.dirname(dir)
    FileUtils_mkdir_p(parent) unless File.directory?(parent) || parent == dir
    Dir.mkdir(dir)
  end
end

puts "\n===== 產生評估場景並擷取 ====="
ArchitechScene.run
