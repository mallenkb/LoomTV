package app.loomtv.securetransport

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

class LoomTvSecureTransportModule : Module() {
  private val proxy = SecureLanProxy()

  override fun definition() = ModuleDefinition {
    Name("LoomTvSecureTransport")

    AsyncFunction("probeCertificate") Coroutine { origin: String ->
      withContext(Dispatchers.IO) { probeCertificate(origin) }
    }

    AsyncFunction("start") Coroutine { origin: String, certFingerprint: String ->
      withContext(Dispatchers.IO) { proxy.start(origin, certFingerprint) }
    }

    AsyncFunction("stop") Coroutine { ->
      withContext(Dispatchers.IO) { proxy.stop() }
    }

    OnDestroy {
      proxy.destroy()
    }
  }
}

private const val MAX_HEADER_BYTES = 64 * 1024
private const val MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
private const val COPY_BUFFER_BYTES = 64 * 1024

private val HOP_BY_HOP_HEADERS = setOf(
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "accept-encoding",
)

private fun normalizedFingerprint(value: String): String {
  val normalized = value.replace(Regex("[^0-9a-fA-F]"), "").lowercase(Locale.US)
  require(normalized.matches(Regex("^[0-9a-f]{64}$"))) { "Invalid SHA-256 certificate fingerprint." }
  return normalized
}

private fun secureOrigin(value: String): URI {
  val uri = URI(value)
  require(uri.scheme.equals("https", ignoreCase = true)) { "Secure LAN origins must use HTTPS." }
  require(!uri.host.isNullOrBlank() && uri.userInfo == null) { "Invalid secure LAN origin." }
  require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") { "Secure LAN origins cannot contain a path." }
  require(uri.rawQuery == null && uri.rawFragment == null) { "Secure LAN origins cannot contain a query or fragment." }
  return URI("https", null, uri.host, uri.port, null, null, null)
}

private fun certificateFingerprint(certificate: X509Certificate): String =
  MessageDigest.getInstance("SHA-256")
    .digest(certificate.encoded)
    .joinToString("") { "%02x".format(it.toInt() and 0xff) }

private class PinnedTrustManager(private val expectedFingerprint: String) : X509TrustManager {
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw java.security.cert.CertificateException("Client certificates are not accepted.")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val certificate = chain?.firstOrNull()
      ?: throw java.security.cert.CertificateException("The desktop did not present a certificate.")
    certificate.checkValidity()
    if (certificateFingerprint(certificate) != expectedFingerprint) {
      throw java.security.cert.CertificateException("The desktop certificate fingerprint changed.")
    }
  }
}

private class ProbeTrustManager : X509TrustManager {
  @Volatile var fingerprint: String? = null
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val certificate = chain?.firstOrNull()
      ?: throw java.security.cert.CertificateException("The desktop did not present a certificate.")
    certificate.checkValidity()
    fingerprint = certificateFingerprint(certificate)
  }
}

private fun probeCertificate(origin: String): String {
  val remote = secureOrigin(origin)
  val trustManager = ProbeTrustManager()
  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(trustManager), null)
  val port = if (remote.port > 0) remote.port else 443
  val socket = context.socketFactory.createSocket(remote.host, port) as SSLSocket
  socket.soTimeout = 10_000
  return socket.use {
    it.startHandshake()
    trustManager.fingerprint ?: error("The desktop did not present a certificate.")
  }
}

private data class ProxyRequest(
  val method: String,
  val target: String,
  val headers: List<Pair<String, String>>,
  val contentLength: Int,
)

private class SecureLanProxy {
  private val acceptExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val requestExecutor: ExecutorService = Executors.newCachedThreadPool()
  @Volatile private var serverSocket: ServerSocket? = null
  @Volatile private var remoteOrigin: URI? = null
  @Volatile private var certFingerprint: String? = null
  @Volatile private var sslContext: SSLContext? = null

