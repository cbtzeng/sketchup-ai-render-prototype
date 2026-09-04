# Phase 0 / Task 0.1 — 環境與 API 探查
#
# 用法：在 SketchUp 的 Extensions → Developer → Ruby Console 貼上這一行
#   load '/Users/benson/sketch-up-202609/tools/spike/dump_env.rb'
#
# 原則：先問物件支援什麼，再用。本檔不呼叫任何未經 respond_to? 確認的方法。
# 產物：一個 txt 檔，路徑會 puts 出來。

module ArchitechSpike
  def self.dump_kv(io, label, obj)
    io.puts
    io.puts "=" * 70
    io.puts "## #{label} (#{obj.class})"
    io.puts "=" * 70
    io.puts "-- 可用方法（扣掉 Object 內建）"
    io.puts((obj.methods - Object.instance_methods).sort.inspect)
    io.puts "-- key/value"
    if obj.respond_to?(:each_pair)
      io.puts "(用 each_pair)"
      obj.each_pair { |k, v| io.puts "#{k}\t#{v.inspect}" }
    elsif obj.respond_to?(:each_key)
      io.puts "(用 each_key)"
      obj.each_key { |k| io.puts "#{k}\t#{obj[k].inspect}" }
    elsif obj.respond_to?(:keys)
      io.puts "(用 keys)"
      obj.keys.sort.each { |k| io.puts "#{k}\t#{obj[k].inspect}" }
    else
      io.puts "！三種列舉方式都不支援 —— 看上面的方法清單再想辦法"
    end
  rescue => e
    io.puts "！dump #{label} 時發生例外：#{e.class}: #{e.message}"
  end

  def self.dump_methods(io, label, klass)
    io.puts
    io.puts "=" * 70
    io.puts "## #{label} 的 instance methods"
    io.puts "=" * 70
    io.puts((klass.instance_methods - Object.instance_methods).sort.inspect)
  rescue => e
    io.puts "！#{label} 不存在或無法探查：#{e.class}: #{e.message}"
  end

  def self.run
    model = Sketchup.active_model
    view  = model.active_view
    path  = File.join(Sketchup.temp_dir, "architech_env_dump.txt")

    File.open(path, "w") do |f|
      f.puts "# Architech Render — Phase 0 環境探查"
      f.puts "# 產生時間: #{Time.now}"
      f.puts
      f.puts "RUBY_VERSION        = #{RUBY_VERSION}"
      f.puts "RUBY_PLATFORM       = #{RUBY_PLATFORM}"
      f.puts "Sketchup.version    = #{Sketchup.version}"
      f.puts "version_number      = #{Sketchup.version_number}" if Sketchup.respond_to?(:version_number)
      f.puts "is_64bit?           = #{Sketchup.is_64bit?}"      if Sketchup.respond_to?(:is_64bit?)
      f.puts "temp_dir            = #{Sketchup.temp_dir}"       if Sketchup.respond_to?(:temp_dir)
      f.puts "model.path          = #{model.path.inspect}"
      f.puts "model.modified?     = #{model.modified?}"
      f.puts
      f.puts "-- viewport"
      f.puts "vpwidth             = #{view.vpwidth}"
      f.puts "vpheight            = #{view.vpheight}"
      f.puts "aspect (w/h)        = #{(view.vpwidth.to_f / view.vpheight).round(4)}"
      f.puts "camera.aspect_ratio = #{view.camera.aspect_ratio.inspect}" if view.camera.respond_to?(:aspect_ratio)
      f.puts "camera.fov          = #{view.camera.fov.inspect}"          if view.camera.respond_to?(:fov)
      f.puts "camera.perspective? = #{view.camera.perspective?.inspect}" if view.camera.respond_to?(:perspective?)

      dump_kv(f, "model.rendering_options", model.rendering_options)
      dump_kv(f, "model.shadow_info",       model.shadow_info)

      dump_methods(f, "Sketchup::View",   Sketchup::View)
      dump_methods(f, "Sketchup::Camera", Sketchup::Camera)

      f.puts
      f.puts "=" * 70
      f.puts "## Sketchup::Http 探查（V8 前置）"
      f.puts "=" * 70
      if defined?(Sketchup::Http) && defined?(Sketchup::Http::Request)
        f.puts "Sketchup::Http::Request 存在"
        f.puts((Sketchup::Http::Request.instance_methods - Object.instance_methods).sort.inspect)
        f.puts "Sketchup::Http 常數: #{Sketchup::Http.constants.sort.inspect}"
      else
        f.puts "！Sketchup::Http 或 Request 不存在"
      end

      f.puts
      f.puts "=" * 70
      f.puts "## net/http + OpenSSL 可用性"
      f.puts "=" * 70
      begin
        require 'net/http'
        require 'openssl'
        f.puts "require 成功"
        f.puts "OpenSSL::VERSION         = #{OpenSSL::VERSION}"
        f.puts "OPENSSL_LIBRARY_VERSION  = #{OpenSSL::OPENSSL_LIBRARY_VERSION}" if defined?(OpenSSL::OPENSSL_LIBRARY_VERSION)
        f.puts "預設 CA 檔存在?          = #{File.exist?(OpenSSL::X509::DEFAULT_CERT_FILE)} (#{OpenSSL::X509::DEFAULT_CERT_FILE})"
      rescue LoadError => e
        f.puts "！require 失敗: #{e.message}"
      end
    end

    puts "已寫入: #{path}"
    path
  end
end

ArchitechSpike.run
