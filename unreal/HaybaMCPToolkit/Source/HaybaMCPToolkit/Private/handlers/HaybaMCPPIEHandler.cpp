#include "HaybaMCPPIEHandler.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

#if WITH_EDITOR
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/World.h"
#include "Engine/GameViewportClient.h"
#include "UnrealClient.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "UObject/UnrealType.h"
#include "UObject/Class.h"
#include "UObject/Object.h"
#include "Containers/Ticker.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "Widgets/SWidget.h"
#include "Layout/Children.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "InputCoreTypes.h"
#include "InputKeyEventArgs.h"
#include "GenericPlatform/GenericPlatformInputDeviceMapper.h"
#include "UnrealEngine.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/FrameNumber.h"
#endif

// ---------------------------------------------------------------------------
// Boilerplate
// ---------------------------------------------------------------------------

TArray<FString> FHaybaMCPPIEHandler::GetCommands() const
{
    return {
        TEXT("editor_pie_assert"),
        TEXT("editor_pie_wait_for"),
        TEXT("editor_pie_press_key"),
        TEXT("editor_pie_screenshot"),
        TEXT("editor_pie_mouse"),
        TEXT("editor_pie_type_text"),
        TEXT("editor_pie_axis"),
        TEXT("editor_pie_widget_tree"),
        TEXT("editor_pie_click_widget"),
    };
}

FHaybaMCPPIEHandler::~FHaybaMCPPIEHandler()
{
#if WITH_EDITOR
    if (bHooksBound && GEditor)
    {
        if (BeginPIEHandle.IsValid())  FEditorDelegates::BeginPIE.Remove(BeginPIEHandle);
        if (EndPIEHandle.IsValid())    FEditorDelegates::EndPIE.Remove(EndPIEHandle);
        if (CancelPIEHandle.IsValid()) FEditorDelegates::CancelPIE.Remove(CancelPIEHandle);
    }
#endif
}

FHaybaHandlerResult FHaybaMCPPIEHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
#if !WITH_EDITOR
    return FHaybaHandlerResult::Err(TEXT("PIE handler only available in editor builds"));
#else
    EnsureLifecycleHooks();
    if (Cmd == TEXT("editor_pie_assert"))     return PIEAssert(Params);
    if (Cmd == TEXT("editor_pie_wait_for"))   return PIEWaitFor(Params);
    if (Cmd == TEXT("editor_pie_press_key"))  return PIEPressKey(Params);
    if (Cmd == TEXT("editor_pie_mouse"))         return PIEMouse(P);
    if (Cmd == TEXT("editor_pie_type_text"))     return PIETypeText(P);
    if (Cmd == TEXT("editor_pie_axis"))          return PIEAxis(P);
    if (Cmd == TEXT("editor_pie_widget_tree"))   return PIEWidgetTree(P);
    if (Cmd == TEXT("editor_pie_click_widget"))  return PIEClickWidget(P);
    if (Cmd == TEXT("editor_pie_screenshot")) return PIEScreenshot(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown PIE command: %s"), *Cmd));
#endif
}

#if WITH_EDITOR

void FHaybaMCPPIEHandler::EnsureLifecycleHooks()
{
    if (bHooksBound) return;
    bHooksBound = true;

    BeginPIEHandle = FEditorDelegates::BeginPIE.AddLambda([this](const bool bIsSimulating)
    {
        this->OnBeginPIE(bIsSimulating);
    });
    EndPIEHandle = FEditorDelegates::EndPIE.AddLambda([this](const bool bIsSimulating)
    {
        this->OnEndPIE(bIsSimulating);
    });
    CancelPIEHandle = FEditorDelegates::CancelPIE.AddLambda([this]()
    {
        this->OnEndPIE(false);
    });
}

void FHaybaMCPPIEHandler::OnBeginPIE(const bool /*bIsSimulating*/)
{
    bCancelPending = false;
}

void FHaybaMCPPIEHandler::OnEndPIE(const bool /*bIsSimulating*/)
{
    bCancelPending = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static UWorld* GetPIEWorld()
{
    if (!GEditor) return nullptr;
    if (GEditor->PlayWorld) return GEditor->PlayWorld;
    // Fallback: walk world contexts for an active PIE world.
    for (const FWorldContext& Ctx : GEngine->GetWorldContexts())
    {
        if (Ctx.WorldType == EWorldType::PIE && Ctx.World())
        {
            return Ctx.World();
        }
    }
    return nullptr;
}

static AActor* ResolveActor(UWorld* World, const TSharedPtr<FJsonObject>& P, FString& OutError)
{
    if (!World) { OutError = TEXT("no PIE world"); return nullptr; }

    FString Path, Label;
    P->TryGetStringField(TEXT("actor_path"), Path);
    P->TryGetStringField(TEXT("actor_label"), Label);

    if (!Path.IsEmpty())
    {
        // Try direct PathName match against actors in the PIE world.
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            AActor* A = *It;
            if (!A) continue;
            if (A->GetPathName() == Path || A->GetPathName().EndsWith(Path))
                return A;
            if (A->GetName() == Path) return A;
        }
        // FindObject fallback.
        if (UObject* Obj = StaticFindObject(AActor::StaticClass(), nullptr, *Path))
        {
            if (AActor* A = Cast<AActor>(Obj)) return A;
        }
        OutError = FString::Printf(TEXT("actor not found by path: %s"), *Path);
        return nullptr;
    }

    if (!Label.IsEmpty())
    {
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            AActor* A = *It;
            if (A && A->GetActorLabel() == Label) return A;
        }
        OutError = FString::Printf(TEXT("actor not found by label: %s"), *Label);
        return nullptr;
    }

    OutError = TEXT("actor_path or actor_label is required");
    return nullptr;
}