  @Synchronized
  fun start(origin: String, fingerprint: String): String {
    val normalizedOrigin = secureOrigin(origin)
    val normalizedFingerprint = normalizedFingerprint(fingerprint)
    val currentServer = serverSocket
    if (
      currentServer != null
      && !currentServer.isClosed
      && remoteOrigin == normalizedOrigin
      && certFingerprint == normalizedFingerprint
    ) return "http://localhost:${currentServer.localPort}"

    stop()
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(PinnedTrustManager(normalizedFingerprint)), null)
    val nextServer = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    remoteOrigin = normalizedOrigin
    certFingerprint = normalizedFingerprint
    sslContext = context
    serverSocket = nextServer
    acceptExecutor.execute { acceptLoop(nextServer) }
    return "http://localhost:${nextServer.localPort}"
  }

  @Synchronized
  fun stop() {
    val current = serverSocket
    serverSocket = null
    remoteOrigin = null
    certFingerprint = null
    sslContext = null
    try { current?.close() } catch (_: Exception) { }
  }

  fun destroy() {
    stop()
    acceptExecutor.shutdownNow()
    requestExecutor.shutdownNow()
  }

  private fun acceptLoop(expectedServer: ServerSocket) {
    while (!expectedServer.isClosed && serverSocket === expectedServer) {
      try {
        val socket = expectedServer.accept()
        requestExecutor.execute { handleClient(socket, expectedServer) }
      } catch (_: Exception) {
        if (!expectedServer.isClosed) continue
      }
    }
  }

  private fun handleClient(socket: Socket, expectedServer: ServerSocket) {
    socket.soTimeout = 60_000
    socket.use { client ->
      val remote = remoteOrigin
      val context = sslContext
      if (serverSocket !== expectedServer || remote == null || context == null) {
        writeProxyError(client, 503, "Secure transport is restarting.")
        return
      }
      try {
        val input = BufferedInputStream(client.getInputStream(), COPY_BUFFER_BYTES)
        val output = BufferedOutputStream(client.getOutputStream(), COPY_BUFFER_BYTES)
        val request = readRequest(input)
        forwardRequest(remote, context, request, input, output)
      } catch (_: Exception) {
        writeProxyError(client, 502, "The secure desktop connection failed.")
      }
    }
  }

  private fun readRequest(input: BufferedInputStream): ProxyRequest {
    val headerBytes = ByteArrayOutputStream()
    var matched = 0
    while (headerBytes.size() < MAX_HEADER_BYTES) {
      val value = input.read()
      if (value < 0) error("The local request ended before its headers.")
      headerBytes.write(value)
      matched = when {
        matched == 0 && value == '\r'.code -> 1
        matched == 1 && value == '\n'.code -> 2
        matched == 2 && value == '\r'.code -> 3
        matched == 3 && value == '\n'.code -> 4
        value == '\r'.code -> 1
        else -> 0
      }
      if (matched == 4) break
    }
    require(matched == 4) { "Local request headers are too large." }
    val lines = headerBytes.toString(Charsets.ISO_8859_1.name()).split("\r\n")
    val requestLine = lines.firstOrNull()?.split(' ', limit = 3) ?: error("Missing request line.")
    require(requestLine.size == 3 && requestLine[2].startsWith("HTTP/1.")) { "Invalid local request line." }
    val method = requestLine[0].uppercase(Locale.US)
    require(method in setOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")) { "Unsupported method." }
    val target = requestLine[1]
    require(target.startsWith('/') && !target.startsWith("//")) { "Invalid local request target." }
    val headers = lines.drop(1).takeWhile { it.isNotEmpty() }.map { line ->
      val separator = line.indexOf(':')
      require(separator > 0) { "Invalid local request header." }
      line.substring(0, separator).trim() to line.substring(separator + 1).trim()
    }
    val contentLength = headers.firstOrNull { it.first.equals("content-length", true) }
      ?.second?.toIntOrNull() ?: 0
    require(contentLength in 0..MAX_REQUEST_BODY_BYTES) { "Local request body is too large." }
    return ProxyRequest(method, target, headers, contentLength)
  }

  private fun forwardRequest(
    origin: URI,
    context: SSLContext,
    request: ProxyRequest,
    localInput: BufferedInputStream,
    localOutput: BufferedOutputStream,
  ) {
    val remoteUrl = URL(origin.toString() + request.target)
    val connection = remoteUrl.openConnection() as HttpsURLConnection
    connection.sslSocketFactory = context.socketFactory
    connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 10_000
    connection.readTimeout = 60_000
    connection.requestMethod = request.method
    connection.setRequestProperty("Connection", "keep-alive")
    connection.setRequestProperty("Accept-Encoding", "identity")
    for ((name, value) in request.headers) {
      if (name.lowercase(Locale.US) !in HOP_BY_HOP_HEADERS && !name.equals("content-length", true)) {
        connection.addRequestProperty(name, value)
      }
    }
    if (request.contentLength > 0) {
      connection.doOutput = true
      connection.setFixedLengthStreamingMode(request.contentLength)
      connection.outputStream.use { remoteOutput ->
        copyExactly(localInput, remoteOutput, request.contentLength.toLong())
      }
    }

    val status = connection.responseCode
    val reason = connection.responseMessage?.replace(Regex("[\r\n]"), " ") ?: "Response"
    val responseHeaders = StringBuilder("HTTP/1.1 $status $reason\r\n")
    connection.headerFields.forEach { (name, values) ->
      if (name != null && name.lowercase(Locale.US) !in HOP_BY_HOP_HEADERS) {
        values.orEmpty().forEach { value -> responseHeaders.append(name).append(": ").append(value).append("\r\n") }
      }
    }
    responseHeaders.append("Connection: close\r\n\r\n")
    localOutput.write(responseHeaders.toString().toByteArray(Charsets.ISO_8859_1))
    localOutput.flush()
    if (request.method == "HEAD") return
    val responseInput = try { connection.inputStream } catch (_: Exception) { connection.errorStream }
    responseInput?.use { source ->
      source.copyTo(localOutput, COPY_BUFFER_BYTES)
      localOutput.flush()
    }
  }

  private fun copyExactly(input: BufferedInputStream, output: java.io.OutputStream, bytes: Long) {
    var remaining = bytes
    val buffer = ByteArray(COPY_BUFFER_BYTES)
    while (remaining > 0) {
      val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
      if (read < 0) error("The local request body ended early.")
      output.write(buffer, 0, read)
      remaining -= read
    }
  }

  private fun writeProxyError(socket: Socket, status: Int, message: String) {
    try {
      val body = message.toByteArray(Charsets.UTF_8)
      val response = "HTTP/1.1 $status Secure Transport Error\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
      socket.getOutputStream().write(response.toByteArray(Charsets.ISO_8859_1))
      socket.getOutputStream().write(body)
      socket.getOutputStream().flush()
    } catch (_: Exception) { }
  }
}
