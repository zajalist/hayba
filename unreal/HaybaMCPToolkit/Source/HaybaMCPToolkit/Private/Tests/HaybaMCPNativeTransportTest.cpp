#include "Misc/AutomationTest.h"
#include "HaybaMCPTcpServer.h"
#include "Tests/HaybaMCPLeaseTestUtil.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

#if WITH_DEV_AUTOMATION_TESTS

// Only bypass listener admission/ticker registration: these tests exercise the
// production reader, writer, dispatch, reservations and final-worker quorum on
// actual platform sockets, with explicitly delayed game-thread dispatch.
struct FHaybaMCPNativeTransportTestAccess
{
	static void Prepare(FHaybaMCPTcpServer& Server)
	{
		Server.bIsRunning = true;
		Server.SetCommandHandler(HaybaMCPLeaseTest::Router());
	}
	static FHaybaMCPClientConnectionPtr Adopt(FHaybaMCPTcpServer& Server, FSocket* Socket)
	{
		return MakeShared<FHaybaMCPClientConnection, ESPMode::ThreadSafe>(Socket,
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Server.ClientCount),
			Server.MaxOutboundMemoryBytesPerClient);
	}
	static void Start(const TSharedRef<FHaybaMCPTcpServer, ESPMode::ThreadSafe>& Server,
		const FHaybaMCPClientConnectionPtr& Conn, FThreadSafeCounter& Readers, FThreadSafeCounter& Writers)
	{
		auto Launch = [&](bool bReader, FThreadSafeCounter& Completed)
		{
			auto Worker = MakeUnique<FHaybaMCPJoinableWorker>([Server, Conn, bReader, &Completed]()
			{
				if (bReader) Server->HandleClientConnection(Conn);
				else Server->HandleClientWrites(Conn);
				Server->CompleteClientWorker(Conn, bReader ? TEXT("test-reader") : TEXT("test-writer"));
				Completed.Increment();
			});
			if (!Worker->Start(bReader ? TEXT("HaybaNativeEOFReader") : TEXT("HaybaNativeEOFWriter")))
			{
				Conn->bAlive = false;
				Conn->Socket->Shutdown(ESocketShutdownMode::ReadWrite);
				Server->CompleteClientWorker(Conn, TEXT("test-start-failed"));
				Completed.Increment();
			}
			Server->RetainWorker(MoveTemp(Worker));
		};
		Launch(true, Readers);
		Launch(false, Writers);
	}
	static void Drain(FHaybaMCPTcpServer& Server) { Server.DrainPendingCommands(0.0f); }
	static int32 Pending(const FHaybaMCPTcpServer& Server) { return Server.PendingCommandCount.GetValue(); }
	static int64 Reserved(const FHaybaMCPTcpServer& Server) { return Server.GlobalOutboundBudget->GetReservedBytes(); }
	static int32 ClosedNotifications(FHaybaMCPTcpServer& Server)
	{
		int32 Id = 0, Count = 0;
		while (Server.ClosedConnections.Dequeue(Id))
		{
			++Count;
			Server.CommandHandler->NotifyConnectionClosed(Id);
		}
		return Count;
	}
	static bool WouldBlock(FSocket& Socket)
	{
		uint8 Byte = 0; int32 Bytes = -1;
		return FHaybaMCPTcpServer::ReceiveAvailable(Socket, &Byte, 1, Bytes)
			== FHaybaMCPTcpServer::EReceiveResult::WouldBlock && Bytes == 0;
	}
};

namespace
{
	enum class EScenario { Incomplete, HalfClose, WouldBlock, Reset, Shutdown, PartialNext };

	class FNativeTransportCommand : public IAutomationLatentCommand
	{
	public:
		FNativeTransportCommand(FAutomationTestBase* InTest, EScenario InScenario)
			: Test(InTest), Scenario(InScenario), Server(MakeShared<FHaybaMCPTcpServer, ESPMode::ThreadSafe>(0))
			, Owner(HaybaMCPLeaseTest::UniqueOwner(TEXT("native-eof")))
			, Id(FGuid::NewGuid().ToString(EGuidFormats::Digits)) {}
		~FNativeTransportCommand() { Cleanup(); }

