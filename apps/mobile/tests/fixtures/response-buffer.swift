import Foundation

@main
enum ResponseBufferChecks {
  static func main() {
    var buffer = LoomTvResponseBuffer()
    let first = Data(repeating: 1, count: LoomTvResponseBuffer.highWaterBytes)
    let second = Data(repeating: 2, count: LoomTvResponseBuffer.lowWaterBytes)
    precondition(buffer.enqueue(first))
    precondition(buffer.shouldSuspend)
    precondition(buffer.nextChunk() == first)
    precondition(buffer.nextChunk() == nil, "only one send may be outstanding")
    precondition(buffer.enqueue(second))
    precondition(buffer.queuedBytes == first.count + second.count, "in-flight data remains counted")
    buffer.finishUpstream()
    precondition(!buffer.canFinish, "completion must drain queued body data")
    buffer.didSend(byteCount: first.count)
    precondition(buffer.shouldResume)
    precondition(buffer.nextChunk() == second)
    buffer.didSend(byteCount: second.count)
    precondition(buffer.canFinish)
    precondition(!buffer.enqueue(Data([3])), "late body callbacks cannot extend a completed response")

    var overflow = LoomTvResponseBuffer()
    precondition(overflow.enqueue(Data(repeating: 0, count: LoomTvResponseBuffer.maxBytes)))
    precondition(overflow.nextChunk() != nil)
    precondition(!overflow.enqueue(Data([1])), "the hard limit includes the active send")
    overflow.cancel()
    precondition(overflow.queuedBytes == 0)
    precondition(overflow.nextChunk() == nil)
    overflow.didSend(byteCount: LoomTvResponseBuffer.maxBytes)
    precondition(overflow.queuedBytes == 0, "a late completion cannot resurrect a cancelled queue")

    var smallChunks = LoomTvResponseBuffer()
    for _ in 0..<LoomTvResponseBuffer.maxChunks { precondition(smallChunks.enqueue(Data([1]))) }
    precondition(smallChunks.nextChunk() != nil)
    precondition(!smallChunks.enqueue(Data([2])), "tiny chunks must also have a bounded count")
    smallChunks.didSend(byteCount: 1)
    precondition(smallChunks.enqueue(Data([2])))
    smallChunks.cancel()
    precondition(!smallChunks.canFinish)
    print("Response buffer checks passed")
  }
}