// Read a reflected property to a JsonValue. Returns null + sets OutError on
// unsupported type.
static TSharedPtr<FJsonValue> ReadPropertyAsJson(FProperty* Prop, const void* Container, FString& OutError)
{
    if (!Prop || !Container)
    {
        OutError = TEXT("null property or container");
        return nullptr;
    }
    const void* Value = Prop->ContainerPtrToValuePtr<void>(Container);

    if (FBoolProperty* P = CastField<FBoolProperty>(Prop))
        return MakeShared<FJsonValueBoolean>(P->GetPropertyValue(Value));
    if (FIntProperty* P = CastField<FIntProperty>(Prop))
        return MakeShared<FJsonValueNumber>(P->GetPropertyValue(Value));
    if (FInt64Property* P = CastField<FInt64Property>(Prop))
        return MakeShared<FJsonValueNumber>((double)P->GetPropertyValue(Value));
    if (FFloatProperty* P = CastField<FFloatProperty>(Prop))
        return MakeShared<FJsonValueNumber>(P->GetPropertyValue(Value));
    if (FDoubleProperty* P = CastField<FDoubleProperty>(Prop))
        return MakeShared<FJsonValueNumber>(P->GetPropertyValue(Value));
    if (FByteProperty* P = CastField<FByteProperty>(Prop))
        return MakeShared<FJsonValueNumber>(P->GetPropertyValue(Value));
    if (FEnumProperty* P = CastField<FEnumProperty>(Prop))
    {
        FNumericProperty* Underlying = P->GetUnderlyingProperty();
        const int64 Raw = Underlying->GetSignedIntPropertyValue(Value);
        return MakeShared<FJsonValueString>(P->GetEnum()->GetNameStringByValue(Raw));
    }
    if (FStrProperty* P = CastField<FStrProperty>(Prop))
        return MakeShared<FJsonValueString>(P->GetPropertyValue(Value));
    if (FNameProperty* P = CastField<FNameProperty>(Prop))
        return MakeShared<FJsonValueString>(P->GetPropertyValue(Value).ToString());
    if (FTextProperty* P = CastField<FTextProperty>(Prop))
        return MakeShared<FJsonValueString>(P->GetPropertyValue(Value).ToString());

    if (FStructProperty* S = CastField<FStructProperty>(Prop))
    {
        if (S->Struct == TBaseStructure<FVector>::Get())
        {
            const FVector V = *(const FVector*)Value;
            TArray<TSharedPtr<FJsonValue>> Arr;
            Arr.Add(MakeShared<FJsonValueNumber>(V.X));
            Arr.Add(MakeShared<FJsonValueNumber>(V.Y));
            Arr.Add(MakeShared<FJsonValueNumber>(V.Z));
            return MakeShared<FJsonValueArray>(Arr);
        }
        if (S->Struct == TBaseStructure<FRotator>::Get())
        {
            const FRotator R = *(const FRotator*)Value;
            TArray<TSharedPtr<FJsonValue>> Arr;
            Arr.Add(MakeShared<FJsonValueNumber>(R.Pitch));
            Arr.Add(MakeShared<FJsonValueNumber>(R.Yaw));
            Arr.Add(MakeShared<FJsonValueNumber>(R.Roll));
            return MakeShared<FJsonValueArray>(Arr);
        }
        if (S->Struct == TBaseStructure<FTransform>::Get())
        {
            const FTransform T = *(const FTransform*)Value;
            const FVector L = T.GetLocation();
            const FRotator R = T.Rotator();
            const FVector Sc = T.GetScale3D();
            TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
            TArray<TSharedPtr<FJsonValue>> LA, RA, SA;
            LA.Add(MakeShared<FJsonValueNumber>(L.X)); LA.Add(MakeShared<FJsonValueNumber>(L.Y)); LA.Add(MakeShared<FJsonValueNumber>(L.Z));
            RA.Add(MakeShared<FJsonValueNumber>(R.Pitch)); RA.Add(MakeShared<FJsonValueNumber>(R.Yaw)); RA.Add(MakeShared<FJsonValueNumber>(R.Roll));
            SA.Add(MakeShared<FJsonValueNumber>(Sc.X)); SA.Add(MakeShared<FJsonValueNumber>(Sc.Y)); SA.Add(MakeShared<FJsonValueNumber>(Sc.Z));
            O->SetArrayField(TEXT("location"), LA);
            O->SetArrayField(TEXT("rotation"), RA);
            O->SetArrayField(TEXT("scale"),    SA);
            return MakeShared<FJsonValueObject>(O);
        }
        OutError = FString::Printf(TEXT("unsupported_property_type: struct %s"), *S->Struct->GetName());
        return nullptr;
    }

    if (FObjectPropertyBase* O = CastField<FObjectPropertyBase>(Prop))
    {
        UObject* Obj = O->GetObjectPropertyValue(Value);
        TSharedPtr<FJsonObject> J = MakeShared<FJsonObject>();
        J->SetStringField(TEXT("class"), Obj && Obj->GetClass() ? Obj->GetClass()->GetName() : TEXT(""));
        J->SetStringField(TEXT("path"),  Obj ? Obj->GetPathName() : FString());
        return MakeShared<FJsonValueObject>(J);
    }

    OutError = FString::Printf(TEXT("unsupported_property_type: %s"), *Prop->GetCPPType());
    return nullptr;
}