		virtual bool Update() override
		{
			if (!bStarted)
			{
				bStarted = true;
				StartedAt = FPlatformTime::Seconds();
				if (!Setup()) { Cleanup(); return true; }
			}
			const double Now = FPlatformTime::Seconds();
			if (Now - StartedAt > 4.0)
			{
				Test->AddError(TEXT("native transport scenario exceeded its 4 s cap (frame timeout remains 5 s)"));
				Cleanup();
				return true;
			}
			if (Scenario == EScenario::Incomplete || Scenario == EScenario::PartialNext)
			{
				if (Readers.GetValue() == 1 && Writers.GetValue() == 1 && Server->GetClientCount() == 0)
				{
					if (Scenario == EScenario::PartialNext)
						Test->TestEqual(TEXT("partial next frame still cancels accepted work"), Conn->RequestsReceived.GetValue(), 1);
					Cleanup(); return true;
				}
				if (Now - StartedAt > 1.5)
				{
					Test->AddError(TEXT("incomplete FIN did not retire both workers/one slot within 1.5 s"));
					Cleanup(); return true;
				}
				return false;
			}
			if (!bAccepted)
			{
				if (Conn->ResponsesPending.GetValue() != 1) return false;
				bAccepted = true;
				AcceptedAt = Now;
				if (Scenario == EScenario::Reset)
				{
					Test->TestTrue(TEXT("zero linger enabled on actual peer"), Peer->SetLinger(true, 0));
					Peer->Close();
				}
				return false;
			}
			if (!bDispatched)
			{
				if (Now - AcceptedAt < 0.35) return false;
				Test->TestEqual(TEXT("accepted response keeps the slot during delayed dispatch"), Server->GetClientCount(), 1);
				Test->TestEqual(TEXT("delayed response reservation remains held"), Conn->ResponsesPending.GetValue(), 1);
				Test->TestEqual(TEXT("pending dispatch retains the writer"), Writers.GetValue(), 0);
				Test->TestTrue(TEXT("outbound queue is temporarily empty"), Conn->OutboundResponses.IsEmpty());
				Test->TestTrue(TEXT("accepted work remains alive"), static_cast<bool>(Conn->bAlive));
				if (Scenario != EScenario::WouldBlock)
					Test->TestEqual(TEXT("terminal receive retires reader before delayed dispatch"), Readers.GetValue(), 1);
				bDispatched = true;
				DispatchedAt = Now;
				if (Scenario == EScenario::Shutdown)
				{
					Cleanup(); return true;
				}
				FHaybaMCPNativeTransportTestAccess::Drain(*Server);
				return false;
			}
			if (Scenario == EScenario::Reset)
			{
				if (Readers.GetValue() == 1 && Writers.GetValue() == 1 && Server->GetClientCount() == 0)
				{
					Test->TestEqual(TEXT("reset releases its response reservation"), Conn->ResponsesPending.GetValue(), 0);
					Test->TestEqual(TEXT("reset releases outbound memory"), Conn->OutboundBudget->GetReservedBytes(), 0ll);
					Cleanup(); return true;
				}
			}
			else
			{
				uint8 Buffer[4096];
				int32 Bytes = 0;
				const bool bReceived = Peer->Recv(Buffer, UE_ARRAY_COUNT(Buffer), Bytes);
				if (Bytes > 0) Reply.Append(Buffer, Bytes);
				if (!bReplyChecked && Reply.Num() >= 4)
				{
					const uint32 Length = (uint32(Reply[0]) << 24) | (uint32(Reply[1]) << 16) | (uint32(Reply[2]) << 8) | uint32(Reply[3]);
					if (Length > 64 * 1024) { Test->AddError(TEXT("invalid reply length")); Cleanup(); return true; }
					if (Reply.Num() >= int32(Length) + 4)
					{
						const FUTF8ToTCHAR Utf8(reinterpret_cast<const ANSICHAR*>(Reply.GetData() + 4), Length);
						const TSharedPtr<FJsonObject> Json = HaybaMCPLeaseTest::Json(FString(Utf8.Length(), Utf8.Get()));
						Test->TestEqual(TEXT("same request id survives half-close/delayed dispatch"), Json->GetStringField(TEXT("id")), Id);
						Test->TestTrue(TEXT("actual ping response succeeds"), Json->GetBoolField(TEXT("ok")));
						bReplyChecked = true;
						if (Scenario == EScenario::WouldBlock)
						{
							Test->TestEqual(TEXT("healthy socket remains occupied after would-block and valid frame"), Server->GetClientCount(), 1);
							Test->TestTrue(TEXT("healthy receive-half remains open"), static_cast<bool>(Conn->bAlive));
							Test->TestTrue(TEXT("healthy peer send-half close succeeds"), Peer->Shutdown(ESocketShutdownMode::Write));
						}
					}
				}
				if (!bReceived && Bytes == 0)
				{
					Test->TestTrue(TEXT("correlated response precedes terminal peer receive"), bReplyChecked);
					bPeerEnded = true;
				}
				if (bReplyChecked && bPeerEnded && Readers.GetValue() == 1 && Writers.GetValue() == 1 && Server->GetClientCount() == 0)
				{
					Test->TestEqual(TEXT("response generation incremented once"), Conn->ResponseGeneration.GetValue(), 1);
					Test->TestEqual(TEXT("response reservation drained"), Conn->ResponsesPending.GetValue(), 0);
					Test->TestEqual(TEXT("completed send releases outbound memory before connection destruction"), Conn->OutboundBudget->GetReservedBytes(), 0ll);
					Cleanup(); return true;
				}
			}
			if (Now - DispatchedAt > 1.5)
			{
				Test->AddError(TEXT("terminal input/reply did not drain both workers/one slot within 1.5 s"));
				Cleanup(); return true;
			}
			return false;
		}

