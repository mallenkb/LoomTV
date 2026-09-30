import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const expires = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < expires, message); await delay(20); }
}

async function cachedJars(group, artifact) {
  const root = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'), 'caches/modules-2/files-2.1', group, artifact);
  const jars = [];
  for (const version of await fs.readdir(root).catch(() => [])) {
    const directory = path.join(root, version);
    for (const hash of await fs.readdir(directory)) {
      for (const file of await fs.readdir(path.join(directory, hash))) {
        if (file === `${artifact}-${version}.jar`) jars.push(path.join(directory, hash, file));
      }
    }
  }
  return jars.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}

async function compiler() {
  if (spawnSync(java, ['-version']).status !== 0) return null;
  // Gradle assembleDebug resolves the same pinned Kotlin compiler used by the
  // Android build. Reuse its cache rather than download a second toolchain.
  const artifacts = await Promise.all([
    cachedJars('org.jetbrains.kotlin', 'kotlin-compiler-embeddable'),
    cachedJars('org.jetbrains.kotlin', 'kotlin-stdlib'),
    cachedJars('org.jetbrains.kotlin', 'kotlin-script-runtime'),
    cachedJars('org.jetbrains.kotlin', 'kotlin-reflect'),
    cachedJars('org.jetbrains.kotlin', 'kotlin-daemon-embeddable'),
    cachedJars('org.jetbrains.intellij.deps', 'trove4j'),
    cachedJars('org.jetbrains', 'annotations'),
    cachedJars('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
  ]);
  if (!artifacts[0].length || !artifacts[1].length) {
    return spawnSync('kotlinc', ['-version']).status === 0 ? { command: 'kotlinc', args: [], runtime: null } : null;
  }
  const compilerVersion = path.basename(path.dirname(path.dirname(artifacts[0][0])));
  const matchingVersion = (jars) => jars.find((jar) => path.basename(path.dirname(path.dirname(jar))) === compilerVersion);
  const runtime = matchingVersion(artifacts[1]);
  if (!runtime) return null;
  const classpath = artifacts.map((jars, index) => ([1, 2, 4].includes(index) ? matchingVersion(jars) : jars[0])).filter(Boolean).join(path.delimiter);
  return {
    command: java,
    args: ['-cp', classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', classpath],
    runtime,
  };
}

async function run(command, args) {
  const child = spawn(command, args);
  let errors = '';
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000); });
  const status = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(status, 0, errors);
}