// Compare two JsonValues with comparator + optional tolerance for numerics.
// Returns 0/+1/-1 (and sets bOk=false if comparison is undefined).
static int32 CompareJson(const TSharedPtr<FJsonValue>& A, const TSharedPtr<FJsonValue>& B, double Tolerance, bool& bOk)
{
    bOk = true;
    if (!A.IsValid() || !B.IsValid()) { bOk = false; return 0; }

    if (A->Type == EJson::Number && B->Type == EJson::Number)
    {
        const double Da = A->AsNumber();
        const double Db = B->AsNumber();
        if (Tolerance > 0.0 && FMath::Abs(Da - Db) <= Tolerance) return 0;
        if (FMath::IsNearlyEqual(Da, Db)) return 0;
        return Da < Db ? -1 : 1;
    }
    if (A->Type == EJson::Boolean && B->Type == EJson::Boolean)
    {
        return (A->AsBool() == B->AsBool()) ? 0 : (A->AsBool() ? 1 : -1);
    }
    if (A->Type == EJson::String && B->Type == EJson::String)
    {
        return A->AsString().Compare(B->AsString());
    }
    if (A->Type == EJson::Array && B->Type == EJson::Array)
    {
        const auto& Aa = A->AsArray();
        const auto& Ab = B->AsArray();
        if (Aa.Num() != Ab.Num()) { return Aa.Num() < Ab.Num() ? -1 : 1; }
        for (int32 i = 0; i < Aa.Num(); ++i)
        {
            const int32 C = CompareJson(Aa[i], Ab[i], Tolerance, bOk);
            if (!bOk || C != 0) return C;
        }
        return 0;
    }
    // Object/null/mixed — only eq supported (string-equality of serialized form is too heavy).
    if (A->Type == B->Type) return 0;
    bOk = false;
    return 0;
}

static bool ComparatorMatches(int32 Cmp, bool bCmpOk, const FString& Op)
{
    if (Op == TEXT("eq"))  return bCmpOk && Cmp == 0;
    if (Op == TEXT("neq")) return !bCmpOk || Cmp != 0;
    if (!bCmpOk) return false;
    if (Op == TEXT("gt"))  return Cmp > 0;
    if (Op == TEXT("lt"))  return Cmp < 0;
    if (Op == TEXT("gte")) return Cmp >= 0;
    if (Op == TEXT("lte")) return Cmp <= 0;
    return false;
}