	private:
		bool Setup()
		{
			if (!Test->TestTrue(TEXT("native transport tests run only in owned scratch automation children"),
				FParse::Param(FCommandLine::Get(), TEXT("unattended")) && FParse::Value(FCommandLine::Get(), TEXT("HaybaAutomationChild="), Child) && Child == TEXT("p0scratch"))) return false;
			if (!Test->TestTrue(TEXT("registered command router exists"), HaybaMCPLeaseTest::Router().IsValid())) return false;
			ISocketSubsystem* Sockets = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
			TSharedRef<FInternetAddr> Address = Sockets->CreateInternetAddr();
			for (int32 Attempt = 0; Attempt < 8; ++Attempt)
			{
				Listener = FTcpSocketBuilder(TEXT("HaybaNativeEOFListener")).BoundToAddress(FIPv4Address(127, 0, 0, 1)).BoundToPort(0).Listening(1);
				if (!Listener) break;
				Listener->GetAddress(*Address);
				if (Address->GetPort() < 52342 || Address->GetPort() > 52350) break;
				Listener->Close(); Sockets->DestroySocket(Listener); Listener = nullptr;
			}
			if (!Test->TestNotNull(TEXT("owned ephemeral loopback listener outside fallback ports"), Listener)) return false;
			Test->TestTrue(TEXT("listener has ephemeral port"), Address->GetPort() > 0);
			Peer = Sockets->CreateSocket(NAME_Stream, TEXT("HaybaNativeEOFPeer"), false);
			if (!Test->TestNotNull(TEXT("owned platform client"), Peer) || !Test->TestTrue(TEXT("loopback connect succeeds"), Peer->Connect(*Address))) return false;
			bool bPending = false;
			if (!Test->TestTrue(TEXT("bounded loopback accept"), Listener->WaitForPendingConnection(bPending, FTimespan::FromMilliseconds(500)) && bPending)) return false;
			FSocket* Accepted = Listener->Accept(TEXT("HaybaNativeEOFServer"));
			if (!Test->TestNotNull(TEXT("actual accepted platform socket"), Accepted)) return false;
			Listener->Close(); Sockets->DestroySocket(Listener); Listener = nullptr;
			FHaybaMCPNativeTransportTestAccess::Prepare(*Server);
			Conn = FHaybaMCPNativeTransportTestAccess::Adopt(*Server, Accepted);
			Conn->ConnId = 950000 + ConnectionSerial.Increment();
			if (!Test->TestTrue(TEXT("accepted socket nonblocking"), Accepted->SetNonBlocking(true))) return false;
			if (Scenario == EScenario::WouldBlock)
			{
				uint8 Byte = 0; int32 Bytes = -1;
				Test->TestTrue(TEXT("actual idle native receive is true/would-block"), Accepted->Recv(&Byte, 1, Bytes));
				Test->TestEqual(TEXT("actual would-block returns zero bytes"), Bytes, 0);
				Test->TestTrue(TEXT("production receive seam preserves actual would-block"), FHaybaMCPNativeTransportTestAccess::WouldBlock(*Accepted));
			}
			const FString Request = FString::Printf(TEXT("{\"id\":\"%s\",\"cmd\":\"ping\",\"owner\":\"%s\",\"params\":{}}"), *Id, *Owner);
			FTCHARToUTF8 Utf8(*Request);
			const uint32 Length = Utf8.Length();
			TArray<uint8> Frame{ uint8(Length >> 24), uint8(Length >> 16), uint8(Length >> 8), uint8(Length) };
			if (Scenario == EScenario::Incomplete) Frame.SetNum(2);
			else
			{
				Frame.Append(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length());
				if (Scenario == EScenario::PartialNext) { Frame.Add(0); Frame.Add(0); }
			}
			int32 Sent = 0;
			if (!Test->TestTrue(TEXT("small test frame fully sent"), Peer->Send(Frame.GetData(), Frame.Num(), Sent) && Sent == Frame.Num())) return false;
			if (Scenario != EScenario::WouldBlock && Scenario != EScenario::Reset)
				if (!Test->TestTrue(TEXT("orderly peer send-half close"), Peer->Shutdown(ESocketShutdownMode::Write))) return false;
			if (!Test->TestTrue(TEXT("peer reads nonblocking"), Peer->SetNonBlocking(true))) return false;
			FHaybaMCPNativeTransportTestAccess::Start(Server, Conn, Readers, Writers);
			return true;
		}
		void Cleanup()
		{
			if (bCleaned) return;
			bCleaned = true;
			// Shutdown deliberately discards the close-notification queue. Inspect
			// normal worker closure before that lifecycle boundary, on game thread.
			if (Conn.IsValid() && Readers.GetValue() == 1 && Writers.GetValue() == 1)
				Test->TestEqual(TEXT("reader/writer closure notifies connection exactly once"), FHaybaMCPNativeTransportTestAccess::ClosedNotifications(*Server), 1);
			Server->Shutdown();
			Server->Shutdown();
			Test->TestEqual(TEXT("repeated shutdown leaves active-client count balanced"), Server->GetClientCount(), 0);
			Test->TestEqual(TEXT("shutdown leaves pending-command count balanced"), FHaybaMCPNativeTransportTestAccess::Pending(*Server), 0);
			if (Conn.IsValid())
			{
				HaybaMCPLeaseTest::Router()->NotifyConnectionClosed(Conn->ConnId);
				Conn.Reset();
			}
			Test->TestEqual(TEXT("no global outbound reservation survives cleanup"), FHaybaMCPNativeTransportTestAccess::Reserved(*Server), 0ll);
			FHaybaMCPLeaseManager::Get().ForgetOwnerForTests(Owner);
			ISocketSubsystem* Sockets = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
			if (Peer) { Peer->Close(); Sockets->DestroySocket(Peer); Peer = nullptr; }
			if (Listener) { Listener->Close(); Sockets->DestroySocket(Listener); Listener = nullptr; }
		}
		FAutomationTestBase* Test;
		EScenario Scenario;
		TSharedRef<FHaybaMCPTcpServer, ESPMode::ThreadSafe> Server;
		FHaybaMCPClientConnectionPtr Conn;
		FSocket* Listener = nullptr;
		FSocket* Peer = nullptr;
		FThreadSafeCounter Readers, Writers;
		static FThreadSafeCounter ConnectionSerial;
		FString Owner, Id, Child;
		TArray<uint8> Reply;
		double StartedAt = 0.0, AcceptedAt = 0.0, DispatchedAt = 0.0;
		bool bStarted = false, bAccepted = false, bDispatched = false, bReplyChecked = false, bPeerEnded = false, bCleaned = false;
	};
	FThreadSafeCounter FNativeTransportCommand::ConnectionSerial;

