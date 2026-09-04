# 還原保險絲 —— 從 probe_view.rb 存下的快照檔還原顯示設定。
#
# 只有在 probe_view.rb 中途當掉、設定沒還原時才需要跑：
#   load '/Users/benson/sketch-up-202609/tools/spike/restore_snapshot.rb'
#
# 快照檔位置固定：<temp_dir>/architech_snapshot.txt
# 這支腳本只寫 rendering_options / shadow_info / camera，不動任何幾何。

module ArchitechRestore
  PATH = File.join(Sketchup.temp_dir, "architech_snapshot.txt")

  def self.parse_value(raw)
    case raw
    when "true"  then true
    when "false" then false
    when /\A-?\d+\z/         then raw.to_i
    when /\A-?\d+\.\d+\z/    then raw.to_f
    when /\ACOLOR:(\d+),(\d+),(\d+),(\d+)\z/
      Sketchup::Color.new($1.to_i, $2.to_i, $3.to_i, $4.to_i)
    else
      nil # 無法還原的型別（Vector3d、Time 等），略過
    end
  end

  def self.run
    unless File.exist?(PATH)
      puts "找不到快照檔：#{PATH}"
      puts "如果 probe_view.rb 從未跑過，就沒有東西需要還原。"
      return false
    end

    model = Sketchup.active_model
    ro    = model.rendering_options
    si    = model.shadow_info
    restored = 0
    skipped  = []

    File.readlines(PATH, chomp: true).each do |line|
      next if line.empty? || line.start_with?("#")
      section, key, raw = line.split("\t", 3)
      next if raw.nil?

      value = parse_value(raw)
      if value.nil? && raw != "nil"
        skipped << "#{section}.#{key}"
        next
      end

      begin
        case section
        when "RO" then ro[key] = value
        when "SI" then si[key] = value
        when "CAM"
          case key
          when "aspect_ratio" then model.active_view.camera.aspect_ratio = value
          when "fov"          then model.active_view.camera.fov = value
          end
        end
        restored += 1
      rescue => e
        skipped << "#{section}.#{key} (#{e.class})"
      end
    end

    puts "已還原 #{restored} 項。"
    puts "略過 #{skipped.size} 項（型別無法序列化，通常不影響）：#{skipped.first(8).inspect}" unless skipped.empty?
    puts "model.modified? = #{model.modified?}"
    puts
    puts "如果畫面看起來仍不對，最後手段：關閉這個模型且不要儲存。"
    true
  end
end

ArchitechRestore.run
