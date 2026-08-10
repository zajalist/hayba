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

describe('TCP in-flight response lifetime contract', () => {
  it('marks a response pending before queueing and clears it only after send completes', () => {
    const increment = server.indexOf('Conn->ResponsesPending.Increment()');
    const enqueue = server.indexOf('PendingCommands.Enqueue');
    const send = server.indexOf('SendMessage(Conn, Response)');
    const generation = server.indexOf('Conn->ResponseGeneration.Increment()', send);
    const decrement = server.indexOf('Conn->ResponsesPending.Decrement()', send);
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
    const enqueue = server.indexOf('Cmd.Conn->OutboundResponses.Enqueue(ResponseString)', process);
    const writer = server.indexOf('void FHaybaMCPTcpServer::HandleClientWrites');
    expect(process).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(process);
    expect(writer).toBeGreaterThan(-1);
    expect(server.slice(process, enqueue)).not.toContain('SendMessage(');
    expect(server.slice(writer, process)).toContain('SendMessage(Conn, Response)');
  });

  it('retains thread-safe server ownership and joins every worker before unload', () => {
    expect(header).toContain('TSharedFromThis<FHaybaMCPTcpServer, ESPMode::ThreadSafe>');
    expect(header).toContain('TArray<TFuture<void>> Workers');
    expect(moduleHeader).toContain('TSharedPtr<FHaybaMCPTcpServer, ESPMode::ThreadSafe> TcpServer');
    expect(moduleCpp).toContain('MakeShared<FHaybaMCPTcpServer, ESPMode::ThreadSafe>');
    expect(server).toContain('[Self, Conn]()');
    expect(server).not.toContain('[this, Conn]()');
    expect(server).toMatch(/Thread->WaitForCompletion\(\)[\s\S]*WorkersToJoin = MoveTemp\(Workers\)/);
    expect(server).toContain('Worker.Wait()');
    expect(server).not.toContain('EAsyncExecution::ThreadPool');
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
    expect(header).toContain('MaxQueuedResponseCharsPerClient = 8 * 1024 * 1024');
    expect(header).toContain('TQueue<FString, EQueueMode::Mpsc> OutboundResponses');
    expect(server).toContain('Conn->ResponsesPending.GetValue() >= MaxPipelinedRequestsPerClient');
    expect(server).toContain('QueuedChars > MaxQueuedResponseCharsPerClient');
    expect(server).toContain('Cmd.Conn->OutboundEvent->Trigger()');
  });
});