	bool RunScenario(FAutomationTestBase* Test, EScenario Scenario)
	{
		FAutomationTestFramework::Get().EnqueueLatentCommand(MakeShared<FNativeTransportCommand>(Test, Scenario));
		return true;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaNativeIncompleteFINTest, "Hayba.MCP.Transport.NativeIncompleteFIN", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaNativeIncompleteFINTest::RunTest(const FString&) { return RunScenario(this, EScenario::Incomplete); }
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaNativeDelayedHalfCloseTest, "Hayba.MCP.Transport.NativeDelayedHalfClose", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaNativeDelayedHalfCloseTest::RunTest(const FString&) { return RunScenario(this, EScenario::HalfClose); }
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaNativeWouldBlockTest, "Hayba.MCP.Transport.NativeWouldBlock", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaNativeWouldBlockTest::RunTest(const FString&) { return RunScenario(this, EScenario::WouldBlock); }
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaNativeResetDrainTest, "Hayba.MCP.Transport.NativeResetDrain", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaNativeResetDrainTest::RunTest(const FString&) { return RunScenario(this, EScenario::Reset); }
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaNativeShutdownPendingTest, "Hayba.MCP.Transport.NativeShutdownPending", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaNativeShutdownPendingTest::RunTest(const FString&) { return RunScenario(this, EScenario::Shutdown); }
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaNativePartialNextFINTest, "Hayba.MCP.Transport.NativePartialNextFIN", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaNativePartialNextFINTest::RunTest(const FString&) { return RunScenario(this, EScenario::PartialNext); }

#endif