function consumer(url, target, halfClose = false) {
  const address = new URL(url);
  const socket = net.connect({ host: '127.0.0.1', port: Number(address.port) });
  let result = '';
  socket.on('error', () => {});
  const connected = new Promise((resolve) => socket.once('connect', () => {
    const request = `GET ${address.pathname}${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
    if (halfClose) socket.end(request); else socket.write(request);
    resolve();
  }));
  socket.on('data', (chunk) => { result = (result + chunk.toString('latin1')).slice(-4096); });
  const done = new Promise((resolve) => socket.once('close', () => resolve(result)));
  return { socket, connected, done };
}

const toolchain = await compiler();
const required = process.env.LOOMTV_REQUIRE_ANDROID_TRANSPORT_TEST === '1';

test('Android native transport bounds queued sockets and revokes active TLS work on stop', {
  skip: !toolchain && !required ? 'JDK and Kotlin compiler (PATH or Gradle cache) are required' : false,
  timeout: 90_000,
}, async (t) => {
  assert.ok(toolchain, 'the Android native CI job must run this after Gradle resolves its Kotlin compiler');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loomtv-android-transport-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const certificate = path.join(directory, 'certificate.pem');
  const key = path.join(directory, 'key.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=loomtv-fixture', '-keyout', key, '-out', certificate]);
  const pem = await fs.readFile(certificate);
  const fingerprint = new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
  const received = [];
  let closedHolds = 0;
  const server = https.createServer({ cert: pem, key: await fs.readFile(key) }, (request, response) => {
    received.push(request.url);
    request.resume();
    if (request.url.startsWith('/hold/')) { response.once('close', () => { closedHolds += 1; }); return; }
    response.writeHead(200, { 'Content-Length': 5 });
    response.end('small');
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const upstream = `https://127.0.0.1:${server.address().port}`;
  const module = await fs.readFile(new URL('../modules/loomtv-secure-transport/android/src/main/java/app/loomtv/securetransport/LoomTvSecureTransportModule.kt', import.meta.url), 'utf8');
  const native = module.replace(/^import (?:expo\.|kotlinx\.coroutines)[^\n]*\n/gm, '')
    .replace(/class LoomTvSecureTransportModule : Module\(\) \{[\s\S]*?\n\}\n(?=\nprivate const val MAX_HEADER_BYTES)/, '');
  assert.doesNotMatch(native, /: Module\(\)|expo\.modules|kotlinx\.coroutines/);
  const fixture = `
fun main(args: Array<String>) {
  val proxy = SecureLanProxy(TimeUnit.SECONDS.toNanos(2))
  var previousFactory: SSLSocketFactory? = null
  fun stats() {
    val field = proxy.javaClass.getDeclaredField("requestExecutor").apply { isAccessible = true }
    val executor = field.get(proxy) as ThreadPoolExecutor
    println("QUEUE " + executor.queue.size)
  }
  println("URL " + proxy.start(args[0], args[1]))
  try {
    while (true) {
      when (readLine() ?: break) {
        "stats" -> stats()
        "stop" -> {
          previousFactory = proxy.javaClass.getDeclaredField("socketFactory").apply { isAccessible = true }.get(proxy) as SSLSocketFactory
          proxy.stop(); println("STOPPED")
        }
        "late" -> {
          var refused = false
          try { previousFactory!!.createSocket().close() } catch (_: Exception) { refused = true }
          check(refused); println("LATE_REFUSED")
        }
        "restart" -> println("URL " + proxy.start(args[0], args[1]))
        "wrong-pin" -> println("URL " + proxy.start(args[0], "0".repeat(64)))
        "quit" -> break
      }
    }
  } finally { proxy.destroy() }
}
`;
  const source = path.join(directory, 'Main.kt');
  const output = path.join(directory, toolchain.runtime ? 'classes' : 'transport.jar');
  await fs.writeFile(source, native + fixture);
  await run(toolchain.command, [...toolchain.args, source, ...(toolchain.runtime ? [] : ['-include-runtime']), '-d', output]);
  const javaArgs = toolchain.runtime
    ? ['-cp', [output, toolchain.runtime].join(path.delimiter), 'app.loomtv.securetransport.MainKt']
    : ['-cp', output, 'app.loomtv.securetransport.MainKt'];
  const child = spawn(java, [...javaArgs, upstream, fingerprint]);
  let log = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { log = (log + chunk).slice(-8000); });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-4000); });
  const clients = [];
  t.after(() => { for (const item of clients) item.socket.destroy(); child.kill(); });
  async function command(value, expected) {
    const before = log.length;
    child.stdin.write(`${value}\n`);
    await until(() => log.slice(before).includes(expected) || child.exitCode !== null, `${value}: ${errors}`);
    assert.equal(child.exitCode, null, errors);
  }
  await until(() => log.includes('URL ') || child.exitCode !== null, `native proxy startup: ${errors}`);
  assert.equal(child.exitCode, null, errors);
  let url = log.match(/URL (\S+)/)[1];
  const request = (target, halfClose = false) => { const item = consumer(url, target, halfClose); clients.push(item); return item; };
  assert.match(await request('/small/half-close', true).done, /HTTP\/1\.1 200[\s\S]*small$/);
  const holds = Array.from({ length: 8 }, (_, index) => request(`/hold/${index}`));
  await until(() => received.filter((value) => value.startsWith('/hold/')).length === 8, 'all eight native workers must reach TLS upstream');
  const waiting = Array.from({ length: 12 }, (_, index) => request(`/queued/${index}`));
  await Promise.all(waiting.map((item) => item.connected));
  await delay(100);
  await command('stats', 'QUEUE 12');
  assert.match(await request('/overflow').done, /^HTTP\/1\.1 503/);
  const expired = await Promise.all(waiting.map((item) => item.done));
  assert.ok(expired.every((result) => result.startsWith('HTTP/1.1 503')), 'queued deadline must close every waiting socket with a retryable response');
  assert.ok(!received.some((value) => value.startsWith('/queued/')), 'expired waiting requests never reach TLS upstream');
  const cancelledWaiting = [request('/cancelled/1'), request('/cancelled/2')];
  await Promise.all(cancelledWaiting.map((item) => item.connected));
  await delay(100);
  await command('stats', 'QUEUE 2');
  await command('stop', 'STOPPED');
  await Promise.all([...holds, ...cancelledWaiting].map((item) => item.done));
  await until(() => closedHolds === 8, 'stop must close all active upstream TLS sockets');
  await command('stats', 'QUEUE 0');
  await command('late', 'LATE_REFUSED');
  assert.ok(!received.some((value) => value.startsWith('/cancelled/')));
  await command('restart', 'URL ');
  url = [...log.matchAll(/URL (\S+)/g)].at(-1)[1];
  assert.match(await request('/small/restarted', true).done, /HTTP\/1\.1 200[\s\S]*small$/);
  await command('wrong-pin', 'URL ');
  url = [...log.matchAll(/URL (\S+)/g)].at(-1)[1];
  assert.match(await request('/small/wrong-pin').done, /^HTTP\/1\.1 502/);
  assert.ok(!received.includes('/small/wrong-pin'), 'certificate mismatch never forwards the HTTP request');
  child.stdin.write('quit\n');
  assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0, errors);
});
