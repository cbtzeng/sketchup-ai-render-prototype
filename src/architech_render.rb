# frozen_string_literal: true
#
# SketchUp 外掛載入入口。
#
# 這個檔案要放在 SketchUp 的 Plugins 目錄（或以符號連結指過來），
# 與同名的 architech_render/ 目錄並列。用 tools/install_dev.sh 建立連結。

require 'sketchup.rb'
require 'extensions.rb'

module ArchitechRender
  unless defined?(@extension_registered)
    extension = SketchupExtension.new('Architech Render', 'architech_render/main')
    extension.version     = '0.1.0'
    extension.creator     = 'cbtzeng'
    extension.copyright   = '2026'
    extension.description =
      '多重控制圖 AI 渲染原型：從 SketchUp 擷取 beauty / hidden-line / fog depth ' \
      '三張像素對齊的控制圖，一起送給 ControlNet 以提高結構保真度。'

    Sketchup.register_extension(extension, true)
    @extension_registered = true
  end
end
