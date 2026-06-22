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
    const double Deadline  = StartTime + (double)TimeoutMs / 1000.0;

    int32 Frame = 0;
    TSharedPtr<FJsonValue> LastObserved;
    FString LastErr;

    while (FPlatformTime::Seconds() < Deadline)
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

        // Pump ticker + sleep.
        FTSTicker::GetCoreTicker().Tick(0.005f);
        FPlatformProcess::Sleep(0.005f);
        ++Frame;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetBoolField(TEXT("matched"), false);
    R->SetNumberField(TEXT("frames"), Frame);
    R->SetStringField(TEXT("reason"), LastErr.IsEmpty() ? TEXT("timeout") : LastErr);
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
    auto Send = [&](EInputEvent Evt)
    {
        FInputKeyEventArgs Args(VP, DeviceId, Key, Evt,
                                /*AmountDepressed=*/1.0f,
                                /*bIsTouch=*/false,
                                /*EventTimestamp=*/0u);
        GVC->InputKey(Args);
    };

    if (EventStr == TEXT("pressed"))
    {
        Send(IE_Pressed);
    }
    else if (EventStr == TEXT("released"))
    {
        Send(IE_Released);
    }
    else // pressed_and_released
    {
        Send(IE_Pressed);
        // Pump ticker briefly so the world sees the keydown.
        const double End = FPlatformTime::Seconds() + (double)HeldMs / 1000.0;
        while (FPlatformTime::Seconds() < End)
        {
            FTSTicker::GetCoreTicker().Tick(0.005f);
            FPlatformProcess::Sleep(0.005f);
        }
        Send(IE_Released);
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("key"), KeyName);
    R->SetStringField(TEXT("event"), EventStr);
    R->SetBoolField(TEXT("dispatched"), true);
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

    // TODO(ue5.7): wire FScreenshotRequest::OnScreenshotCaptured() to capture
    // the FColor buffer directly (currently waits on file write).
    FScreenshotRequest::RequestScreenshot(Filename, /*bShowUI=*/false, /*bAddFilenameSuffix=*/false);

    // Pump ticker until the file appears or 3s elapses.
    const double Deadline = FPlatformTime::Seconds() + 3.0;
    while (FPlatformTime::Seconds() < Deadline)
    {
        FTSTicker::GetCoreTicker().Tick(0.005f);
        FPlatformProcess::Sleep(0.01f);
        if (FPaths::FileExists(Filename)) break;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("filename"), Filename);
    R->SetBoolField(TEXT("captured"), FPaths::FileExists(Filename));
    return FHaybaHandlerResult::Ok(R);
}

#else  // !WITH_EDITOR

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEAssert(const TSharedPtr<FJsonObject>&)    { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEWaitFor(const TSharedPtr<FJsonObject>&)   { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEPressKey(const TSharedPtr<FJsonObject>&)  { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEScreenshot(const TSharedPtr<FJsonObject>&){ return FHaybaHandlerResult::Err(TEXT("editor-only")); }

#endif  // WITH_EDITOR
