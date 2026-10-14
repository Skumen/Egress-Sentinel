import assert from 'node:assert/strict';
import { parseVless, buildXrayConfig } from '../sensor/vless.js';

const U = '6f2d1c3e-1111-4222-8333-444455556666';
const v = (q, host = 'nl1.example.com:443') => `vless://${U}@${host}?${q}#NL%201%20%F0%9F%87%B3%F0%9F%87%B1`;

// Reality + vision (типичная ссылка 3x-ui)
let r = parseVless(v('type=tcp&encryption=none&security=reality&pbk=PBK&fp=firefox&sni=www.google.com&sid=0a1b&spx=%2F&flow=xtls-rprx-vision'));
assert.equal(r.name, 'NL 1 🇳🇱');
assert.equal(r.address, 'nl1.example.com');
assert.equal(r.port, 443);
assert.deepEqual(r.outbound.settings.vnext[0].users[0], { id: U, encryption: 'none', flow: 'xtls-rprx-vision' });
assert.deepEqual(r.outbound.streamSettings, {
  network: 'tcp', security: 'reality',
  realitySettings: { serverName: 'www.google.com', fingerprint: 'firefox', publicKey: 'PBK', shortId: '0a1b', spiderX: '/' },
});
// raw = tcp; headerType=none не создаёт tcpSettings
r = parseVless(v('type=raw&security=reality&pbk=P&sni=a.com&headerType=none'));
assert.equal(r.outbound.streamSettings.network, 'tcp');
assert.equal(r.outbound.streamSettings.tcpSettings, undefined);
assert.equal(r.outbound.streamSettings.realitySettings.fingerprint, 'chrome', 'default fp');
// tcp + http header obfuscation
r = parseVless(v('type=tcp&security=none&headerType=http&path=%2Fa&host=x.com'));
assert.deepEqual(r.outbound.streamSettings.tcpSettings, { header: { type: 'http', request: { path: ['/a'], headers: { Host: ['x.com'] } } } });
// ws + tls, alpn список, host
r = parseVless(v('type=ws&security=tls&sni=cdn.example.com&host=cdn.example.com&path=%2Fws%3Fed%3D2048&alpn=h2%2Chttp%2F1.1&fp=chrome'));
assert.deepEqual(r.outbound.streamSettings, {
  network: 'ws', security: 'tls',
  tlsSettings: { serverName: 'cdn.example.com', fingerprint: 'chrome', alpn: ['h2', 'http/1.1'] },
  wsSettings: { path: '/ws?ed=2048', host: 'cdn.example.com' },
});
// tls без sni: serverName = домен из адреса; для IP — не задаётся
assert.equal(parseVless(v('type=ws&security=tls')).outbound.streamSettings.tlsSettings.serverName, 'nl1.example.com');
assert.equal(parseVless(v('type=ws&security=tls', '203.0.113.5:443')).outbound.streamSettings.tlsSettings.serverName, undefined);
// grpc
r = parseVless(v('type=grpc&security=reality&pbk=P&sni=a.com&serviceName=svc&mode=multi'));
assert.deepEqual(r.outbound.streamSettings.grpcSettings, { serviceName: 'svc', multiMode: true });
// xhttp + extra JSON, splithttp = xhttp
r = parseVless(v(`type=splithttp&security=tls&sni=a.com&path=%2Fx&mode=packet-up&extra=${encodeURIComponent('{"xPaddingBytes":"100-1000"}')}`));
assert.deepEqual(r.outbound.streamSettings.xhttpSettings, { path: '/x', mode: 'packet-up', extra: { xPaddingBytes: '100-1000' } });
assert.throws(() => parseVless(v('type=xhttp&extra=%7Bbad')), /extra.*JSON/);
// httpupgrade
assert.deepEqual(parseVless(v('type=httpupgrade&path=%2Fh&host=h.com')).outbound.streamSettings.httpupgradeSettings, { path: '/h', host: 'h.com' });
// IPv6
r = parseVless(v('type=tcp&security=none', '[2001:db8::1]:8443'));
assert.equal(r.address, '2001:db8::1');
assert.equal(r.port, 8443);
// закреплённый сертификат
const PIN = 'a'.repeat(64);
assert.equal(parseVless(v(`type=ws&security=tls&pcs=${PIN.toUpperCase()}`)).outbound.streamSettings.tlsSettings.pinnedPeerCertSha256, PIN);
assert.equal(parseVless(v('type=ws&security=tls&allowInsecure=1'), { pinnedPeerCertSha256: PIN }).outbound.streamSettings.tlsSettings.pinnedPeerCertSha256, PIN);
assert.throws(() => parseVless(v('type=ws&security=tls&allowInsecure=1')), /allowInsecure.*pinnedPeerCertSha256/);
assert.throws(() => parseVless(v('type=ws&security=tls&pcs=zz')), /SHA-256/);
// ошибки (без утечки ссылки)
const bad = [
  ['vmess://abc', /vless:\/\//],
  ['not a link', /not a valid/],
  [`vless://@h.com:443?type=tcp`, /UUID/],
  [`vless://${U}@h.com?type=tcp`, /port/],
  [v('type=h2&security=tls'), /no longer supported/],
  [v('type=quic'), /no longer supported/],
  [v('type=foo'), /unsupported transport/],
  [v('type=tcp&security=xtls'), /unsupported security/],
  [v('type=tcp&security=reality&sni=a.com'), /pbk/],
  [v('type=ws&security=tls&flow=xtls-rprx-vision'), /flow/],
  [v('type=tcp&security=none&flow=xtls-rprx-vision'), /flow/],
];
for (const [link, re] of bad) {
  assert.throws(() => parseVless(link), (err) => re.test(err.message) && !err.message.includes(U), link);
}
// конфиг Xray: blackhole первым, у каждого входа свой выход
const cfg = buildXrayConfig([parseVless(v('type=tcp')).outbound, parseVless(v('type=ws')).outbound], 20800);
assert.equal(cfg.outbounds[0].protocol, 'blackhole');
assert.deepEqual(cfg.inbounds.map((i) => [i.port, i.listen]), [[20800, '127.0.0.1'], [20801, '127.0.0.1']]);
assert.deepEqual(cfg.routing.rules.map((x) => [x.inboundTag[0], x.outboundTag]), [['in-0', 'out-0'], ['in-1', 'out-1']]);
assert.equal(cfg.log.access, 'none');
console.log('VLESS PARSE: all checks passed');