// Shared wait loop used by both assert and wait_for.
FHaybaHandlerResult FHaybaMCPPIEHandler_WaitLoop(
    FHaybaMCPPIEHandler& Self, const TSharedPtr<FJsonObject>& P, const FString& Comparator)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("GEditor is null"));
    UWorld* World = GetPIEWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("no PIE world (start PIE first)"));

    FString PropName;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("property_name"), PropName) || PropName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("property_name is required"));

    TSharedPtr<FJsonValue> Expected;
    {
        const TSharedPtr<FJsonValue> Raw = P->TryGetField(TEXT("expected_value"));
        if (!Raw.IsValid())
            return FHaybaHandlerResult::Err(TEXT("expected_value is required"));
        Expected = Raw;
    }

    int32 TimeoutMs = 2000;
    P->TryGetNumberField(TEXT("timeout_ms"), TimeoutMs);
    TimeoutMs = FMath::Clamp(TimeoutMs, 0, 600000);  // reject negative (instant/underflow deadline) and cap the game-thread block at 10 min
    double Tolerance = 0.0;
    P->TryGetNumberField(TEXT("tolerance"), Tolerance);

    const double StartTime = FPlatformTime::Seconds();

    int32 Frame = 0;
    TSharedPtr<FJsonValue> LastObserved;
    FString LastErr;

    // Evaluated ONCE. This used to loop until a deadline, pumping the core
    // ticker between iterations to let the world advance — which is what made
    // these commands crash. See the note on the pump removal below.
    //
    // A handler cannot advance the world, so it cannot meaningfully wait: the
    // property it is watching can never change while it blocks. The honest
    // shape is therefore a single observation the caller polls, and the
    // response carries `polling: true` so that is obvious from the result
    // rather than only from the docs.
    {
        if (Self.bCancelPending)
        {
            TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
            R->SetBoolField(TEXT("matched"), false);
            R->SetStringField(TEXT("reason"), TEXT("pie_ended"));
            if (LastObserved.IsValid()) R->SetField(TEXT("observed_value_last"), LastObserved);
            return FHaybaHandlerResult::Ok(R);
        }

        FString ResolveErr;
        AActor* Actor = ResolveActor(World, P, ResolveErr);
        if (Actor)
        {
            FProperty* Prop = FindFProperty<FProperty>(Actor->GetClass(), *PropName);
            if (!Prop)
            {
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("property '%s' not found on %s"), *PropName, *Actor->GetClass()->GetName()));
            }
            FString ReadErr;
            TSharedPtr<FJsonValue> Observed = ReadPropertyAsJson(Prop, Actor, ReadErr);
            if (!Observed.IsValid())
            {
                return FHaybaHandlerResult::Err(ReadErr);
            }
            LastObserved = Observed;

            bool bCmpOk = true;
            const int32 Cmp = CompareJson(Observed, Expected, Tolerance, bCmpOk);
            if (ComparatorMatches(Cmp, bCmpOk, Comparator))
            {
                TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
                R->SetBoolField(TEXT("matched"), true);
                R->SetNumberField(TEXT("frame"), Frame);
                R->SetNumberField(TEXT("elapsed_ms"), (FPlatformTime::Seconds() - StartTime) * 1000.0);
                R->SetField(TEXT("observed_value"), Observed);
                return FHaybaHandlerResult::Ok(R);
            }
        }
        else
        {
            LastErr = ResolveErr;
        }

        ++Frame;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetBoolField(TEXT("matched"), false);
    R->SetBoolField(TEXT("polling"), true);
    R->SetNumberField(TEXT("elapsed_ms"), (FPlatformTime::Seconds() - StartTime) * 1000.0);
    R->SetStringField(TEXT("reason"), LastErr.IsEmpty()
        ? TEXT("condition not met at this instant — call again to poll; the world only advances between calls")
        : LastErr);
    if (LastObserved.IsValid()) R->SetField(TEXT("observed_value_last"), LastObserved);
    return FHaybaHandlerResult::Ok(R);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEAssert(const TSharedPtr<FJsonObject>& P)
{
    return FHaybaMCPPIEHandler_WaitLoop(*this, P, TEXT("eq"));
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEWaitFor(const TSharedPtr<FJsonObject>& P)
{
    FString Comparator = TEXT("eq");
    if (P.IsValid()) P->TryGetStringField(TEXT("comparator"), Comparator);
    Comparator = Comparator.ToLower();
    return FHaybaMCPPIEHandler_WaitLoop(*this, P, Comparator);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEPressKey(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("GEditor is null"));
    UWorld* World = GetPIEWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("no PIE world (start PIE first)"));

    FString KeyName;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("key"), KeyName) || KeyName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("key is required"));

    FString EventStr = TEXT("pressed_and_released");
    P->TryGetStringField(TEXT("event"), EventStr);
    EventStr = EventStr.ToLower();

    int32 HeldMs = 50;
    P->TryGetNumberField(TEXT("held_ms"), HeldMs);

    UGameViewportClient* GVC = World->GetGameViewport();
    if (!GVC) return FHaybaHandlerResult::Err(TEXT("no PIE game viewport"));
    FViewport* VP = GVC->Viewport;
    if (!VP) return FHaybaHandlerResult::Err(TEXT("PIE viewport is null"));

    const FKey Key(*KeyName);
    if (!Key.IsValid())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("invalid key: %s"), *KeyName));

    const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();

    // Resolve the viewport at the moment of use, never from a captured pointer.
    // The old code captured FViewport* and UGameViewportClient*, pumped the core
    // ticker (which can tear PIE down), then dereferenced them — a use-after-free
    // that surfaced as an SEH access violation.
    auto SendNow = [DeviceId, Key](EInputEvent Evt) -> bool
    {
        UWorld* W = GetPIEWorld();
        if (!W) return false;
        UGameViewportClient* Client = W->GetGameViewport();
        if (!Client || !Client->Viewport) return false;

        FInputKeyEventArgs Args(Client->Viewport, DeviceId, Key, Evt,
                                /*AmountDepressed=*/1.0f,
                                /*bIsTouch=*/false,
                                /*EventTimestamp=*/0u);
        Client->InputKey(Args);
        return true;
    };

    bool bReleaseScheduled = false;

    if (EventStr == TEXT("pressed"))
    {
        if (!SendNow(IE_Pressed)) return FHaybaHandlerResult::Err(TEXT("PIE viewport went away before the key was sent"));
    }
    else if (EventStr == TEXT("released"))
    {
        if (!SendNow(IE_Released)) return FHaybaHandlerResult::Err(TEXT("PIE viewport went away before the key was sent"));
    }
    else // pressed_and_released
    {
        if (!SendNow(IE_Pressed)) return FHaybaHandlerResult::Err(TEXT("PIE viewport went away before the key was sent"));

        // The release is DEFERRED onto a real ticker delegate rather than held
        // by spinning here. A handler runs on the game thread, so spinning
        // prevents the very frames the hold is supposed to span — the key would
        // be down for wall-clock time during which the game never ticks.
        const float DelaySeconds = FMath::Clamp((float)HeldMs, 0.0f, 5000.0f) / 1000.0f;
        FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateLambda([SendNow](float) -> bool
            {
                // Re-resolves the viewport internally and no-ops if PIE ended.
                SendNow(IE_Released);
                return false;  // one shot
            }),
            DelaySeconds);
        bReleaseScheduled = true;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("key"), KeyName);
    R->SetStringField(TEXT("event"), EventStr);
    R->SetBoolField(TEXT("dispatched"), true);
    R->SetBoolField(TEXT("release_scheduled"), bReleaseScheduled);
    if (bReleaseScheduled)
    {
        R->SetNumberField(TEXT("release_after_ms"), HeldMs);
        R->SetStringField(TEXT("note"), TEXT("The release fires on a later tick. This call returns immediately, ")
                                        TEXT("so the key is still down when you read this."));
    }
    return FHaybaHandlerResult::Ok(R);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEScreenshot(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("GEditor is null"));
    UWorld* World = GetPIEWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("no PIE world (start PIE first)"));

    FString Filename;
    if (P.IsValid()) P->TryGetStringField(TEXT("filename"), Filename);
    if (Filename.IsEmpty())
    {
        Filename = FPaths::ProjectSavedDir() / TEXT("Screenshots") /
                   FString::Printf(TEXT("HaybaPIE_%s.png"),
                                   *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")));
    }

    // `check_only` reports whether a previously requested file has landed, so a
    // caller can poll without issuing another capture.
    bool bCheckOnly = false;
    if (P.IsValid()) P->TryGetBoolField(TEXT("check_only"), bCheckOnly);

    if (bCheckOnly)
    {
        TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
        R->SetStringField(TEXT("filename"), Filename);
        R->SetBoolField(TEXT("captured"), FPaths::FileExists(Filename));
        R->SetBoolField(TEXT("requested"), false);
        return FHaybaHandlerResult::Ok(R);
    }

    FScreenshotRequest::RequestScreenshot(Filename, /*bShowUI=*/false, /*bAddFilenameSuffix=*/false);

    // Returns immediately. The old code pumped the core ticker for up to three
    // seconds waiting for the file — from inside a game-thread handler, which
    // both froze the editor and re-entered systems that can tear PIE down while
    // this command still held pointers into it.
    //
    // The screenshot is written by the engine a frame or two later. Poll for it
    // with check_only rather than blocking the thread that has to render it.
    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("filename"), Filename);
    R->SetBoolField(TEXT("requested"), true);
    R->SetBoolField(TEXT("captured"), FPaths::FileExists(Filename));
    R->SetStringField(TEXT("note"), TEXT("Capture requested. The engine writes the file on a later frame — ")
                                    TEXT("call again with check_only:true (and the same filename) to see when it lands."));
    return FHaybaHandlerResult::Ok(R);
}


// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
//
// Everything here obeys one rule the old code broke: a handler runs on the game
// thread and must never pump the ticker or sleep. Input is dispatched and the
// call returns; the world advances between calls, not during them.

namespace
{
    /** Live PIE viewport client, or null when PIE is not running. Always
     *  resolved at point of use — never cached across anything that can tick. */
    UGameViewportClient* PIEViewportClient()
    {
        UWorld* W = GetPIEWorld();
        if (!W) return nullptr;
        UGameViewportClient* C = W->GetGameViewport();
        return (C && C->Viewport) ? C : nullptr;
    }

    FKey MouseButtonFromString(const FString& InName)
    {
        const FString N = InName.ToLower();
        if (N == TEXT("right"))  return EKeys::RightMouseButton;
        if (N == TEXT("middle")) return EKeys::MiddleMouseButton;
        return EKeys::LeftMouseButton;
    }

    /** Move the OS/Slate cursor to a viewport-relative pixel and report where. */
    bool MoveCursorToViewportPixel(UGameViewportClient* Client, const FVector2D& Px, FVector2D& OutAbsolute)
    {
        if (!Client || !Client->Viewport) return false;
        if (!FSlateApplication::IsInitialized()) return false;

        // Viewport pixels are relative to the game window; Slate wants absolute
        // desktop coordinates, so offset by the window position.
        FVector2D Origin = FVector2D::ZeroVector;
        if (TSharedPtr<SWindow> Win = Client->GetWindow())
        {
            Origin = Win->GetPositionInScreen();
        }
        OutAbsolute = Origin + Px;
        FSlateApplication::Get().SetCursorPos(OutAbsolute);
        return true;
    }

