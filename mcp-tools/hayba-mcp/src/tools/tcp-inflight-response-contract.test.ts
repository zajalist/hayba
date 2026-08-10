import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const privateDir = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const server = readFileSync(join(privateDir, 'HaybaMCPTcpServer.cpp'), 'utf8');
const header = readFileSync(join(privateDir, 'HaybaMCPTcpServer.h'), 'utf8');
const moduleHeader = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Public', 'HaybaMCPModule.h'),
  'utf8',
);
const moduleCpp = readFileSync(join(privateDir, 'HaybaMCPModule.cpp'), 'utf8');
const policy = readFileSync(join(privateDir, 'HaybaMCPFrameReadPolicy.h'), 'utf8');
const nativeTest = readFileSync(join(privateDir, 'Tests', 'HaybaMCPFrameReadPolicyTest.cpp'), 'utf8');
const transportPolicy = readFileSync(join(privateDir, 'HaybaMCPTransportPolicy.h'), 'utf8');
const joinableWorker = readFileSync(join(privateDir, 'HaybaMCPJoinableWorker.h'), 'utf8');
const transportPolicyTest = readFileSync(
  join(privateDir, 'Tests', 'HaybaMCPTransportPolicyTest.cpp'),
  'utf8',
);

describe('TCP in-flight response lifetime contract', () => {
  it('marks a response pending before queueing and clears it only after send completes', () => {
    const increment = server.indexOf(
      'MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Conn->ResponsesPending)',
    );
    const enqueue = server.indexOf('PendingCommands.Enqueue');
    const send = server.indexOf('SendMessage(Conn, Response.Message)');
    const generation = server.indexOf('Conn->ResponseGeneration.Increment()', send);
    const decrement = server.indexOf('Response.ResponseReservation.Reset()', send);
    expect(increment).toBeGreaterThan(-1);
    expect(increment).toBeLessThan(enqueue);
    expect(send).toBeGreaterThan(enqueue);
    expect(generation).toBeGreaterThan(send);
    expect(generation).toBeLessThan(decrement);
    expect(decrement).toBeGreaterThan(send);
    expect(header).toContain('FThreadSafeCounter ResponsesPending');
  });

  it('suppresses only idle deadlines while a response is pending', () => {
    expect(server).toContain('Conn->ResponsesPending.GetValue() > 0');
    expect(policy).toMatch(/if \(bFrameStarted\)[\s\S]*NowSeconds >= PartialFrameDeadline/);
    expect(policy).toMatch(/if \(bResponsePending\)[\s\S]*return false/);
    expect(policy.indexOf('if (bFrameStarted)')).toBeLessThan(policy.indexOf('if (bResponsePending)'));
  });

  it('pins the observed >5s response and partial-frame adversarial cases in native tests', () => {
    expect(nativeTest).toContain('>5s handler does not lose its response connection');
    expect(nativeTest).toContain('response completion starts a fresh idle window');
    expect(nativeTest).toContain('partial-frame slowloris expires despite pending response');
    expect(nativeTest).toContain('later bytes cannot extend the partial-frame deadline');
  });

  it('uses bounded exact sends after switching accepted sockets to non-blocking mode', () => {
    expect(server).toContain('SetNonBlocking(true)');
    expect(server).toContain('WaitForWrite');
    expect(server).toMatch(/while \(TotalSent < NumBytes && bIsRunning && Conn->bAlive\)/);
    expect(server).toContain('TotalSent += BytesSent');
    expect(server).toContain('Shutdown(ESocketShutdownMode::ReadWrite)');
    expect(server).toContain('Deadline.ShouldAbort(FPlatformTime::Seconds())');
    expect(server).toContain('Deadline.MarkProgress(FPlatformTime::Seconds())');
  });

  it('never blocks the game-thread ticker on response socket backpressure', () => {
    const process = server.indexOf('CommandHandler->ProcessCommand(Cmd.Message)');
    const enqueue = server.indexOf(
      'Cmd.Conn->OutboundResponses.Enqueue(FHaybaMCPOutboundResponse',
      process,
    );
    const writer = server.indexOf('void FHaybaMCPTcpServer::HandleClientWrites');
    expect(process).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(process);
    expect(writer).toBeGreaterThan(-1);
    expect(server.slice(process, enqueue)).not.toContain('SendMessage(');
    expect(server.slice(writer, process)).toContain('SendMessage(Conn, Response.Message)');
  });

  it('retains thread-safe server ownership and truly joins every worker before unload', () => {
    expect(header).toContain('TSharedFromThis<FHaybaMCPTcpServer, ESPMode::ThreadSafe>');
    expect(header).toContain('TArray<TUniquePtr<FHaybaMCPJoinableWorker>> Workers');
    expect(moduleHeader).toContain('TSharedPtr<FHaybaMCPTcpServer, ESPMode::ThreadSafe> TcpServer');
    expect(moduleCpp).toContain('MakeShared<FHaybaMCPTcpServer, ESPMode::ThreadSafe>');
    expect(server).toContain('[Self, Conn]()');
    expect(server).not.toContain('[this, Conn]()');
    expect(server.match(/MakeUnique<FHaybaMCPJoinableWorker>/g)).toHaveLength(2);
    expect(server).toContain('WorkersToJoin = MoveTemp(Workers)');
    expect(server).toContain('Worker->JoinAndDestroy()');
    expect(server).toMatch(/Worker->JoinAndDestroy\(\);[\s\S]*WorkersToJoin\.Reset\(\)/);
    const wait = joinableWorker.indexOf('Thread->WaitForCompletion();');
    const destroyThread = joinableWorker.indexOf('delete Thread;', wait);
    const destroyCaptures = joinableWorker.indexOf('Callable.Reset();', destroyThread);
    expect(wait).toBeGreaterThan(-1);
    expect(destroyThread).toBeGreaterThan(wait);
    expect(destroyCaptures).toBeGreaterThan(destroyThread);
    expect(server).not.toContain('Async(EAsyncExecution::Thread');
    expect(header).not.toContain('TFuture');
    expect(server).not.toContain('EAsyncExecution::ThreadPool');
    expect(transportPolicyTest).toContain('true join destroys callable captures before returning');
    expect(transportPolicyTest).toContain('a fresh worker starts after exact prior teardown');
    expect(transportPolicyTest).toContain('restart capture also dies before join returns');
  });

  it('bounds accepted clients and dates idle expiry from accept rather than worker scheduling', () => {
    expect(header).toContain('MaxClientConnections = 16');
    expect(server).toContain('AcceptedAtSeconds(FPlatformTime::Seconds())');
    expect(server).toContain('ClientCount.GetValue() >= MaxClientConnections');
    expect(header).toContain('FThreadSafeCounter RequestsReceived');
    expect(server).toContain('Conn->RequestsReceived.GetValue() == 0');
    expect(server).toContain('? Conn->AcceptedAtSeconds');
  });

  it('uses bounded per-connection pipelines and one serial outbound queue', () => {
    expect(header).toContain('MaxPipelinedRequestsPerClient = 8');
    expect(header).toContain('MaxOutboundMemoryBytesPerClient = 32 * 1024 * 1024');
    expect(header).toContain(
      'TQueue<FHaybaMCPOutboundResponse, EQueueMode::Mpsc> OutboundResponses',
    );
    expect(server).toContain('Conn->ResponsesPending.GetValue() >= MaxPipelinedRequestsPerClient');
    expect(server).toContain('FHaybaMCPOutboundBudgetReservation::TryCreate');
    expect(server).toContain('Cmd.Conn->OutboundEvent->Trigger()');
  });

  it('refuses oversized responses and queue overflow before allocation/addition', () => {
    const measure = server.indexOf('FTCHARToUTF8_Convert::ConvertedLength');
    const allocate = server.indexOf('FTCHARToUTF8 Utf8Msg');
    expect(transportPolicy).toContain('ClassifyFrameBytes(uint64 FrameBytes, uint64 MaxFrameBytes)');
    expect(transportPolicy).toContain('CandidateBytes > MaxBytes - ReservedBytes');
    expect(server).toContain('ClassifyResponseUtf8(ResponseString, MaxResponseBytes');
    expect(measure).toBeGreaterThan(-1);
    expect(allocate).toBeGreaterThan(measure);
    expect(server).not.toContain('QueuedResponseChars.Add(');
    expect(server).not.toContain('QueuedResponseChars.Subtract(');
    expect(transportPolicyTest).toContain('MAX_uint64');
    expect(transportPolicyTest).toContain('without allocation');
  });

  it('holds coupled client/global memory through send completion', () => {
    const dequeue = server.indexOf('Conn->OutboundResponses.Dequeue(Response)');
    const send = server.indexOf('SendMessage(Conn, Response.Message)', dequeue);
    const release = server.indexOf('Response.MemoryReservation.Reset()', send);
    expect(header).toContain('FHaybaMCPOutboundBudgetPtr OutboundBudget');
    expect(header).toContain('FHaybaMCPOutboundBudgetPtr GlobalOutboundBudget');
    expect(header).toContain('FHaybaMCPOutboundBudgetReservationPtr MemoryReservation');
    expect(server).toContain('MaxGlobalOutboundMemoryBytes = static_cast<int64>(MaxResponseBytes) * 4');
    expect(server).toContain('max_global_outbound_memory_bytes');
    expect(server).toContain('ResponseString.GetAllocatedSize()');
    expect(server).toContain('outbound_budget_includes_in_flight');
    expect(server).toContain('Refusing TCP restart while outbound-memory leases are still active');
    expect(dequeue).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(dequeue);
    expect(release).toBeGreaterThan(send);
    expect(server.slice(dequeue, send)).not.toContain('MemoryReservation.Reset()');
    expect(transportPolicyTest).toContain(
      'in-flight response remains globally accounted after dequeue',
    );
    expect(transportPolicyTest).toContain(
      'concurrent clients cannot each retain the global maximum',
    );
    expect(transportPolicyTest).toContain(
      '64 clients cannot each retain a maximum-size response',
    );
    expect(transportPolicyTest).toContain(
      'restart cannot reconfigure a budget with active sends',
    );
  });

  it('uses exactly-once reservations for client, pending, and response accounting', () => {
    expect(transportPolicy).toContain('class FHaybaMCPCountReservation');
    expect(transportPolicy).toContain('if (!bHeld)');
    expect(transportPolicy).toContain('return Counter.Decrement()');
    expect(header).toContain('FHaybaMCPWorkerQuorum ClientWorkers');
    expect(header).toContain('FHaybaMCPCountReservationPtr PendingReservation');
    expect(header).toContain('FHaybaMCPCountReservationPtr ResponseReservation');
    expect(server).not.toContain('ClientCount.Decrement()');
    expect(server).not.toContain('PendingCommandCount.Decrement()');
    expect(server).not.toContain('ResponsesPending.Decrement()');
    expect(transportPolicyTest).toContain('concurrent cleanup releases exactly once');
    expect(transportPolicyTest).toContain('accounting never goes negative');
  });

  it('retains max-client occupancy until both connection workers finish', () => {
    const reader = server.indexOf('Self->HandleClientConnection(Conn)');
    const readerComplete = server.indexOf('Self->CompleteClientWorker(Conn, TEXT("reader"))');
    const writer = server.indexOf('Self->HandleClientWrites(Conn)');
    const writerComplete = server.indexOf('Self->CompleteClientWorker(Conn, TEXT("writer"))');
    expect(transportPolicy).toContain('class FHaybaMCPWorkerQuorum');
    expect(transportPolicy).toContain('if (RemainingWorkers == 0)');
    expect(reader).toBeGreaterThan(-1);
    expect(readerComplete).toBeGreaterThan(reader);
    expect(writer).toBeGreaterThan(-1);
    expect(writerComplete).toBeGreaterThan(writer);
    expect(server).not.toMatch(/HandleClientConnection[\s\S]*?ClientCount\.Decrement/);
    expect(transportPolicyTest).toContain('reader exit alone does not free a client slot');
    expect(transportPolicyTest).toContain('final writer exit releases the client slot');
  });
});
