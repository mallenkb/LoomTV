import Foundation

// Counts the chunk held by NWConnection as well as chunks awaiting a send.
// URLSession suspension can leave callbacks already in flight, so a hard
// limit cancels the transfer instead of allowing that backlog to grow.
struct LoomTvResponseBuffer {
  static let highWaterBytes = 256 * 1024
  static let lowWaterBytes = 128 * 1024
  static let maxBytes = 1024 * 1024
  static let maxChunks = 256

  private var chunks: [Data?] = []
  private var nextIndex = 0
  private(set) var queuedBytes = 0
  private(set) var sending = false
  private(set) var upstreamFinished = false
  private(set) var cancelled = false

  var shouldSuspend: Bool { queuedBytes >= Self.highWaterBytes }
  var shouldResume: Bool { queuedBytes <= Self.lowWaterBytes }
  var canFinish: Bool { upstreamFinished && !sending && queuedBytes == 0 && !cancelled }

  mutating func enqueue(_ data: Data) -> Bool {
    guard !cancelled, !upstreamFinished,
      data.count <= Self.maxBytes - queuedBytes,
      chunks.count - nextIndex + (sending ? 1 : 0) < Self.maxChunks else { return false }
    chunks.append(data)
    queuedBytes += data.count
    return true
  }

  mutating func nextChunk() -> Data? {
    guard !cancelled, !sending, nextIndex < chunks.count else { return nil }
    let data = chunks[nextIndex]
    chunks[nextIndex] = nil
    nextIndex += 1
    sending = true
    if nextIndex == chunks.count {
      chunks.removeAll(keepingCapacity: true)
      nextIndex = 0
    } else if nextIndex >= 64 && nextIndex * 2 >= chunks.count {
      chunks.removeFirst(nextIndex)
      nextIndex = 0
    }
    return data
  }

  mutating func didSend(byteCount: Int) {
    guard !cancelled else { return }
    queuedBytes -= byteCount
    sending = false
  }

  mutating func finishUpstream() { upstreamFinished = true }

  mutating func cancel() {
    cancelled = true
    chunks.removeAll()
    nextIndex = 0
    queuedBytes = 0
    sending = false
  }
}