    void SendMouseButton(UGameViewportClient* Client, const FKey& Button, EInputEvent Evt)
    {
        if (!Client || !Client->Viewport) return;
        const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();
        FInputKeyEventArgs Args(Client->Viewport, DeviceId, Button, Evt,
                                /*AmountDepressed=*/1.0f, /*bIsTouch=*/false, /*EventTimestamp=*/0u);
        Client->InputKey(Args);
    }

    /** Depth-first walk of the live Slate tree under a window. */
    void CollectSlateWidgets(const TSharedRef<SWidget>& W, int32 Depth,
                             TArray<TSharedPtr<FJsonValue>>& Out, int32 MaxDepth)
    {
        if (Depth > MaxDepth) return;

        const FGeometry& G = W->GetTickSpaceGeometry();
        const FVector2D Pos  = FVector2D(G.GetAbsolutePosition());
        const FVector2D Size = FVector2D(G.GetLocalSize()) * G.Scale;

        // Zero-size widgets are layout scaffolding, not things to click.
        if (Size.X > 0.5 && Size.Y > 0.5)
        {
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            E->SetStringField(TEXT("type"), W->GetTypeAsString());
            E->SetStringField(TEXT("tag"), W->GetTag().ToString());
            E->SetNumberField(TEXT("x"), Pos.X);
            E->SetNumberField(TEXT("y"), Pos.Y);
            E->SetNumberField(TEXT("width"), Size.X);
            E->SetNumberField(TEXT("height"), Size.Y);
            E->SetNumberField(TEXT("center_x"), Pos.X + Size.X * 0.5);
            E->SetNumberField(TEXT("center_y"), Pos.Y + Size.Y * 0.5);
            E->SetNumberField(TEXT("depth"), Depth);
            E->SetBoolField(TEXT("enabled"), W->IsEnabled());
            E->SetBoolField(TEXT("interactive"), W->IsInteractable());
            const FText Tip = W->GetAccessibleText();
            if (!Tip.IsEmpty()) E->SetStringField(TEXT("text"), Tip.ToString());
            Out.Add(MakeShared<FJsonValueObject>(E));
        }

        FChildren* Children = W->GetChildren();
        if (!Children) return;
        for (int32 i = 0; i < Children->Num(); ++i)
        {
            CollectSlateWidgets(Children->GetChildAt(i), Depth + 1, Out, MaxDepth);
        }
    }
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEMouse(const TSharedPtr<FJsonObject>& P)
{
    UGameViewportClient* Client = PIEViewportClient();
    if (!Client) return FHaybaHandlerResult::Err(TEXT("no PIE viewport (start PIE first)"));
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse: missing params"));

    FString Action = TEXT("click");
    P->TryGetStringField(TEXT("action"), Action);
    Action = Action.ToLower();

    double X = 0.0, Y = 0.0;
    const bool bHasX = P->TryGetNumberField(TEXT("x"), X);
    const bool bHasY = P->TryGetNumberField(TEXT("y"), Y);

    FString ButtonName = TEXT("left");
    P->TryGetStringField(TEXT("button"), ButtonName);
    const FKey Button = MouseButtonFromString(ButtonName);

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("action"), Action);

    if (Action == TEXT("move") || Action == TEXT("click") || Action == TEXT("double_click") ||
        Action == TEXT("press") || Action == TEXT("release") || Action == TEXT("drag"))
    {
        if (!bHasX || !bHasY)
            return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse: x and y are required for this action"));

        FVector2D Abs;
        if (!MoveCursorToViewportPixel(Client, FVector2D(X, Y), Abs))
            return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse: could not position the cursor"));
        R->SetNumberField(TEXT("x"), X);
        R->SetNumberField(TEXT("y"), Y);
    }

