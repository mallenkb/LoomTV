Pod::Spec.new do |s|
  s.name           = 'LoomTvSecureTransport'
  s.version        = '1.0.0'
  s.summary        = 'Pinned native LAN transport for LoomTV'
  s.description    = 'Forwards loopback HTTP to a certificate-pinned LoomTV desktop TLS endpoint without moving media bytes through JavaScript.'
  s.license        = { :type => 'MIT' }
  s.author         = 'LoomTV'
  s.homepage       = 'https://github.com/mallenkb/LoomTV'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/mallenkb/LoomTV.git' }
  s.static_framework = true
  s.source_files   = '**/*.swift'
  s.frameworks     = 'Network', 'Security', 'CryptoKit'
  s.dependency 'ExpoModulesCore'
end
