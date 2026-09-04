# frozen_string_literal: true
#
# 精確診斷 SketchUp 的 Ruby 到底有哪些 stdlib 可用。
#
#   load '/Users/benson/sketch-up-202609/tools/spike/probe_stdlib.rb'
#
# 背景：Ruby 二進位裡有 Init_digest / Init_socket / Init_openssl 等符號，
# 但 require 'digest' 與 require 'net/http' 都失敗。符號存在不等於可載入 ——
# 靜態擴充需要註冊在 builtin 表裡，SketchUp 顯然沒有全部註冊。
#
# 這支只讀不寫，不碰模型也不連網。

def probe(label)
  print "  #{label.ljust(38)}"
  begin
    r = yield
    puts r.nil? ? "nil" : r.to_s
  rescue LoadError => e
    puts "LoadError: #{e.message}"
  rescue StandardError, ScriptError => e
    puts "#{e.class}: #{e.message[0, 60]}"
  end
end

puts "\n===== SketchUp Ruby stdlib 可用性 ====="
puts "RUBY_VERSION = #{RUBY_VERSION}"

puts "\n[1] 不 require 就已經定義的東西"
# 注意：不能寫 defined?(Object.const_get(name)) —— defined? 不會求值它的參數，
# 那只是在問「Object 有沒有 const_get 方法」，永遠回 "method"。要用 const_defined?。
%w[Digest OpenSSL Socket StringIO Zlib JSON URI Base64].each do |name|
  probe("Object.const_defined?(:#{name})") do
    Object.const_defined?(name) ? "已定義" : "未定義（尚未 require）"
  end
end

puts "\n[2] require 逐項"
%w[digest digest/sha2 openssl openssl/digest socket net/http net/protocol
   uri json stringio zlib base64 securerandom].each do |lib|
  probe("require '#{lib}'") { require lib; "OK" }
end

puts "\n[3] require 之後再看一次"
%w[Digest OpenSSL Socket StringIO Zlib JSON Base64 SecureRandom].each do |name|
  probe("Object.const_defined?(:#{name})") do
    Object.const_defined?(name) ? "已定義" : "未定義"
  end
end

puts "\n[4] 雜湊相關的細節"
probe("Digest::SHA256")  { defined?(Digest::SHA256)  ? "可用" : "不可用" }
probe("Digest::SHA2")    { defined?(Digest::SHA2)    ? "可用" : "不可用" }
probe("OpenSSL::Digest") { defined?(OpenSSL::Digest) ? "可用" : "不可用" }
probe("OpenSSL::Digest::SHA256") { defined?(OpenSSL::Digest::SHA256) ? "可用" : "不可用" }
probe("OpenSSL::Digest.digest") do
  OpenSSL::Digest.digest('SHA256', 'abc').unpack1('H*')[0, 16] + "…"
end
probe("OpenSSL::HMAC 是否在")  { defined?(OpenSSL::HMAC) ? "可用" : "不可用" }

puts "\n[5] Sketchup::Http 的能力"
probe("Sketchup::Http::Request") { defined?(Sketchup::Http::Request) ? "可用" : "不可用" }
probe("常數") { Sketchup::Http.constants.sort.inspect }

puts "\n[6] 純 Ruby SHA-256 的實際速度（決定要不要另想辦法）"
load File.expand_path('../../src/architech_render/net/digest_util.rb', File.dirname(__FILE__))
DU_ = ArchitechRender::Net::DigestUtil
[64 * 1024, 512 * 1024, 2 * 1024 * 1024].each do |n|
  data = 'x' * n
  t = Time.now
  DU_.hexdigest(data)
  ms = ((Time.now - t) * 1000).round
  puts "  #{(n / 1024.0).round.to_s.rjust(5)} KB  →  #{ms.to_s.rjust(5)} ms" \
       "  (#{(n / 1024.0 / 1024 / (ms / 1000.0)).round(2)} MB/s)"
end

puts "\n===== 完成 ====="