    if (Action == TEXT("move"))
    {
        // Position only.
    }
    else if (Action == TEXT("press"))
    {
        SendMouseButton(Client, Button, IE_Pressed);
    }
    else if (Action == TEXT("release"))
    {
        SendMouseButton(Client, Button, IE_Released);
    }
    else if (Action == TEXT("click"))
    {
        SendMouseButton(Client, Button, IE_Pressed);
        SendMouseButton(Client, Button, IE_Released);
    }
    else if (Action == TEXT("double_click"))
    {
        SendMouseButton(Client, Button, IE_Pressed);
        SendMouseButton(Client, Button, IE_Released);
        SendMouseButton(Client, Button, IE_DoubleClick);
        SendMouseButton(Client, Button, IE_Released);
    }
    else if (Action == TEXT("drag"))
    {
        double ToX = 0.0, ToY = 0.0;
        if (!P->TryGetNumberField(TEXT("to_x"), ToX) || !P->TryGetNumberField(TEXT("to_y"), ToY))
            return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse drag: to_x and to_y are required"));

        SendMouseButton(Client, Button, IE_Pressed);

        // Intermediate positions matter: a drag that jumps straight to the
        // destination is often ignored by widgets that track deltas.
        const int32 Steps = 8;
        FVector2D Abs;
        for (int32 i = 1; i <= Steps; ++i)
        {
            const double T = (double)i / (double)Steps;
            MoveCursorToViewportPixel(Client, FVector2D(FMath::Lerp(X, ToX, T), FMath::Lerp(Y, ToY, T)), Abs);
        }
        SendMouseButton(Client, Button, IE_Released);
        R->SetNumberField(TEXT("to_x"), ToX);
        R->SetNumberField(TEXT("to_y"), ToY);
    }
    else if (Action == TEXT("scroll"))
    {
        double Delta = 1.0;
        P->TryGetNumberField(TEXT("delta"), Delta);
        const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();
        FInputKeyEventArgs Args(Client->Viewport, DeviceId, EKeys::MouseWheelAxis, IE_Axis,
                                (float)Delta, /*bIsTouch=*/false, /*EventTimestamp=*/0u);
        Client->InputKey(Args);
        R->SetNumberField(TEXT("delta"), Delta);
    }
    else
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_mouse: unknown action '%s' (move, click, double_click, press, release, drag, scroll)"),
            *Action));
    }

    R->SetStringField(TEXT("button"), ButtonName);
    R->SetBoolField(TEXT("dispatched"), true);
    return FHaybaHandlerResult::Ok(R);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIETypeText(const TSharedPtr<FJsonObject>& P)
{
    UGameViewportClient* Client = PIEViewportClient();
    if (!Client) return FHaybaHandlerResult::Err(TEXT("no PIE viewport (start PIE first)"));

    FString Text;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("text"), Text))
        return FHaybaHandlerResult::Err(TEXT("editor_pie_type_text: text is required"));

    // Character events, not key events: a text field wants the character that
    // was produced, which is not recoverable from a keycode alone once shift,
    // layout and IME are involved.
    const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();
    int32 Sent = 0;
    for (const TCHAR C : Text)
    {
        Client->InputChar(Client->Viewport, DeviceId.GetId(), C);
        ++Sent;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("text"), Text);
    R->SetNumberField(TEXT("characters_sent"), Sent);
    R->SetStringField(TEXT("note"), TEXT("Characters go to whatever currently has keyboard focus. ")
                                    TEXT("Click the field first if focus is not already there."));
    return FHaybaHandlerResult::Ok(R);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEAxis(const TSharedPtr<FJsonObject>& P)
{
    UGameViewportClient* Client = PIEViewportClient();
    if (!Client) return FHaybaHandlerResult::Err(TEXT("no PIE viewport (start PIE first)"));

    FString KeyName;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("key"), KeyName) || KeyName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_axis: key is required (e.g. Gamepad_LeftX, MouseX)"));

    const FKey Key(*KeyName);
    if (!Key.IsValid())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_axis: invalid key '%s'"), *KeyName));
    if (!Key.IsAxis1D() && !Key.IsAxis2D() && !Key.IsAxis3D())
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_axis: '%s' is not an axis key — use editor_pie_press_key for buttons"), *KeyName));

    double Value = 0.0;
    P->TryGetNumberField(TEXT("value"), Value);

    const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();
    FInputKeyEventArgs Args(Client->Viewport, DeviceId, Key, IE_Axis,
                            (float)Value, /*bIsTouch=*/false, /*EventTimestamp=*/0u);
    Client->InputKey(Args);

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("key"), KeyName);
    R->SetNumberField(TEXT("value"), Value);
    R->SetStringField(TEXT("note"), TEXT("Axis input applies for the frame it is delivered. For sustained "
                                         "movement, send it again each step rather than expecting it to latch."));
    return FHaybaHandlerResult::Ok(R);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEWidgetTree(const TSharedPtr<FJsonObject>& P)
{
    UGameViewportClient* Client = PIEViewportClient();
    if (!Client) return FHaybaHandlerResult::Err(TEXT("no PIE viewport (start PIE first)"));
    if (!FSlateApplication::IsInitialized())
        return FHaybaHandlerResult::Err(TEXT("Slate is not initialized"));

    TSharedPtr<SWindow> Win = Client->GetWindow();
    if (!Win.IsValid()) return FHaybaHandlerResult::Err(TEXT("PIE window not found"));

    int32 MaxDepth = 40;
    if (P.IsValid()) P->TryGetNumberField(TEXT("max_depth"), MaxDepth);
    MaxDepth = FMath::Clamp(MaxDepth, 1, 200);

    FString Filter;
    if (P.IsValid()) P->TryGetStringField(TEXT("filter"), Filter);

    TArray<TSharedPtr<FJsonValue>> All;
    CollectSlateWidgets(Win.ToSharedRef(), 0, All, MaxDepth);

    TArray<TSharedPtr<FJsonValue>> Kept;
    for (const TSharedPtr<FJsonValue>& V : All)
    {
        if (Filter.IsEmpty()) { Kept.Add(V); continue; }
        const TSharedPtr<FJsonObject> O = V->AsObject();
        if (!O.IsValid()) continue;
        FString Type, Text, Tag;
        O->TryGetStringField(TEXT("type"), Type);
        O->TryGetStringField(TEXT("text"), Text);
        O->TryGetStringField(TEXT("tag"), Tag);
        if (Type.Contains(Filter) || Text.Contains(Filter) || Tag.Contains(Filter)) Kept.Add(V);
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetArrayField(TEXT("widgets"), Kept);
    R->SetNumberField(TEXT("count"), Kept.Num());
    R->SetNumberField(TEXT("total_before_filter"), All.Num());
    if (!Filter.IsEmpty()) R->SetStringField(TEXT("filter"), Filter);
    R->SetStringField(TEXT("note"), TEXT("Coordinates are absolute desktop pixels and are what "
                                         "editor_pie_mouse expects. center_x/center_y is the click point."));
    return FHaybaHandlerResult::Ok(R);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEClickWidget(const TSharedPtr<FJsonObject>& P)
{
    UGameViewportClient* Client = PIEViewportClient();
    if (!Client) return FHaybaHandlerResult::Err(TEXT("no PIE viewport (start PIE first)"));
    if (!FSlateApplication::IsInitialized())
        return FHaybaHandlerResult::Err(TEXT("Slate is not initialized"));

    FString Match;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("match"), Match) || Match.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_widget: match is required (widget text, tag or type)"));

    TSharedPtr<SWindow> Win = Client->GetWindow();
    if (!Win.IsValid()) return FHaybaHandlerResult::Err(TEXT("PIE window not found"));

    TArray<TSharedPtr<FJsonValue>> All;
    CollectSlateWidgets(Win.ToSharedRef(), 0, All, 60);

    // Prefer an interactive widget: matching a label is usually a request to
    // press the button containing it, not to click the text itself.
    TSharedPtr<FJsonObject> Best;
    TArray<FString> Candidates;
    for (const TSharedPtr<FJsonValue>& V : All)
    {
        const TSharedPtr<FJsonObject> O = V->AsObject();
        if (!O.IsValid()) continue;
        FString Type, Text, Tag;
        O->TryGetStringField(TEXT("type"), Type);
        O->TryGetStringField(TEXT("text"), Text);
        O->TryGetStringField(TEXT("tag"), Tag);
        if (!(Type.Contains(Match) || Text.Contains(Match) || Tag.Contains(Match))) continue;

        Candidates.Add(FString::Printf(TEXT("%s%s"), *Type, Text.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" \"%s\""), *Text)));
        bool bInteractive = false;
        O->TryGetBoolField(TEXT("interactive"), bInteractive);
        if (!Best.IsValid() || bInteractive)
        {
            bool bBestInteractive = false;
            if (Best.IsValid()) Best->TryGetBoolField(TEXT("interactive"), bBestInteractive);
            if (!Best.IsValid() || (bInteractive && !bBestInteractive)) Best = O;
        }
    }

    if (!Best.IsValid())
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_click_widget: nothing on screen matches '%s'. ")
            TEXT("Call editor_pie_widget_tree to see what is actually there."), *Match));
    }

    double CX = 0.0, CY = 0.0;
    Best->TryGetNumberField(TEXT("center_x"), CX);
    Best->TryGetNumberField(TEXT("center_y"), CY);

    // center_x/center_y are already absolute desktop coordinates.
    FSlateApplication::Get().SetCursorPos(FVector2D(CX, CY));
    SendMouseButton(Client, EKeys::LeftMouseButton, IE_Pressed);
    SendMouseButton(Client, EKeys::LeftMouseButton, IE_Released);

    FString Type, Text;
    Best->TryGetStringField(TEXT("type"), Type);
    Best->TryGetStringField(TEXT("text"), Text);

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("match"), Match);
    R->SetStringField(TEXT("clicked_type"), Type);
    if (!Text.IsEmpty()) R->SetStringField(TEXT("clicked_text"), Text);
    R->SetNumberField(TEXT("x"), CX);
    R->SetNumberField(TEXT("y"), CY);
    R->SetNumberField(TEXT("candidates"), Candidates.Num());
    if (Candidates.Num() > 1)
    {
        // Say when the choice was ambiguous rather than silently picking one.
        R->SetStringField(TEXT("note"), FString::Printf(
            TEXT("%d widgets matched; clicked the interactive one. Use editor_pie_widget_tree and "
                 "editor_pie_mouse with explicit coordinates if that was the wrong choice."), Candidates.Num()));
    }
    return FHaybaHandlerResult::Ok(R);
}


#else  // !WITH_EDITOR

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEMouse(const TSharedPtr<FJsonObject>&)      { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIETypeText(const TSharedPtr<FJsonObject>&)   { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEAxis(const TSharedPtr<FJsonObject>&)       { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEWidgetTree(const TSharedPtr<FJsonObject>&) { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEClickWidget(const TSharedPtr<FJsonObject>&){ return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEAssert(const TSharedPtr<FJsonObject>&)    { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEWaitFor(const TSharedPtr<FJsonObject>&)   { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEPressKey(const TSharedPtr<FJsonObject>&)  { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEScreenshot(const TSharedPtr<FJsonObject>&){ return FHaybaHandlerResult::Err(TEXT("editor-only")); }

#endif  // WITH_EDITOR
