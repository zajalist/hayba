#include "HaybaMCPPIEHandler.h"
#include "HaybaSceneQuery.h"
#include "HaybaPIERuntimeOps.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

#if WITH_EDITOR
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/World.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Engine/LocalPlayer.h"
#include "UnrealClient.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "GameFramework/HUD.h"
#include "GameFramework/PlayerController.h"
#include "Components/ActorComponent.h"
#include "Components/SceneComponent.h"
#include "Components/PrimitiveComponent.h"
#include "UObject/UnrealType.h"
#include "UObject/Class.h"
#include "UObject/Object.h"
#include "Containers/Ticker.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Application/SlateUser.h"
#include "Widgets/SWindow.h"
#include "Widgets/SWidget.h"
#include "Widgets/SViewport.h"
#include "Slate/SceneViewport.h"
#include "Layout/WidgetPath.h"
#include "Widgets/Input/SEditableText.h"
#include "Widgets/Text/SMultiLineEditableText.h"
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
#include "HaybaMCPParams.h"
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
        TEXT("editor_pie_set_text"),
        TEXT("editor_pie_actor_list"),
        TEXT("editor_pie_actor_inspect"),
        TEXT("editor_pie_project_world"),
        TEXT("editor_pie_click_actor"),
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
    if (Cmd == TEXT("editor_pie_mouse"))         return PIEMouse(Params);
    if (Cmd == TEXT("editor_pie_type_text"))     return PIETypeText(Params);
    if (Cmd == TEXT("editor_pie_axis"))          return PIEAxis(Params);
    if (Cmd == TEXT("editor_pie_widget_tree"))   return PIEWidgetTree(Params);
    if (Cmd == TEXT("editor_pie_click_widget"))  return PIEClickWidget(Params);
    if (Cmd == TEXT("editor_pie_set_text"))      return PIESetText(Params);
    if (Cmd == TEXT("editor_pie_actor_list"))    return PIEActorList(Params);
    if (Cmd == TEXT("editor_pie_actor_inspect")) return PIEActorInspect(Params);
    if (Cmd == TEXT("editor_pie_project_world")) return PIEProjectWorld(Params);
    if (Cmd == TEXT("editor_pie_click_actor"))   return PIEClickActor(Params);
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
        const HaybaSceneQuery::FActorLookup Hit = HaybaSceneQuery::FindActor(World, Label);
        if (Hit.IsAmbiguous())
        {
            OutError = HaybaSceneQuery::AmbiguousError(TEXT("pie"), Label, Hit.Candidates);
            return nullptr;
        }
        if (Hit.Actor) return Hit.Actor;
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

// Defined with the other input helpers in the Interaction section below, which
// sits after this function. Same anonymous namespace, declared here so the key
// path can use them — mirrors the existing SendMouseMove forward declaration.
namespace
{
    FString FocusedWidgetType();
    bool SendKeyThroughSlate(const FKey& Key, EInputEvent Evt);
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
    // Shared, not captured by reference: SendNow is also stored on a ticker
    // delegate for the deferred release, and a reference to a local here would
    // dangle by the time that fires — the same use-after-free class this
    // function's viewport handling already had to fix.
    TSharedRef<bool> SlateHandled = MakeShared<bool>(false);

    auto SendNow = [DeviceId, Key, SlateHandled](EInputEvent Evt) -> bool
    {
        UWorld* W = GetPIEWorld();
        if (!W) return false;
        UGameViewportClient* Client = W->GetGameViewport();
        if (!Client || !Client->Viewport) return false;

        // Slate first, for the same reason SendMouseButton goes through Slate:
        // a focused UMG widget must see the key before the game does, which is
        // the order real platform input arrives in. Only when the UI declines
        // does this fall through to the game pipeline, so gameplay bindings
        // behave exactly as they did before.
        if (SendKeyThroughSlate(Key, Evt))
        {
            *SlateHandled = true;
            return true;
        }

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
    // Where the key was routed. "dispatched" only ever meant "we sent it"; when
    // a key appears to do nothing, the focused widget is the thing that
    // explains it.
    const FString FocusedType = FocusedWidgetType();
    if (FocusedType.IsEmpty()) R->SetField(TEXT("focused_widget"), MakeShared<FJsonValueNull>());
    else                       R->SetStringField(TEXT("focused_widget"), FocusedType);
    // Whether the UI consumed the press. False is not a failure — gameplay keys
    // are SUPPOSED to fall through to the game — but when a key aimed at a
    // widget appears to do nothing, this is the field that says why.
    R->SetBoolField(TEXT("handled_by_ui"), *SlateHandled);
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
    // `path` accepted as an alias: the object_* tools call the same idea
    // `path`, and callers reach for it. Silently ignoring it is how the field
    // ended up polling a file that was never going to be the one checked.
    if (Filename.IsEmpty() && P.IsValid()) P->TryGetStringField(TEXT("path"), Filename);

    // `check_only` reports whether a previously requested file has landed, so a
    // caller can poll without issuing another capture.
    bool bCheckOnly = false;
    if (P.IsValid()) P->TryGetBoolField(TEXT("check_only"), bCheckOnly);

    if (bCheckOnly)
    {
        // check_only asks about a PREVIOUS capture, so minting a fresh
        // timestamped default here is never right: the field repro polled with
        // the exact filename the capture call returned, an upper layer dropped
        // the param, and this branch invented a brand-new name that could not
        // exist — {captured:false} forever, for a file already on disk. No
        // filename means there is nothing to check; say so instead.
        if (Filename.IsEmpty())
        {
            return FHaybaHandlerResult::Err(
                TEXT("editor_pie_screenshot: check_only:true requires 'filename' — pass the exact filename ")
                TEXT("the capture call returned. Without it there is no file to check, and inventing a new ")
                TEXT("timestamped name would report captured:false forever."));
        }
        TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
        R->SetStringField(TEXT("filename"), Filename);
        R->SetBoolField(TEXT("captured"), FPaths::FileExists(Filename));
        // `requested:false` here means "this call did not ask for a new
        // capture" — it is a statement about THIS call, not about the earlier
        // one. Read as "your request was dropped" it sends a caller into
        // re-requesting instead of looking on disk, which is exactly what
        // happened in the field. Say which it is.
        R->SetBoolField(TEXT("requested"), false);
        R->SetStringField(TEXT("requested_meaning"),
            TEXT("false because check_only does not issue a capture. It says nothing about the earlier request; "
                 "'captured' is the answer to whether the file exists."));
        return FHaybaHandlerResult::Ok(R);
    }

    if (Filename.IsEmpty())
    {
        Filename = FPaths::ProjectSavedDir() / TEXT("Screenshots") /
                   FString::Printf(TEXT("HaybaPIE_%s.png"),
                                   *FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S")));
    }

    // Default to INCLUDING the UI: a PIE screenshot is almost always taken to see the
    // UMG/HUD, and bShowUI=false yields a black frame for UI-only screens. Callers can
    // pass show_ui:false for a scene-only capture.
    bool bShowUI = true;
    if (P.IsValid()) P->TryGetBoolField(TEXT("show_ui"), bShowUI);
    FScreenshotRequest::RequestScreenshot(Filename, bShowUI, /*bAddFilenameSuffix=*/false);

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

    // Name what is being photographed.
    //
    // FScreenshotRequest is GLOBAL: it captures whatever viewport the engine
    // renders next, not a viewport this command chose. With a stale standalone
    // PIE window left open beside a docked session, that was the DEAD window —
    // and the capture came back as a plausible, correctly-rendered picture of
    // the game that simply never changed. editor_pie_widget_tree meanwhile read
    // the live session, so the two disagreed and the obvious reading was "the
    // widget is laid out but paints nothing", which is a real UMG bug and a
    // long detour. A verification tool that cannot say WHAT it photographed is
    // unfalsifiable.
    R->SetStringField(TEXT("world_name"), World->GetName());
    if (UGameViewportClient* ShotGVC = World->GetGameViewport())
    {
        if (FViewport* ShotVP = ShotGVC->Viewport)
        {
            const FIntPoint Size = ShotVP->GetSizeXY();
            R->SetStringField(TEXT("viewport_size"), FString::Printf(TEXT("%dx%d"), Size.X, Size.Y));
        }
    }

    // More than one live PIE world is the condition under which the global
    // request can pick the wrong one. Say so rather than let the caller find out
    // by disbelieving a screenshot.
    int32 PieWorldCount = 0;
    for (const FWorldContext& Ctx : GEngine->GetWorldContexts())
    {
        if (Ctx.WorldType == EWorldType::PIE && Ctx.World()) ++PieWorldCount;
    }
    R->SetNumberField(TEXT("pie_world_count"), PieWorldCount);
    if (PieWorldCount > 1)
    {
        R->SetStringField(TEXT("ambiguous_target_warning"),
            FString::Printf(
                TEXT("%d live PIE worlds. This capture is a global screenshot request, so it may photograph a "
                     "window other than '%s' — including a stale standalone window left from an earlier session, "
                     "which renders a convincing frame that never changes. Cross-check against "
                     "editor_pie_widget_tree before trusting the image, or stop the extra session."),
                PieWorldCount, *World->GetName()));
    }
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

    FVector2D SendPointerMoveTo(const FVector2D& AbsTo);
    void SendHoverRefresh();

    /** The game window's top-left in desktop space, or the origin if there is
     *  no window. Read at point of use — a PIE window can be moved. */
    FVector2D WindowOriginOf(UGameViewportClient* Client)
    {
        if (Client)
        {
            if (TSharedPtr<SWindow> Win = Client->GetWindow())
            {
                // Copy-initialised, not FVector2D(...): Slate's deprecation
                // shim for FVector2D returns are only IMPLICITLY convertible.
                const FVector2D Origin = Win->GetPositionInScreen();
                return Origin;
            }
        }
        return FVector2D::ZeroVector;
    }

    /**
     * Move the OS/Slate cursor to a pixel and report where it ended up.
     *
     * `bViewportRelative` decides how the incoming pixel is read, and getting
     * this wrong is silent: the click still happens, just somewhere else.
     *
     * editor_pie_widget_tree reports ABSOLUTE desktop coordinates (that is what
     * FGeometry::GetAbsolutePosition returns), and its note has always told
     * callers to pass them straight to editor_pie_mouse. But this function used
     * to add the window origin unconditionally, so doing exactly that
     * double-counted it and every click landed offset by the window's screen
     * position — down and right by roughly the title bar and border. The
     * symptom is a click that "lands a few px below" the thing you aimed at, or
     * misses the UI entirely and focuses the SViewport.
     */
    bool MoveCursorToPixel(UGameViewportClient* Client, const FVector2D& Px, bool bViewportRelative,
                           FVector2D& OutAbsolute, FVector2D* OutCursorDelta = nullptr)
    {
        if (!Client || !Client->Viewport) return false;
        if (!FSlateApplication::IsInitialized()) return false;

        // Origin is always READ, never always applied: HaybaPieCoords::ToAbsolute
        // decides. Keeping the decision in one testable function is the point —
        // this is the line that produced a 24px error for months.
        const FVector2D Origin = WindowOriginOf(Client);
        OutAbsolute = HaybaPieCoords::ToAbsolute(Px, Origin, bViewportRelative);
        const FVector2D Delta = SendPointerMoveTo(OutAbsolute);
        if (OutCursorDelta) *OutCursorDelta = Delta;
        return true;
    }

    /** Deliver a mouse button through Slate's hit-testing.
     *
     *  This is the difference between a click that works and one that appears to
     *  do nothing. UGameViewportClient::InputKey feeds the GAME input pipeline —
     *  player controller, Enhanced Input — and never consults the Slate widget
     *  tree. A UMG button therefore never sees it: the cursor lands on exactly
     *  the right pixel, and the press goes down a pipe the button is not
     *  listening to.
     *
     *  FSlateApplication routes by cursor position, so it hit-tests the widget
     *  under the pointer AND forwards anything the UI does not consume down to
     *  the game viewport. One path serves both UI and gameplay input, in the
     *  order a real click would. */
    void SendMouseButton(UGameViewportClient* Client, const FKey& Button, EInputEvent Evt)
    {
        // Slate routes by cursor position, not through the viewport, but the
        // viewport still gates WHETHER we should be injecting at all: without a
        // live PIE viewport a click would land on the editor's own UI.
        if (!Client || !Client->Viewport) return;
        if (!FSlateApplication::IsInitialized()) return;
        FSlateApplication& Slate = FSlateApplication::Get();

        const FVector2D Pos = Slate.GetCursorPos();
        const FVector2D LastPos = Slate.GetLastCursorPos();

        // The button set is a POST-state snapshot, exactly as
        // FSlateApplication::OnMouseDown / OnMouseUp build it: down includes the
        // button being pressed, up excludes the one being released. This is not
        // cosmetic. Anything that drag-scrolls reads it off the *move* events
        // that follow — SScrollBox::OnMouseMove gates its right-click drag
        // scrolling on MouseEvent.IsMouseButtonDown(EKeys::RightMouseButton) —
        // and those moves take their set from Slate's PressedMouseButtons, which
        // only ever gets populated because this event carries the right button.
        TSet<FKey> Pressed = Slate.GetPressedMouseButtons();
        if (Evt == IE_Released) Pressed.Remove(Button);
        else                    Pressed.Add(Button);

        // Explicit user/pointer index rather than the 7-arg overload's implicit
        // 0: FSlateApplication only records PressedMouseButtons when the event's
        // user index matches CursorUserIndex, and only the cursor pointer index
        // participates in mouse capture.
        FPointerEvent MouseEvent(
            (uint32)Slate.GetUserIndexForMouse(),
            FSlateApplication::CursorPointerIndex,
            Pos, LastPos,
            Pressed,
            Button,
            /*WheelDelta=*/0.0f,
            Slate.GetModifierKeys());

        if (Evt == IE_Pressed)
        {
            // A widget that wants the rest of the gesture answers this with
            // FReply::Handled().CaptureMouse(AsShared()); FSlateApplication
            // installs the captor while processing the reply. That is how
            // SScrollBar::OnMouseMove's HasMouseCapture() gate gets satisfied —
            // we must not, and do not, set capture ourselves.
            Slate.ProcessMouseButtonDownEvent(nullptr, MouseEvent);
        }
        else if (Evt == IE_Released)
        {
            Slate.ProcessMouseButtonUpEvent(MouseEvent);
        }
        else if (Evt == IE_DoubleClick)
        {
            Slate.ProcessMouseButtonDoubleClickEvent(nullptr, MouseEvent);
        }
    }

    /**
     * Move the pointer to an absolute desktop pixel and tell Slate it moved.
     * Returns the cursor delta the event actually carried.
     *
     * THE ORDER OF THESE THREE LINES IS THE WHOLE FIX.
     *
     * FSlateApplication::SetCursorPos forwards to FSlateUser::SetPointerPosition,
     * which ends in:
     *
     *     void FSlateUser::UpdatePointerPosition(uint32 PointerIndex, const FVector2f& Position)
     *     {
     *         PointerPositionsByIndex.FindOrAdd(PointerIndex)         = Position;
     *         PreviousPointerPositionsByIndex.FindOrAdd(PointerIndex) = Position;
     *     }
     *
     * — it writes the SAME value to the current and the previous position. So
     * after a SetCursorPos, GetLastCursorPos() is the DESTINATION, not the
     * origin, and an FPointerEvent built from (GetCursorPos(), GetLastCursorPos())
     * has CursorDelta == (0,0). That is precisely what this harness did, on every
     * synthetic move it has ever sent.
     *
     * A zero delta is not a small move, it is no move at all. SScrollBar::OnMouseMove
     * returns Unhandled on it; SScrollBox's right-click drag scrolling adds 0.0 to
     * its accumulator and never crosses the drag trigger distance. Both of those
     * were measured dead in the field (Aphrosia docs/gauntlet/scroll-dossier.md,
     * 2026-08-02) and both were the harness, not the widget.
     *
     * So: read the origin BEFORE moving, move, then read back what Slate stored
     * (it truncates to whole pixels) and build the event from the real pair.
     */
    FVector2D SendPointerMoveTo(const FVector2D& AbsTo)
    {
        if (!FSlateApplication::IsInitialized()) return FVector2D::ZeroVector;
        FSlateApplication& Slate = FSlateApplication::Get();

        const FVector2D From = Slate.GetCursorPos();   // BEFORE the move.
        Slate.SetCursorPos(AbsTo);
        const FVector2D To = Slate.GetCursorPos();     // What Slate stored.

        // PressedButtons comes from Slate's own set, which our press populated,
        // so a move dispatched between a press and a release carries the held
        // button the way a real one does.
        FPointerEvent MoveEvent(
            (uint32)Slate.GetUserIndexForMouse(),
            FSlateApplication::CursorPointerIndex,
            To, From,
            Slate.GetPressedMouseButtons(),
            EKeys::Invalid,
            /*WheelDelta=*/0.0f,
            Slate.GetModifierKeys());

        Slate.ProcessMouseMoveEvent(MoveEvent);
        return To - From;
    }

    /** A deliberately ZERO-delta move at the current position.
     *
     *  Not a gesture: this exists to make Slate re-run its hit test so hover /
     *  MouseEnter / MouseLeave are recomputed after a release. Zero delta is
     *  correct here — nothing moved. Every place that means "the pointer
     *  travelled" must use SendPointerMoveTo instead. */
    void SendHoverRefresh()
    {
        if (!FSlateApplication::IsInitialized()) return;
        const FVector2D Here = FSlateApplication::Get().GetCursorPos();
        SendPointerMoveTo(Here);
    }

    /**
     * Deliver a mouse wheel notch through SLATE.
     *
     * This used to be UGameViewportClient::InputKey(MouseWheelAxis, IE_Axis),
     * which is the game input pipeline. FSlateApplication never saw it, so
     * SWidget::OnMouseWheel never fired and no ScrollBox, list view, combo box or
     * spin box could be scrolled by this harness at all. A positive control
     * proved it reached nothing whatsoever: with no UI open, action:"scroll" over
     * the map left the camera bit-identical while a MouseScrollUp key press moved
     * it.
     *
     * Constructed to match FSlateApplication::OnMouseWheel(Delta, CursorPos)
     * field for field, and dispatched through the same public entry point Slate
     * uses for a real wheel, so the event bubbles from the leafmost widget under
     * the cursor outward — nested scrollboxes included, inner one first.
     *
     * This also serves gameplay: whatever the UI declines reaches SViewport,
     * whose FSceneViewport::OnMouseWheel raises MouseScrollUp/MouseScrollDown and
     * the MouseWheelAxis on the viewport client. One path, both consumers, in the
     * order a real wheel would hit them.
     */
    bool SendMouseWheel(float Delta)
    {
        if (!FSlateApplication::IsInitialized()) return false;
        FSlateApplication& Slate = FSlateApplication::Get();

        const FVector2D Pos = Slate.GetCursorPos();
        FPointerEvent WheelEvent(
            (uint32)Slate.GetUserIndexForMouse(),
            FSlateApplication::CursorPointerIndex,
            Pos, Pos,
            Slate.GetPressedMouseButtons(),
            EKeys::Invalid,
            Delta,
            Slate.GetModifierKeys());

        return Slate.ProcessMouseWheelOrGestureEvent(WheelEvent, nullptr);
    }

    /** The widget currently holding pointer capture, as a type name. Empty when
     *  nothing does — which is the answer to "why did my drag do nothing", so it
     *  belongs in the response rather than in a log nobody reads. */
    FString PointerCaptorType()
    {
        if (!FSlateApplication::IsInitialized()) return FString();
        TSharedPtr<FSlateUser> User = FSlateApplication::Get().GetCursorUser();
        if (!User.IsValid()) return FString();
        TSharedPtr<SWidget> Captor = User->GetCursorCaptor();
        return Captor.IsValid() ? Captor->GetTypeAsString() : FString();
    }

    /** Slate's currently-held mouse buttons, as JSON. */
    TArray<TSharedPtr<FJsonValue>> PressedButtonsJson()
    {
        TArray<TSharedPtr<FJsonValue>> Out;
        if (!FSlateApplication::IsInitialized()) return Out;
        for (const FKey& K : FSlateApplication::Get().GetPressedMouseButtons())
        {
            Out.Add(MakeShared<FJsonValueString>(K.ToString()));
        }
        return Out;
    }

    /** Put Slate's synthetic-pointer state back to neutral after a release.
     *
     *  Field failure (UE 5.8): press at A, move to B outside the widget,
     *  release at B — after that sequence synthetic moves stopped updating
     *  hover (OnHovered never fired again, focus read back "SWindow") until
     *  PIE restarted, while REAL mouse input kept working. The synthetic
     *  stream has no OS-level counterpart cleaning up after it: a widget (or
     *  the game viewport in CaptureDuringMouseDown mode) still holding Slate
     *  mouse capture after our release keeps every later synthetic move routed
     *  to itself, so nothing else ever sees MouseEnter/MouseLeave again.
     *
     *  Two defensive steps, both no-ops in the healthy case:
     *    1. if ANY captor survives the release, drop it — after a completed
     *       press+release pair no UI widget legitimately holds pointer capture;
     *    2. send one synthetic move at the current position so hover state is
     *       recomputed from a fresh hit-test rather than left stale.
     *
     *  Returns whether a stale captor was actually cleared, so callers can
     *  surface it — a click that needed this is a click whose release went
     *  somewhere surprising, and that is worth seeing in the response.
     *
     *  Residual risk, documented rather than hidden: a game viewport in
     *  CapturePermanently mode loses its capture here too and re-acquires on
     *  the next click into the world. That trade is taken deliberately — these
     *  tools drive UI, and a dead hover pipeline until PIE restart is worse
     *  than a mouse-look game needing one extra click. */
    bool ResetPointerStateAfterRelease()
    {
        if (!FSlateApplication::IsInitialized()) return false;
        FSlateApplication& Slate = FSlateApplication::Get();
        bool bClearedCapture = false;
        if (Slate.HasAnyMouseCaptor())
        {
            Slate.ReleaseAllPointerCapture();
            bClearedCapture = true;
        }
        SendHoverRefresh();
        return bClearedCapture;
    }

    /** The widget Slate will deliver keyboard input to, as a type name.
     *  Empty when nothing holds focus — which is itself the answer to "why did
     *  my text go nowhere". */
    FString FocusedWidgetType()
    {
        if (!FSlateApplication::IsInitialized()) return FString();
        TSharedPtr<SWidget> Focused = FSlateApplication::Get().GetKeyboardFocusedWidget();
        return Focused.IsValid() ? Focused->GetTypeAsString() : FString();
    }

    /** Deliver a key through Slate, and report whether the UI consumed it.
     *
     *  Exactly the distinction SendMouseButton documents, on the keyboard path:
     *  UGameViewportClient::InputKey feeds the GAME input pipeline — player
     *  controller, Enhanced Input — and never consults the Slate widget tree.
     *  A focused UMG text box therefore never sees it. Real platform input goes
     *  to the focused widget FIRST and only falls through to the viewport when
     *  the UI does not consume it.
     *
     *  Returns true when Slate handled the event, so the caller can fall back
     *  to the viewport and leave gameplay bindings (WASD, action keys) behaving
     *  exactly as they did before. */
    bool SendKeyThroughSlate(const FKey& Key, EInputEvent Evt)
    {
        if (!FSlateApplication::IsInitialized()) return false;
        FSlateApplication& Slate = FSlateApplication::Get();
        const uint32 UserIndex = Slate.GetUserIndexForKeyboard();

        FKeyEvent KeyEvent(
            Key,
            FSlateApplication::Get().GetModifierKeys(),
            UserIndex,
            /*bIsRepeat=*/false,
            /*CharacterCode=*/0,
            /*KeyCode=*/0);

        if (Evt == IE_Released) return Slate.ProcessKeyUpEvent(KeyEvent);

        const bool bHandled = Slate.ProcessKeyDownEvent(KeyEvent);

        // Slate's text layout keys backspace and submit off the CHARACTER event,
        // not the key event — FSlateEditableTextLayout tests for '\b' and '\r'.
        // The platform sends both a key-down and a character for these, so a
        // synthetic press that sends only the key-down looks like it worked and
        // deletes nothing. Mirroring the platform is what makes
        // editor_pie_press_key "BackSpace" actually erase a character.
        //
        // Deliberately only these two. Tab already works through OnKeyDown as a
        // focus change, and also sending '\t' would insert a tab into whatever
        // text box it just moved to.
        TCHAR Companion = 0;
        if (Key == EKeys::BackSpace)                                  Companion = TEXT('\b');
        else if (Key == EKeys::Enter)                                 Companion = TEXT('\r');

        if (Companion != 0)
        {
            FCharacterEvent CharEvent(
                Companion,
                Slate.GetModifierKeys(),
                UserIndex,
                /*bIsRepeat=*/false);
            return Slate.ProcessKeyCharEvent(CharEvent) || bHandled;
        }

        return bHandled;
    }

    /** Deliver one character through Slate's focused widget.
     *
     *  Slate text widgets insert on OnKeyChar, not OnKeyDown — the platform
     *  normally produces BOTH for a printable key, and only the character event
     *  carries what shift/layout/IME actually resolved to. Returns true when a
     *  widget consumed it. */
    bool SendCharThroughSlate(TCHAR C)
    {
        if (!FSlateApplication::IsInitialized()) return false;
        FSlateApplication& Slate = FSlateApplication::Get();
        FCharacterEvent CharEvent(
            C,
            Slate.GetModifierKeys(),
            Slate.GetUserIndexForKeyboard(),
            /*bIsRepeat=*/false);
        return Slate.ProcessKeyCharEvent(CharEvent);
    }

    // Defined below; the editable-text lookups sit above it and need it.
    FString CollectDescendantText(const TSharedRef<SWidget>& W, int32 Depth);

    /** The first editable-text widget at or beneath `W`, depth-first.
     *
     *  SEditableTextBox is a wrapper: the widget that actually holds the text
     *  is a child. Setting text on the box does nothing, silently, which is
     *  exactly the class of failure these tools keep producing. */
    TSharedPtr<SWidget> FindEditableDescendant(const TSharedRef<SWidget>& W, int32 Depth = 0)
    {
        if (Depth > 8) return nullptr;
        const FString T = W->GetTypeAsString();
        // Match the leaf editors, not the Box wrappers around them.
        if ((T.Contains(TEXT("SEditableText")) || T.Contains(TEXT("SMultiLineEditableText")))
            && !T.Contains(TEXT("Box")))
        {
            return W;
        }
        FChildren* Children = W->GetChildren();
        if (!Children) return nullptr;
        for (int32 i = 0; i < Children->Num(); ++i)
        {
            if (TSharedPtr<SWidget> Found = FindEditableDescendant(Children->GetChildAt(i), Depth + 1))
            {
                return Found;
            }
        }
        return nullptr;
    }

    /** Find an editable text widget by the text visible on or near it.
     *
     *  Matches the field's own content INCLUDING its placeholder, because an
     *  empty login box is identified by the word "Username" that it is showing
     *  — that is how a person finds it, so it is how the tool should. */
    TSharedPtr<SWidget> FindEditableByText(const TSharedRef<SWidget>& Root, const FString& Match, int32 Depth = 0)
    {
        if (Depth > 60) return nullptr;
        const FString T = Root->GetTypeAsString();
        if (T.Contains(TEXT("EditableText")))
        {
            const FString Flat = CollectDescendantText(Root, 0);
            if (Flat.Contains(Match, ESearchCase::IgnoreCase))
            {
                if (TSharedPtr<SWidget> Leaf = FindEditableDescendant(Root)) return Leaf;
                return Root;
            }
        }
        FChildren* Children = Root->GetChildren();
        if (!Children) return nullptr;
        for (int32 i = 0; i < Children->Num(); ++i)
        {
            if (TSharedPtr<SWidget> Found = FindEditableByText(Children->GetChildAt(i), Match, Depth + 1))
            {
                return Found;
            }
        }
        return nullptr;
    }

    /** Text rendered anywhere beneath a widget, flattened.
     *
     *  Depth-limited: this is for identifying a control by its label, not for
     *  dumping a whole panel's contents into its parent's search text. */
    FString CollectDescendantText(const TSharedRef<SWidget>& W, int32 Depth)
    {
        if (Depth > 4) return FString();
        FString Out = W->GetAccessibleText().ToString();
        FChildren* Kids = W->GetChildren();
        if (Kids)
        {
            for (int32 i = 0; i < Kids->Num(); ++i)
            {
                const FString Child = CollectDescendantText(Kids->GetChildAt(i), Depth + 1);
                if (Child.IsEmpty()) continue;
                if (!Out.IsEmpty()) Out.AppendChar(TEXT(' '));
                Out.Append(Child);
            }
        }
        return Out.TrimStartAndEnd();
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
            // A button's label lives in a child STextBlock, so the button's own
            // accessible text is usually empty. Matching on that alone meant
            // "click the widget that says Start" could not find the button that
            // visibly says Start. Aggregate what the subtree renders instead.
            const FString OwnText = W->GetAccessibleText().ToString();
            const FString SubText = CollectDescendantText(W, 0);
            const FString Searchable = OwnText.IsEmpty() ? SubText : OwnText;
            if (!Searchable.IsEmpty()) E->SetStringField(TEXT("text"), Searchable);
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

    // Absolute by default, because that is what editor_pie_widget_tree reports
    // and what this command has always claimed to accept. Resolved once here so
    // the drag path below cannot disagree with the initial positioning — a drag
    // whose start and end were read in different spaces would travel a
    // completely wrong distance.
    FString Space = TEXT("absolute");
    P->TryGetStringField(TEXT("coordinate_space"), Space);
    const bool bViewportRelative = Space.Equals(TEXT("viewport"), ESearchCase::IgnoreCase);

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("action"), Action);

    // The cursor delta of the last move dispatched, and how many moves actually
    // carried one. These are the numbers that distinguish "the widget ignored my
    // drag" from "the harness never moved the pointer" — the confusion that cost
    // three rounds of false FAIL verdicts on a working ScrollBox.
    FVector2D LastDelta = FVector2D::ZeroVector;
    int32 MovesDelivered = 0;

    const bool bNeedsPosition =
        Action == TEXT("move") || Action == TEXT("click") || Action == TEXT("double_click") ||
        Action == TEXT("press") || Action == TEXT("release") || Action == TEXT("drag");

    // scroll takes x/y too now, and OPTIONALLY: a wheel is delivered to whatever
    // is under the cursor, so "scroll the panel" needs a way to say where the
    // cursor is. Without this the wheel went wherever the pointer happened to be
    // left by the previous call, which is not a thing a caller can reason about.
    if (bNeedsPosition || (Action == TEXT("scroll") && bHasX && bHasY))
    {
        if (bNeedsPosition && (!bHasX || !bHasY))
            return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse: x and y are required for this action"));

        FVector2D Abs;
        if (!MoveCursorToPixel(Client, FVector2D(X, Y), bViewportRelative, Abs, &LastDelta))
            return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse: could not position the cursor"));
        if (!LastDelta.IsNearlyZero()) ++MovesDelivered;
        R->SetNumberField(TEXT("x"), X);
        R->SetNumberField(TEXT("y"), Y);
        R->SetStringField(TEXT("coordinate_space"), bViewportRelative ? TEXT("viewport") : TEXT("absolute"));
        // Where the cursor actually went. When these differ from x/y the
        // coordinate space is not what the caller assumed, which is otherwise
        // invisible until the click does nothing.
        R->SetNumberField(TEXT("absolute_x"), Abs.X);
        R->SetNumberField(TEXT("absolute_y"), Abs.Y);
    }

    if (Action == TEXT("move"))
    {
        // Position only.
    }
    else if (Action == TEXT("press"))
    {
        // No pointer-state reset here: the caller is deliberately holding the
        // button, and any capture taken by the pressed widget must survive
        // until the matching release.
        SendMouseButton(Client, Button, IE_Pressed);
    }
    else if (Action == TEXT("release"))
    {
        SendMouseButton(Client, Button, IE_Released);
        R->SetBoolField(TEXT("capture_cleared"), ResetPointerStateAfterRelease());
    }
    else if (Action == TEXT("click"))
    {
        SendMouseButton(Client, Button, IE_Pressed);
        SendMouseButton(Client, Button, IE_Released);
        R->SetBoolField(TEXT("capture_cleared"), ResetPointerStateAfterRelease());
    }
    else if (Action == TEXT("double_click"))
    {
        SendMouseButton(Client, Button, IE_Pressed);
        SendMouseButton(Client, Button, IE_Released);
        SendMouseButton(Client, Button, IE_DoubleClick);
        SendMouseButton(Client, Button, IE_Released);
        R->SetBoolField(TEXT("capture_cleared"), ResetPointerStateAfterRelease());
    }
    else if (Action == TEXT("drag"))
    {
        double ToX = 0.0, ToY = 0.0;
        if (!P->TryGetNumberField(TEXT("to_x"), ToX) || !P->TryGetNumberField(TEXT("to_y"), ToY))
            return FHaybaHandlerResult::Err(TEXT("editor_pie_mouse drag: to_x and to_y are required"));

        SendMouseButton(Client, Button, IE_Pressed);
        // Whoever answered the press by taking capture. A drag against a widget
        // that took no capture cannot work, and saying so here is cheaper than
        // another round of measuring the widget.
        R->SetStringField(TEXT("captor_after_press"), PointerCaptorType());

        // Intermediate positions matter twice over. A widget that tracks deltas
        // ignores a single jump; and Slate's own drag detection
        // (FSlateUser::DetectDrag, FReply::DetectDrag) only fires once the
        // pointer has travelled GetDragTriggerDistance() ACROSS MOVE EVENTS.
        //
        // The path is planned rather than lerped inline so that no step is a
        // sub-pixel no-op: Slate truncates pointer positions to whole pixels, so
        // two waypoints less than a pixel apart produce CursorDelta == (0,0),
        // which SScrollBar::OnMouseMove treats as no movement at all. See
        // HaybaPieGesture::PlanDragPath, which is unit-tested.
        int32 Steps = 8;
        P->TryGetNumberField(TEXT("steps"), Steps);
        const TArray<FVector2D> Path = HaybaPieGesture::PlanDragPath(
            FVector2D(X, Y), FVector2D(ToX, ToY), Steps);

        FVector2D Abs;
        FVector2D TotalDelta = FVector2D::ZeroVector;
        for (const FVector2D& Waypoint : Path)
        {
            FVector2D StepDelta = FVector2D::ZeroVector;
            MoveCursorToPixel(Client, Waypoint, bViewportRelative, Abs, &StepDelta);
            if (!StepDelta.IsNearlyZero()) ++MovesDelivered;
            TotalDelta += StepDelta;
            LastDelta = StepDelta;
        }

        SendMouseButton(Client, Button, IE_Released);
        // The drag-release-outside sequence is the one that reproduced the
        // stale-hover state in the field (see ResetPointerStateAfterRelease).
        R->SetBoolField(TEXT("capture_cleared"), ResetPointerStateAfterRelease());
        R->SetNumberField(TEXT("to_x"), ToX);
        R->SetNumberField(TEXT("to_y"), ToY);
        R->SetNumberField(TEXT("steps_planned"), Path.Num());
        R->SetNumberField(TEXT("total_travel_x"), TotalDelta.X);
        R->SetNumberField(TEXT("total_travel_y"), TotalDelta.Y);
        if (Path.Num() == 0)
        {
            // Otherwise a zero-length drag reads as a gesture that was performed
            // and ignored, rather than one that was never performed.
            R->SetStringField(TEXT("warning"),
                TEXT("Start and end round to the same pixel, so NO move events were sent. "
                     "This is not a drag; widen the drag or check the coordinate space."));
        }
    }
    else if (Action == TEXT("scroll"))
    {
        double Delta = 1.0;
        P->TryGetNumberField(TEXT("delta"), Delta);

        // Through Slate, so SWidget::OnMouseWheel fires and bubbles. See
        // SendMouseWheel for why the old UGameViewportClient::InputKey path
        // reached no widget at all.
        const bool bSlateHandled = SendMouseWheel((float)Delta);

        // Fallback, not a duplicate: Slate returns false when nothing under the
        // cursor consumed the wheel, which includes the cursor not being over a
        // Slate window at all. In that case the game should still get its axis,
        // exactly as it did before this change. When Slate DOES handle it the
        // wheel already reached the viewport through SViewport, so sending this
        // too would double-apply it.
        bool bViewportFallback = false;
        if (!bSlateHandled && Client->Viewport)
        {
            const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();
            FInputKeyEventArgs Args(Client->Viewport, DeviceId, EKeys::MouseWheelAxis, IE_Axis,
                                    (float)Delta, /*bIsTouch=*/false, /*EventTimestamp=*/0u);
            Client->InputKey(Args);
            bViewportFallback = true;
        }

        R->SetNumberField(TEXT("delta"), Delta);
        R->SetBoolField(TEXT("handled_by_slate"), bSlateHandled);
        R->SetStringField(TEXT("handled_by"),
            bSlateHandled ? TEXT("slate") : (bViewportFallback ? TEXT("game_viewport") : TEXT("nothing")));
        if (!bSlateHandled)
        {
            R->SetStringField(TEXT("warning"),
                TEXT("No Slate widget under the cursor consumed the wheel. Position the cursor "
                     "over the target first (pass x/y, from editor_pie_widget_tree), and check "
                     "the target's ConsumeMouseWheel setting."));
        }
    }
    else
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_mouse: unknown action '%s' (move, click, double_click, press, release, drag, scroll)"),
            *Action));
    }

    if (Action != TEXT("scroll"))
    {
        // Captured AFTER the action dispatched — it used to be read before the
        // press/release ran, so for click it reported the PRE-click focus and
        // "did my click land" was answered with stale information.
        R->SetStringField(TEXT("focused_widget_after"), FocusedWidgetType());
    }

    // The two facts SScrollBar::OnMouseMove — and every other capture+delta
    // consumer — actually gates on. Reporting them turns "the widget didn't
    // respond" into a decidable question: a non-zero cursor_delta with a named
    // captor and no state change is the WIDGET's problem; a zero delta or an
    // empty captor is the HARNESS's. Both used to be invisible, which is how a
    // harness fault masqueraded as a product bug for three rounds.
    R->SetNumberField(TEXT("cursor_delta_x"), LastDelta.X);
    R->SetNumberField(TEXT("cursor_delta_y"), LastDelta.Y);
    R->SetNumberField(TEXT("moves_delivered"), MovesDelivered);
    {
        const FString Captor = PointerCaptorType();
        if (Captor.IsEmpty()) R->SetField(TEXT("mouse_captor"), MakeShared<FJsonValueNull>());
        else                  R->SetStringField(TEXT("mouse_captor"), Captor);
    }

    R->SetArrayField(TEXT("pressed_buttons"), PressedButtonsJson());
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
    //
    // Sent through Slate, NOT UGameViewportClient::InputChar. The viewport path
    // feeds the game input pipeline, which never consults the widget tree — a
    // focused SEditableText never sees a character delivered that way, which is
    // why this command used to report characters_sent and insert nothing. The
    // viewport remains the fallback for whatever the UI declines, so a game that
    // reads raw chars off the viewport still works.
    const FString FocusedBefore = FocusedWidgetType();
    const FInputDeviceId DeviceId = IPlatformInputDeviceMapper::Get().GetDefaultInputDevice();
    int32 Sent = 0;
    int32 Accepted = 0;
    for (const TCHAR C : Text)
    {
        if (SendCharThroughSlate(C))
        {
            ++Accepted;
        }
        else if (Client && Client->Viewport)
        {
            Client->InputChar(Client->Viewport, DeviceId.GetId(), C);
        }
        ++Sent;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("text"), Text);
    R->SetNumberField(TEXT("characters_sent"), Sent);
    // The number that actually answers "did the text land". characters_sent
    // only ever meant "we tried"; a caller reading it as success is exactly how
    // this bug went unnoticed.
    R->SetNumberField(TEXT("characters_accepted_by_ui"), Accepted);
    if (FocusedBefore.IsEmpty())
    {
        R->SetField(TEXT("focused_widget"), MakeShared<FJsonValueNull>());
    }
    else
    {
        R->SetStringField(TEXT("focused_widget"), FocusedBefore);
    }

    if (Accepted == 0)
    {
        R->SetStringField(TEXT("warning"),
            FocusedBefore.IsEmpty()
                ? TEXT("NOTHING HAS KEYBOARD FOCUS, so no UI widget accepted these characters. ")
                  TEXT("Click the field first (editor_pie_click_widget), then re-send. The characters ")
                  TEXT("were forwarded to the game viewport, which a text box does not read.")
                : TEXT("The focused widget accepted no characters — it is focused but not a text ")
                  TEXT("input, or it is read-only. Verify with a screenshot before treating this as done."));
    }
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
    R->SetStringField(TEXT("note"), TEXT("Coordinates are ABSOLUTE desktop pixels; center_x/center_y is the click point. "
                                         "Pass them to editor_pie_mouse unchanged (it defaults to coordinate_space:\"absolute\"). "
                                         "They will NOT match a screenshot, which is window-relative — the difference is the "
                                         "window's on-screen position, so never read a click target off a screenshot."));
    return FHaybaHandlerResult::Ok(R);
}

// ── editor_pie_set_text ─────────────────────────────────────────────────────
//
// Set an editable widget's text directly, instead of synthesising the
// keystrokes that would have produced it.
//
// editor_pie_type_text drives real character events, which is the honest way to
// test input handling — but it is a bad way to FILL A FORM. Character events go
// wherever focus happens to be, they can be eaten by a modal or a hotkey, and
// text entered that way is lost if focus moves before the widget commits.
// Filling a login box to reach the screen behind it does not need any of that
// fidelity; it needs the text to be in the box.
//
// This sets the value on the widget and commits it (ETextCommit::OnEnter), so
// the game's OnTextCommitted binding fires exactly as if the user had typed and
// pressed enter — which is what actually makes the value stick.

FHaybaHandlerResult FHaybaMCPPIEHandler::PIESetText(const TSharedPtr<FJsonObject>& P)
{
    UGameViewportClient* Client = PIEViewportClient();
    if (!Client) return FHaybaHandlerResult::Err(TEXT("no PIE viewport (start PIE first)"));
    if (!FSlateApplication::IsInitialized())
        return FHaybaHandlerResult::Err(TEXT("Slate is not initialized"));

    FString NewText;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("text"), NewText))
        return FHaybaHandlerResult::Err(TEXT("editor_pie_set_text: text is required"));

    // Target either a widget found by label/placeholder, or whatever has focus.
    FString Match;
    P->TryGetStringField(TEXT("match"), Match);

    TSharedPtr<SWidget> Target;
    FString HowFound;

    if (!Match.IsEmpty())
    {
        TSharedPtr<SWindow> Win = Client->GetWindow();
        if (!Win.IsValid()) return FHaybaHandlerResult::Err(TEXT("PIE window not found"));
        Target = FindEditableByText(Win.ToSharedRef(), Match);
        HowFound = TEXT("match");
        if (!Target.IsValid())
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("editor_pie_set_text: no editable text widget matching '%s'. ")
                TEXT("Call editor_pie_widget_tree to see what is there — the placeholder text counts as a match."), *Match));
        }
    }
    else
    {
        Target = FSlateApplication::Get().GetKeyboardFocusedWidget();
        HowFound = TEXT("focus");
        if (!Target.IsValid())
        {
            return FHaybaHandlerResult::Err(TEXT("editor_pie_set_text: nothing has keyboard focus and no `match` was given"));
        }
    }

    const FString Type = Target->GetTypeAsString();
    bool bApplied = false;

    if (Type.Contains(TEXT("SEditableText")) || Type.Contains(TEXT("SMultiLineEditableText")))
    {
        if (Type.Contains(TEXT("Box")))
        {
            // SEditableTextBox / SMultiLineEditableTextBox wrap the real editor.
            if (TSharedPtr<SWidget> Inner = FindEditableDescendant(Target.ToSharedRef()))
            {
                Target = Inner;
            }
        }
    }

    const FString ResolvedType = Target->GetTypeAsString();

    // Focus first. The value is committed below by a real Enter key, which only
    // reaches the widget that holds focus — and focusing also matches what the
    // game sees when a person fills the field.
    FSlateApplication::Get().SetKeyboardFocus(Target, EFocusCause::SetDirectly);

    if (ResolvedType.Contains(TEXT("SMultiLineEditableText")))
    {
        StaticCastSharedRef<SMultiLineEditableText>(Target.ToSharedRef())->SetText(FText::FromString(NewText));
        bApplied = true;
    }
    else if (ResolvedType.Contains(TEXT("SEditableText")))
    {
        StaticCastSharedRef<SEditableText>(Target.ToSharedRef())->SetText(FText::FromString(NewText));
        bApplied = true;
    }

    TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
    R->SetStringField(TEXT("text"), NewText);
    R->SetStringField(TEXT("target_type"), ResolvedType);
    R->SetStringField(TEXT("found_by"), HowFound);
    R->SetBoolField(TEXT("applied"), bApplied);

    if (!bApplied)
    {
        // Naming the type is what turns "it did nothing" into a next step.
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_set_text: %s is not an editable text widget, so no text was set. ")
            TEXT("Target one with `match`, or click into the field first."), *ResolvedType));
    }

    // Read the value back off the widget rather than echoing the input — the
    // whole point is to know the text is actually in the box.
    FString Readback;
    if (ResolvedType.Contains(TEXT("SMultiLineEditableText")))
        Readback = StaticCastSharedRef<SMultiLineEditableText>(Target.ToSharedRef())->GetText().ToString();
    else
        Readback = StaticCastSharedRef<SEditableText>(Target.ToSharedRef())->GetText().ToString();

    R->SetStringField(TEXT("readback"), Readback);
    R->SetBoolField(TEXT("verified"), Readback == NewText);

    // SetText updates the widget but does NOT fire OnTextCommitted, and most
    // games read the value from that binding rather than polling the widget.
    // Without this the box visibly contains the text and the game never gets
    // it — which is the "typed text was lost" shape. A real Enter through Slate
    // makes the commit happen exactly as it would for a person.
    bool bCommit = true;
    P->TryGetBoolField(TEXT("commit"), bCommit);
    if (bCommit)
    {
        SendKeyThroughSlate(EKeys::Enter, IE_Pressed);
        SendKeyThroughSlate(EKeys::Enter, IE_Released);
    }
    R->SetBoolField(TEXT("committed"), bCommit);
    if (Readback != NewText)
    {
        R->SetStringField(TEXT("warning"),
            TEXT("The widget did not take the value — it may be read-only, length-capped or filtered. ")
            TEXT("`readback` is what it actually holds."));
    }
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
    // Scoring, rather than "first match wins".
    //
    // Matching a label usually means "press the control that carries it", so an
    // interactive widget outranks a static one. Among equals the SMALLEST match
    // wins: a panel containing the text is a worse target than the button
    // containing the text, and the panel is often huge enough that its centre is
    // nowhere near the thing you meant.
    TSharedPtr<FJsonObject> Best;
    double BestScore = -1e18;
    TArray<FString> Candidates;
    // Every match with its score, so a wrong pick is diagnosable and
    // overridable instead of being a dead end. "It clicked the wrong one" was
    // unanswerable before: the response named a count and nothing else.
    TArray<TPair<double, TSharedPtr<FJsonObject>>> Ranked;
    for (const TSharedPtr<FJsonValue>& V : All)
    {
        const TSharedPtr<FJsonObject> O = V->AsObject();
        if (!O.IsValid()) continue;
        FString Type, Text, Tag;
        O->TryGetStringField(TEXT("type"), Type);
        O->TryGetStringField(TEXT("text"), Text);
        O->TryGetStringField(TEXT("tag"), Tag);

        const bool bExactText = Text.Equals(Match, ESearchCase::IgnoreCase);
        const bool bHit = bExactText
            || Text.Contains(Match) || Tag.Contains(Match) || Type.Contains(Match);
        if (!bHit) continue;

        Candidates.Add(FString::Printf(TEXT("%s%s"), *Type,
            Text.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" \"%s\""), *Text)));

        bool bInteractive = false, bEnabled = true;
        O->TryGetBoolField(TEXT("interactive"), bInteractive);
        O->TryGetBoolField(TEXT("enabled"), bEnabled);
        double W = 0.0, H = 0.0;
        O->TryGetNumberField(TEXT("width"), W);
        O->TryGetNumberField(TEXT("height"), H);

        double Score = 0.0;
        if (bInteractive) Score += 1000.0;      // a control beats a label
        if (bEnabled)     Score += 100.0;       // a disabled control is rarely the target
        if (bExactText)   Score += 500.0;       // exact label beats substring
        Score -= (W * H) / 10000.0;             // prefer the tightest box

        Ranked.Add(TPair<double, TSharedPtr<FJsonObject>>(Score, O));
        if (Score > BestScore)
        {
            BestScore = Score;
            Best = O;
        }
    }

    Ranked.Sort([](const TPair<double, TSharedPtr<FJsonObject>>& A,
                   const TPair<double, TSharedPtr<FJsonObject>>& B) { return A.Key > B.Key; });

    // `nth` picks a different candidate from that ranking, so "it clicked the
    // wrong one" is a one-parameter fix rather than a fall back to hand-tuned
    // coordinates.
    int32 Nth = 0;
    if (P->TryGetNumberField(TEXT("nth"), Nth) && Nth > 0)
    {
        if (!Ranked.IsValidIndex(Nth))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("editor_pie_click_widget: nth=%d but only %d widgets matched '%s'"),
                Nth, Ranked.Num(), *Match));
        }
        Best = Ranked[Nth].Value;
    }

    // Restrict to a widget type when the label is ambiguous, e.g. prefer_type
    // "SButton" for a tab whose label also appears on a panel behind it.
    FString PreferType;
    if (P->TryGetStringField(TEXT("prefer_type"), PreferType) && !PreferType.IsEmpty())
    {
        for (const TPair<double, TSharedPtr<FJsonObject>>& Entry : Ranked)
        {
            FString T;
            if (Entry.Value->TryGetStringField(TEXT("type"), T) && T.Contains(PreferType))
            {
                Best = Entry.Value;
                break;
            }
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

    // The EXACT sequence editor_pie_mouse uses at these coordinates: a
    // Slate-visible move to the target (MoveCursorToPixel sends a real
    // ProcessMouseMoveEvent), press, release, pointer-state reset.
    //
    // This path previously did a bare SetCursorPos with NO synthetic move
    // before the press. Field matrix (WarRoom map, viewport MouseCaptureMode
    // CaptureDuringMouseDown): editor_pie_mouse click at the button's centre
    // fired OnClicked; this command on the SAME button showed hover/pressed
    // visuals and focused the SButton but never dispatched OnClicked; on a
    // NoCapture map both worked. Without the move, Slate's pointer path was
    // stale from whatever the cursor last hovered, and under a capturing
    // viewport the release resolved against that stale state instead of the
    // button. Sharing the primitives makes the two commands equivalent by
    // construction.
    //
    // center_x/center_y are already absolute desktop coordinates, so
    // bViewportRelative=false passes them through unchanged.
    FVector2D ClickAbs;
    if (!MoveCursorToPixel(Client, FVector2D(CX, CY), /*bViewportRelative=*/false, ClickAbs))
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_widget: could not position the cursor"));
    SendMouseButton(Client, EKeys::LeftMouseButton, IE_Pressed);
    SendMouseButton(Client, EKeys::LeftMouseButton, IE_Released);
    const bool bCaptureCleared = ResetPointerStateAfterRelease();

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

    // The ranking itself, so a wrong pick can be corrected with nth/prefer_type
    // instead of abandoning the tool for hand-tuned coordinates.
    {
        TArray<TSharedPtr<FJsonValue>> Detail;
        const int32 Show = FMath::Min(Ranked.Num(), 6);
        for (int32 i = 0; i < Show; ++i)
        {
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            FString T, Tx;
            Ranked[i].Value->TryGetStringField(TEXT("type"), T);
            Ranked[i].Value->TryGetStringField(TEXT("text"), Tx);
            double EX = 0, EY = 0;
            Ranked[i].Value->TryGetNumberField(TEXT("center_x"), EX);
            Ranked[i].Value->TryGetNumberField(TEXT("center_y"), EY);
            bool bInt = false;
            Ranked[i].Value->TryGetBoolField(TEXT("interactive"), bInt);
            E->SetNumberField(TEXT("nth"), i);
            E->SetStringField(TEXT("type"), T);
            if (!Tx.IsEmpty()) E->SetStringField(TEXT("text"), Tx);
            E->SetBoolField(TEXT("interactive"), bInt);
            E->SetNumberField(TEXT("center_x"), EX);
            E->SetNumberField(TEXT("center_y"), EY);
            E->SetNumberField(TEXT("score"), Ranked[i].Key);
            Detail.Add(MakeShared<FJsonValueObject>(E));
        }
        R->SetArrayField(TEXT("ranked"), Detail);
    }

    // What holds focus now. A click that was supposed to land on a control and
    // left focus on the SViewport did not hit the UI, and that is otherwise
    // invisible until something later fails.
    R->SetStringField(TEXT("focused_widget_after"), FocusedWidgetType());
    R->SetBoolField(TEXT("capture_cleared"), bCaptureCleared);
    bool bEnabled = true, bInteractive = false;
    Best->TryGetBoolField(TEXT("enabled"), bEnabled);
    Best->TryGetBoolField(TEXT("interactive"), bInteractive);
    R->SetBoolField(TEXT("target_enabled"), bEnabled);
    R->SetBoolField(TEXT("target_interactive"), bInteractive);
    if (!bEnabled)
    {
        // Otherwise this reads as a successful click that silently did nothing.
        R->SetStringField(TEXT("warning"), TEXT("The matched widget is DISABLED, so the click will have no effect."));
    }
    if (Candidates.Num() > 1)
    {
        // Say when the choice was ambiguous rather than silently picking one.
        R->SetStringField(TEXT("note"), FString::Printf(
            TEXT("%d widgets matched; clicked the interactive one. Use editor_pie_widget_tree and "
                 "editor_pie_mouse with explicit coordinates if that was the wrong choice."), Candidates.Num()));
    }
    return FHaybaHandlerResult::Ok(R);
}

// ---------------------------------------------------------------------------
// Read-only runtime scene grounding
// ---------------------------------------------------------------------------

namespace
{
    constexpr int32 MaxPIEWorldsReported = 50;
    constexpr int32 MaxActorsScanned = 100000;
    constexpr int32 MaxActorResolutionScans = 20000;
    constexpr int32 MaxTagsReported = 50;

    struct FPIEWorldEntry
    {
        UWorld* World = nullptr;
        HaybaPIERuntimeOps::FWorldCandidate Candidate;
    };

    TArray<FPIEWorldEntry> RuntimePIEWorlds()
    {
        TArray<FPIEWorldEntry> Out;
        if (!GEngine) return Out;

        for (const FWorldContext& Context : GEngine->GetWorldContexts())
        {
            UWorld* World = Context.World();
            if (Context.WorldType != EWorldType::PIE || !IsValid(World)) continue;

            FPIEWorldEntry Entry;
            Entry.World = World;
            Entry.Candidate.PIEInstance = Context.PIEInstance;
            Entry.Candidate.WorldName = World->GetName();
            Entry.Candidate.bIsPlayWorld = GEditor && GEditor->PlayWorld == World;
            if (UGameViewportClient* ViewportClient = World->GetGameViewport())
            {
                Entry.Candidate.bHasViewport = ViewportClient->Viewport != nullptr;
            }
            Out.Add(MoveTemp(Entry));
            if (Out.Num() >= MaxPIEWorldsReported) break;
        }

        Out.Sort([](const FPIEWorldEntry& A, const FPIEWorldEntry& B)
        {
            if (A.Candidate.PIEInstance != B.Candidate.PIEInstance)
                return A.Candidate.PIEInstance < B.Candidate.PIEInstance;
            return A.Candidate.WorldName < B.Candidate.WorldName;
        });
        return Out;
    }

    TArray<HaybaPIERuntimeOps::FWorldCandidate> RuntimeWorldCandidates(const TArray<FPIEWorldEntry>& Worlds)
    {
        TArray<HaybaPIERuntimeOps::FWorldCandidate> Out;
        Out.Reserve(Worlds.Num());
        for (const FPIEWorldEntry& Entry : Worlds) Out.Add(Entry.Candidate);
        return Out;
    }

    FString RuntimeNetModeName(const UWorld* World)
    {
        if (!World) return TEXT("unknown");
        switch (World->GetNetMode())
        {
        case NM_Standalone:      return TEXT("standalone");
        case NM_DedicatedServer: return TEXT("dedicated_server");
        case NM_ListenServer:    return TEXT("listen_server");
        case NM_Client:          return TEXT("client");
        default:                 return TEXT("unknown");
        }
    }

    TSharedPtr<FJsonObject> RuntimeVectorJson(const FVector& Value)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        const bool bValid = HaybaPIERuntimeOps::IsFiniteVector(Value);
        Out->SetBoolField(TEXT("valid"), bValid);
        if (bValid)
        {
            Out->SetNumberField(TEXT("x"), Value.X);
            Out->SetNumberField(TEXT("y"), Value.Y);
            Out->SetNumberField(TEXT("z"), Value.Z);
        }
        return Out;
    }

    TSharedPtr<FJsonObject> RuntimeRotatorJson(const FRotator& Value)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        const bool bValid = HaybaPIERuntimeOps::IsFiniteRotator(Value);
        Out->SetBoolField(TEXT("valid"), bValid);
        if (bValid)
        {
            Out->SetNumberField(TEXT("pitch"), Value.Pitch);
            Out->SetNumberField(TEXT("yaw"), Value.Yaw);
            Out->SetNumberField(TEXT("roll"), Value.Roll);
        }
        return Out;
    }

    TSharedPtr<FJsonObject> RuntimeWorldJson(
        const FPIEWorldEntry& Selected,
        const HaybaPIERuntimeOps::FWorldSelection& Selection)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetNumberField(TEXT("pie_instance"), Selected.Candidate.PIEInstance);
        Out->SetStringField(TEXT("name"), Selected.Candidate.WorldName);
        Out->SetStringField(TEXT("net_mode"), RuntimeNetModeName(Selected.World));
        Out->SetBoolField(TEXT("has_viewport"), Selected.Candidate.bHasViewport);
        Out->SetStringField(TEXT("selected_by"), Selection.Reason);
        Out->SetBoolField(TEXT("multiple_worlds_present"), Selection.bWasAmbiguous);
        return Out;
    }

    TArray<TSharedPtr<FJsonValue>> RuntimeAvailableWorldsJson(const TArray<FPIEWorldEntry>& Worlds)
    {
        TArray<TSharedPtr<FJsonValue>> Out;
        for (const FPIEWorldEntry& Entry : Worlds)
        {
            TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetNumberField(TEXT("pie_instance"), Entry.Candidate.PIEInstance);
            Item->SetStringField(TEXT("name"), Entry.Candidate.WorldName);
            Item->SetStringField(TEXT("net_mode"), RuntimeNetModeName(Entry.World));
            Item->SetBoolField(TEXT("has_viewport"), Entry.Candidate.bHasViewport);
            Item->SetBoolField(TEXT("is_play_world"), Entry.Candidate.bIsPlayWorld);
            Out.Add(MakeShared<FJsonValueObject>(Item));
        }
        return Out;
    }

    bool RuntimeActorIsUsable(const AActor* Actor, const UWorld* ExpectedWorld)
    {
        return IsValid(Actor) && Actor->GetWorld() == ExpectedWorld && !Actor->IsActorBeingDestroyed();
    }

    AActor* ResolveRuntimeActor(
        UWorld* World,
        const HaybaPIERuntimeOps::FActorReference& Reference,
        FString& OutError)
    {
        if (!IsValid(World))
        {
            OutError = TEXT("selected PIE world is no longer valid");
            return nullptr;
        }

        // Exact paths come from editor_pie_actor_list. Resolve them directly,
        // then enforce selected-world ownership; no asset load and no actor in
        // another PIE/editor world can cross this boundary.
        if (!Reference.Path.IsEmpty())
        {
            AActor* PathMatch = FindObject<AActor>(nullptr, *Reference.Path);
            if (!RuntimeActorIsUsable(PathMatch, World))
            {
                OutError = TEXT("actor_path was not found in the selected PIE world");
                return nullptr;
            }
            return PathMatch;
        }

        AActor* Match = nullptr;
        int32 MatchCount = 0;
        int32 Scanned = 0;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (++Scanned > MaxActorResolutionScans)
            {
                OutError = FString::Printf(
                    TEXT("actor lookup exceeded %d scanned actors; use actor_path from editor_pie_actor_list"),
                    MaxActorResolutionScans);
                return nullptr;
            }
            AActor* Actor = *It;
            if (!RuntimeActorIsUsable(Actor, World)) continue;

            bool bMatches = false;
            if (!Reference.Id.IsEmpty())
                bMatches = Actor->GetName() == Reference.Id;
            else if (!Reference.Label.IsEmpty())
                bMatches = Actor->GetActorLabel() == Reference.Label;

            if (!bMatches) continue;
            Match = Actor;
            ++MatchCount;
            if (MatchCount > 1) break;
        }

        if (MatchCount == 0)
        {
            OutError = TEXT("actor was not found in the selected PIE world");
            return nullptr;
        }
        if (MatchCount > 1)
        {
            OutError = FString::Printf(
                TEXT("actor reference matched %d actors; use actor_path from editor_pie_actor_list"),
                MatchCount);
            return nullptr;
        }
        return RuntimeActorIsUsable(Match, World) ? Match : nullptr;
    }

    UActorComponent* ResolveOwnedRuntimeComponent(AActor* Actor, const FString& Name, FString& OutError)
    {
        if (!IsValid(Actor))
        {
            OutError = TEXT("actor is no longer valid");
            return nullptr;
        }
        if (Name.IsEmpty()) return nullptr;

        TInlineComponentArray<UActorComponent*> Components;
        Actor->GetComponents(Components);
        UActorComponent* Match = nullptr;
        int32 MatchCount = 0;
        for (UActorComponent* Component : Components)
        {
            if (!IsValid(Component) || Component->GetOwner() != Actor) continue;
            if (Component->GetName() == Name || Component->GetPathName() == Name)
            {
                Match = Component;
                ++MatchCount;
            }
        }
        if (MatchCount == 0)
        {
            OutError = FString::Printf(TEXT("owned component not found: %s"), *Name);
            return nullptr;
        }
        if (MatchCount > 1)
        {
            OutError = FString::Printf(TEXT("component reference is ambiguous: %s"), *Name);
            return nullptr;
        }
        return IsValid(Match) && Match->GetOwner() == Actor ? Match : nullptr;
    }

    FString RuntimeCollisionName(const UPrimitiveComponent* Primitive)
    {
        if (!Primitive) return TEXT("not_primitive");
        return HaybaPIERuntimeOps::CollisionEnabledName(Primitive->GetCollisionEnabled());
    }

    TSharedPtr<FJsonObject> RuntimeComponentJson(UActorComponent* Component)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("name"), Component->GetName());
        Out->SetStringField(TEXT("path"), Component->GetPathName());
        Out->SetStringField(TEXT("class"), Component->GetClass()->GetPathName());
        Out->SetBoolField(TEXT("active"), Component->IsActive());
        Out->SetBoolField(TEXT("registered"), Component->IsRegistered());

        if (const USceneComponent* Scene = Cast<USceneComponent>(Component))
        {
            const FVector Location = Scene->GetComponentLocation();
            const FRotator Rotation = Scene->GetComponentRotation();
            const FVector Scale = Scene->GetComponentScale();
            Out->SetObjectField(TEXT("location"), RuntimeVectorJson(Location));
            Out->SetObjectField(TEXT("rotation"), RuntimeRotatorJson(Rotation));
            Out->SetObjectField(TEXT("scale"), RuntimeVectorJson(Scale));
            Out->SetBoolField(TEXT("invalid_numeric"),
                !HaybaPIERuntimeOps::IsFiniteVector(Location)
                || !HaybaPIERuntimeOps::IsFiniteRotator(Rotation)
                || !HaybaPIERuntimeOps::IsFiniteVector(Scale));
            Out->SetBoolField(TEXT("visible"), Scene->IsVisible());
        }
        if (const UPrimitiveComponent* Primitive = Cast<UPrimitiveComponent>(Component))
        {
            Out->SetStringField(TEXT("collision"), RuntimeCollisionName(Primitive));
            const bool bBoundsValid = HaybaPIERuntimeOps::IsFiniteVector(Primitive->Bounds.Origin)
                && HaybaPIERuntimeOps::IsFiniteVector(Primitive->Bounds.BoxExtent);
            Out->SetObjectField(TEXT("bounds_origin"), RuntimeVectorJson(Primitive->Bounds.Origin));
            Out->SetObjectField(TEXT("bounds_extent"), RuntimeVectorJson(Primitive->Bounds.BoxExtent));
            bool bInvalidNumeric = false;
            Out->TryGetBoolField(TEXT("invalid_numeric"), bInvalidNumeric);
            Out->SetBoolField(TEXT("invalid_numeric"), bInvalidNumeric || !bBoundsValid);
        }
        return Out;
    }

    TSharedPtr<FJsonObject> RuntimeActorJson(AActor* Actor, bool bIncludeBounds)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("id"), Actor->GetName());
        Out->SetStringField(TEXT("path"), Actor->GetPathName());
        Out->SetStringField(TEXT("label"), Actor->GetActorLabel());
        Out->SetStringField(TEXT("class"), Actor->GetClass()->GetPathName());
        const FVector Location = Actor->GetActorLocation();
        const FRotator Rotation = Actor->GetActorRotation();
        const FVector Scale = Actor->GetActorScale3D();
        Out->SetObjectField(TEXT("location"), RuntimeVectorJson(Location));
        Out->SetObjectField(TEXT("rotation"), RuntimeRotatorJson(Rotation));
        Out->SetObjectField(TEXT("scale"), RuntimeVectorJson(Scale));
        bool bInvalidNumeric = !HaybaPIERuntimeOps::IsFiniteVector(Location)
            || !HaybaPIERuntimeOps::IsFiniteRotator(Rotation)
            || !HaybaPIERuntimeOps::IsFiniteVector(Scale);
        Out->SetBoolField(TEXT("hidden"), Actor->IsHidden());

        if (bIncludeBounds)
        {
            FVector Origin = FVector::ZeroVector;
            FVector Extent = FVector::ZeroVector;
            Actor->GetActorBounds(false, Origin, Extent, true);
            Out->SetObjectField(TEXT("bounds_origin"), RuntimeVectorJson(Origin));
            Out->SetObjectField(TEXT("bounds_extent"), RuntimeVectorJson(Extent));
            bInvalidNumeric = bInvalidNumeric
                || !HaybaPIERuntimeOps::IsFiniteVector(Origin)
                || !HaybaPIERuntimeOps::IsFiniteVector(Extent);
        }
        Out->SetBoolField(TEXT("invalid_numeric"), bInvalidNumeric);
        return Out;
    }

    bool RuntimeSelectWorld(
        const TOptional<int32>& RequestedPIEInstance,
        bool bRequireViewport,
        TArray<FPIEWorldEntry>& OutWorlds,
        FPIEWorldEntry*& OutSelected,
        HaybaPIERuntimeOps::FWorldSelection& OutSelection,
        FString& OutError)
    {
        OutWorlds = RuntimePIEWorlds();
        OutSelection = HaybaPIERuntimeOps::SelectWorld(
            RuntimeWorldCandidates(OutWorlds), RequestedPIEInstance, bRequireViewport);
        if (!OutSelection.IsValid())
        {
            TArray<FString> Available;
            for (const FPIEWorldEntry& Entry : OutWorlds)
            {
                Available.Add(FString::Printf(
                    TEXT("%d:%s(viewport=%s,net=%s)"),
                    Entry.Candidate.PIEInstance,
                    *Entry.Candidate.WorldName,
                    Entry.Candidate.bHasViewport ? TEXT("yes") : TEXT("no"),
                    *RuntimeNetModeName(Entry.World)));
            }
            OutError = OutSelection.Error;
            if (!Available.IsEmpty())
                OutError += FString::Printf(TEXT("; available PIE worlds: [%s]"), *FString::Join(Available, TEXT(", ")));
            return false;
        }
        if (!OutWorlds.IsValidIndex(OutSelection.CandidateIndex))
        {
            OutError = TEXT("PIE world selection became invalid");
            return false;
        }
        OutSelected = &OutWorlds[OutSelection.CandidateIndex];
        if (!IsValid(OutSelected->World))
        {
            OutError = TEXT("selected PIE world was destroyed before inspection");
            return false;
        }
        return true;
    }

    APlayerController* RuntimeLocalPlayerController(UWorld* World, int32 PlayerIndex, FString& OutError)
    {
        if (!IsValid(World))
        {
            OutError = TEXT("selected PIE world is no longer valid");
            return nullptr;
        }

        UGameInstance* GameInstance = World->GetGameInstance();
        if (!IsValid(GameInstance))
        {
            OutError = TEXT("selected PIE world has no game instance");
            return nullptr;
        }

        // UWorld::PlayerControllerList is not an ordinal contract: its order
        // can change on travel/controller replacement. LocalPlayers is the
        // canonical stable split-screen order exposed by UGameInstance.
        ULocalPlayer* LocalPlayer = GameInstance->GetLocalPlayerByIndex(PlayerIndex);
        if (!IsValid(LocalPlayer))
        {
            OutError = FString::Printf(TEXT("local player_index %d was not found"), PlayerIndex);
            return nullptr;
        }
        APlayerController* PlayerController = LocalPlayer->GetPlayerController(World);
        if (!IsValid(PlayerController)
            || !PlayerController->IsLocalController()
            || PlayerController->GetWorld() != World
            || PlayerController->GetLocalPlayer() != LocalPlayer)
        {
            OutError = FString::Printf(
                TEXT("local player_index %d has no controller in the selected PIE world"), PlayerIndex);
            return nullptr;
        }
        return PlayerController;
    }
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEActorList(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader Reader(P, TEXT("editor_pie_actor_list"));
    const HaybaPIERuntimeOps::FListRequest Request = HaybaPIERuntimeOps::ParseList(Reader);
    if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());

    TArray<FPIEWorldEntry> Worlds;
    FPIEWorldEntry* Selected = nullptr;
    HaybaPIERuntimeOps::FWorldSelection Selection;
    FString Error;
    if (!RuntimeSelectWorld(Request.World.PIEInstance, false, Worlds, Selected, Selection, Error))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_actor_list: %s"), *Error));

    TArray<AActor*> Matches;
    Matches.Reserve(FMath::Min(HaybaPIERuntimeOps::MaxRetainedActorMatches, Request.Offset + Request.Limit));
    int32 Scanned = 0;
    int32 TotalMatched = 0;
    bool bScanTruncated = false;
    bool bMatchesTruncated = false;
    const FName TagFilterName = Request.Tag.IsEmpty()
        ? NAME_None
        : FName(*Request.Tag, FNAME_Find);
    for (TActorIterator<AActor> It(Selected->World); It; ++It)
    {
        if (++Scanned > MaxActorsScanned)
        {
            bScanTruncated = true;
            break;
        }
        AActor* Actor = *It;
        if (!RuntimeActorIsUsable(Actor, Selected->World)) continue;
        if (!Request.ClassFilter.IsEmpty()
            && !Actor->GetClass()->GetName().Contains(Request.ClassFilter, ESearchCase::IgnoreCase)
            && !Actor->GetClass()->GetPathName().Contains(Request.ClassFilter, ESearchCase::IgnoreCase))
            continue;
        if (!Request.NameFilter.IsEmpty()
            && !Actor->GetName().Contains(Request.NameFilter, ESearchCase::IgnoreCase)
            && !Actor->GetActorLabel().Contains(Request.NameFilter, ESearchCase::IgnoreCase))
            continue;
        if (!Request.Tag.IsEmpty()
            && (TagFilterName.IsNone() || !Actor->ActorHasTag(TagFilterName))) continue;

        ++TotalMatched;
        if (Matches.Num() < HaybaPIERuntimeOps::MaxRetainedActorMatches) Matches.Add(Actor);
        else bMatchesTruncated = true;
    }

    Matches.Sort([](const AActor& A, const AActor& B)
    {
        return A.GetPathName() < B.GetPathName();
    });

    TArray<TSharedPtr<FJsonValue>> Actors;
    const HaybaPIERuntimeOps::FPageWindow Page = HaybaPIERuntimeOps::ComputePage(
        Request.Offset, Request.Limit, Matches.Num());
    for (int32 Index = Page.Start; Index < Page.End; ++Index)
    {
        AActor* Actor = Matches[Index];
        if (!RuntimeActorIsUsable(Actor, Selected->World)) continue;
        Actors.Add(MakeShared<FJsonValueObject>(RuntimeActorJson(Actor, false)));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetObjectField(TEXT("world"), RuntimeWorldJson(*Selected, Selection));
    Out->SetArrayField(TEXT("available_worlds"), RuntimeAvailableWorldsJson(Worlds));
    Out->SetArrayField(TEXT("actors"), Actors);
    Out->SetNumberField(TEXT("offset"), Request.Offset);
    Out->SetNumberField(TEXT("limit"), Request.Limit);
    Out->SetNumberField(TEXT("returned"), Actors.Num());
    Out->SetNumberField(TEXT("matched_in_scanned_prefix"), TotalMatched);
    Out->SetBoolField(TEXT("matched_count_is_lower_bound"), bScanTruncated);
    Out->SetNumberField(TEXT("retained_for_pagination"), Matches.Num());
    Out->SetBoolField(TEXT("result_set_complete"), !bScanTruncated && !bMatchesTruncated);
    Out->SetNumberField(TEXT("scanned"), FMath::Min(Scanned, MaxActorsScanned));
    Out->SetBoolField(TEXT("scan_truncated"), bScanTruncated);
    Out->SetBoolField(TEXT("matches_truncated"), bMatchesTruncated);
    Out->SetBoolField(TEXT("has_more"), Page.bHasMore);
    if (Page.NextOffset.IsSet()) Out->SetNumberField(TEXT("next_offset"), *Page.NextOffset);
    if (bMatchesTruncated)
        Out->SetStringField(TEXT("partial_reason"), TEXT("more than 10000 actors matched; pagination is bounded to the retained prefix"));
    else if (bScanTruncated)
        Out->SetStringField(TEXT("partial_reason"), TEXT("actor scan reached the 100000-actor safety cap"));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEActorInspect(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader Reader(P, TEXT("editor_pie_actor_inspect"));
    const HaybaPIERuntimeOps::FInspectRequest Request = HaybaPIERuntimeOps::ParseInspect(Reader);
    if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());

    TArray<FPIEWorldEntry> Worlds;
    FPIEWorldEntry* Selected = nullptr;
    HaybaPIERuntimeOps::FWorldSelection Selection;
    FString Error;
    if (!RuntimeSelectWorld(Request.World.PIEInstance, false, Worlds, Selected, Selection, Error))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_actor_inspect: %s"), *Error));

    AActor* Actor = ResolveRuntimeActor(Selected->World, Request.Actor, Error);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_actor_inspect: %s"), *Error));

    TInlineComponentArray<UActorComponent*> Components;
    Actor->GetComponents(Components);
    Components.RemoveAll([&](UActorComponent* Component)
    {
        return !IsValid(Component)
            || Component->GetOwner() != Actor
            || (!Request.ComponentFilter.IsEmpty()
                && !Component->GetName().Contains(Request.ComponentFilter, ESearchCase::IgnoreCase)
                && !Component->GetClass()->GetName().Contains(Request.ComponentFilter, ESearchCase::IgnoreCase));
    });
    Components.Sort([](const UActorComponent& A, const UActorComponent& B)
    {
        return A.GetPathName() < B.GetPathName();
    });

    TArray<TSharedPtr<FJsonValue>> ComponentJson;
    const int32 PageStart = FMath::Min(Request.ComponentOffset, Components.Num());
    const int32 PageEnd = FMath::Min(PageStart + Request.ComponentLimit, Components.Num());
    for (int32 Index = PageStart; Index < PageEnd; ++Index)
    {
        UActorComponent* Component = Components[Index];
        if (!IsValid(Component) || Component->GetOwner() != Actor) continue;
        ComponentJson.Add(MakeShared<FJsonValueObject>(RuntimeComponentJson(Component)));
    }

    TSharedPtr<FJsonObject> ActorJson = RuntimeActorJson(Actor, true);
    TArray<TSharedPtr<FJsonValue>> Tags;
    const int32 TagCount = FMath::Min(Actor->Tags.Num(), MaxTagsReported);
    for (int32 Index = 0; Index < TagCount; ++Index)
        Tags.Add(MakeShared<FJsonValueString>(Actor->Tags[Index].ToString()));
    ActorJson->SetArrayField(TEXT("tags"), Tags);
    ActorJson->SetBoolField(TEXT("tags_truncated"), Actor->Tags.Num() > MaxTagsReported);
    if (AActor* Owner = Actor->GetOwner(); RuntimeActorIsUsable(Owner, Selected->World))
        ActorJson->SetStringField(TEXT("owner_path"), Owner->GetPathName());

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetObjectField(TEXT("world"), RuntimeWorldJson(*Selected, Selection));
    Out->SetArrayField(TEXT("available_worlds"), RuntimeAvailableWorldsJson(Worlds));
    Out->SetObjectField(TEXT("actor"), ActorJson);
    Out->SetArrayField(TEXT("components"), ComponentJson);
    Out->SetNumberField(TEXT("component_offset"), Request.ComponentOffset);
    Out->SetNumberField(TEXT("component_limit"), Request.ComponentLimit);
    Out->SetNumberField(TEXT("components_returned"), ComponentJson.Num());
    Out->SetNumberField(TEXT("components_total"), Components.Num());
    Out->SetBoolField(TEXT("components_have_more"), Request.ComponentOffset + ComponentJson.Num() < Components.Num());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEProjectWorld(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader Reader(P, TEXT("editor_pie_project_world"));
    const HaybaPIERuntimeOps::FProjectRequest Request = HaybaPIERuntimeOps::ParseProject(Reader);
    if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());

    TArray<FPIEWorldEntry> Worlds;
    FPIEWorldEntry* Selected = nullptr;
    HaybaPIERuntimeOps::FWorldSelection Selection;
    FString Error;
    if (!RuntimeSelectWorld(Request.World.PIEInstance, true, Worlds, Selected, Selection, Error))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_project_world: %s"), *Error));

    AActor* TargetActor = nullptr;
    UActorComponent* TargetComponent = nullptr;
    FVector TargetLocation = FVector::ZeroVector;
    FString TargetSource;
    if (Request.WorldLocation.IsSet())
    {
        TargetLocation = *Request.WorldLocation;
        TargetSource = TEXT("world_location");
    }
    else
    {
        TargetActor = ResolveRuntimeActor(Selected->World, Request.Actor, Error);
        if (!TargetActor)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_project_world: %s"), *Error));

        if (!Request.ComponentName.IsEmpty())
        {
            TargetComponent = ResolveOwnedRuntimeComponent(TargetActor, Request.ComponentName, Error);
            if (!TargetComponent)
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_project_world: %s"), *Error));
            const USceneComponent* Scene = Cast<USceneComponent>(TargetComponent);
            if (!Scene)
                return FHaybaHandlerResult::Err(TEXT("editor_pie_project_world: component is not a scene component"));
            if (Request.Sample == TEXT("component_location"))
            {
                TargetLocation = Scene->GetComponentLocation();
                TargetSource = TEXT("component_location");
            }
            else if (const UPrimitiveComponent* Primitive = Cast<UPrimitiveComponent>(TargetComponent))
            {
                TargetLocation = Primitive->Bounds.Origin;
                TargetSource = TEXT("component_bounds_origin");
            }
            else
            {
                return FHaybaHandlerResult::Err(TEXT(
                    "editor_pie_project_world: bounds_origin requires a primitive component; pass sample:'component_location' for this scene component"));
            }
        }
        else if (Request.Sample == TEXT("actor_location"))
        {
            TargetLocation = TargetActor->GetActorLocation();
            TargetSource = TEXT("actor_location");
        }
        else
        {
            FVector Extent = FVector::ZeroVector;
            TargetActor->GetActorBounds(false, TargetLocation, Extent, true);
            TargetSource = TEXT("bounds_origin");
        }
    }

    APlayerController* PlayerController = RuntimeLocalPlayerController(
        Selected->World, Request.PlayerIndex, Error);
    if (!PlayerController)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_project_world: %s"), *Error));

    UGameViewportClient* ViewportClient = Selected->World->GetGameViewport();
    if (!ViewportClient || !ViewportClient->Viewport)
        return FHaybaHandlerResult::Err(TEXT("editor_pie_project_world: selected PIE world lost its viewport"));

    const FIntPoint ViewportSize = ViewportClient->Viewport->GetSizeXY();
    FVector2D ViewportPoint = FVector2D::ZeroVector;
    // Full-viewport coordinates are required by both GetHitResultAtScreenPosition
    // and the SViewport-to-desktop transform below. Player-relative coordinates
    // silently click the wrong quadrant in split-screen PIE.
    if (!FMath::IsFinite(TargetLocation.X)
        || !FMath::IsFinite(TargetLocation.Y)
        || !FMath::IsFinite(TargetLocation.Z)
        || FMath::Abs(TargetLocation.X) > HaybaPIERuntimeOps::MaxWorldCoordinateAbs
        || FMath::Abs(TargetLocation.Y) > HaybaPIERuntimeOps::MaxWorldCoordinateAbs
        || FMath::Abs(TargetLocation.Z) > HaybaPIERuntimeOps::MaxWorldCoordinateAbs)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_project_world: target location is non-finite or outside the supported world range"));
    }

    const bool bProjectionCallSucceeded = PlayerController->ProjectWorldLocationToScreen(
        TargetLocation, ViewportPoint, /*bPlayerViewportRelative=*/false);
    const bool bProjectionFinite = FMath::IsFinite(ViewportPoint.X) && FMath::IsFinite(ViewportPoint.Y);
    if (!bProjectionFinite)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_project_world: projection produced non-finite screen coordinates"));
    }
    const bool bProjected = bProjectionCallSucceeded && bProjectionFinite;
    const bool bInViewport = bProjected
        && ViewportPoint.X >= 0.0 && ViewportPoint.Y >= 0.0
        && ViewportPoint.X < ViewportSize.X && ViewportPoint.Y < ViewportSize.Y;

    TSharedPtr<FJsonObject> ViewportJson = MakeShared<FJsonObject>();
    ViewportJson->SetNumberField(TEXT("x"), ViewportPoint.X);
    ViewportJson->SetNumberField(TEXT("y"), ViewportPoint.Y);
    ViewportJson->SetNumberField(TEXT("width"), ViewportSize.X);
    ViewportJson->SetNumberField(TEXT("height"), ViewportSize.Y);
    ViewportJson->SetBoolField(TEXT("projected"), bProjected);
    ViewportJson->SetBoolField(TEXT("in_viewport"), bInViewport);

    // Convert through the live SViewport geometry rather than assuming the
    // outer SWindow begins where the game pixels begin. That assumption is
    // wrong for docked PIE and adds toolbar/tab offsets to every click.
    TSharedPtr<FJsonObject> AbsoluteJson = MakeShared<FJsonObject>();
    TSharedPtr<FJsonObject> SlateHitJson = MakeShared<FJsonObject>();
    bool bGeometryAvailable = false;
    bool bWindowVisible = false;
    bool bWindowMinimized = false;
    bool bSlateHitTested = false;
    bool bSlatePathValid = false;
    bool bOwningWindowIsHit = false;
    bool bContainsGameViewport = false;
    bool bWorldClickClear = false;
    bool bAbsoluteAvailable = false;
    if (TSharedPtr<SViewport> ViewportWidget = ViewportClient->GetGameViewportWidget())
    {
        const FGeometry Geometry = ViewportWidget->GetCachedGeometry();
        const FVector2D AbsoluteOrigin = Geometry.LocalToAbsolute(FVector2D::ZeroVector);
        const FVector2D AbsoluteEnd = Geometry.LocalToAbsolute(Geometry.GetLocalSize());
        const FVector2D AbsoluteSize = AbsoluteEnd - AbsoluteOrigin;
        if (ViewportSize.X > 0 && ViewportSize.Y > 0
            && FMath::IsFinite(AbsoluteOrigin.X) && FMath::IsFinite(AbsoluteOrigin.Y)
            && FMath::IsFinite(AbsoluteSize.X) && FMath::IsFinite(AbsoluteSize.Y)
            && AbsoluteSize.X > 0.0 && AbsoluteSize.Y > 0.0)
        {
            const FVector2D PixelScale(
                AbsoluteSize.X / static_cast<double>(ViewportSize.X),
                AbsoluteSize.Y / static_cast<double>(ViewportSize.Y));
            const FVector2D AbsolutePoint = AbsoluteOrigin + ViewportPoint * PixelScale;
            bGeometryAvailable = FMath::IsFinite(AbsolutePoint.X) && FMath::IsFinite(AbsolutePoint.Y);
            AbsoluteJson->SetNumberField(TEXT("viewport_origin_x"), AbsoluteOrigin.X);
            AbsoluteJson->SetNumberField(TEXT("viewport_origin_y"), AbsoluteOrigin.Y);
            AbsoluteJson->SetNumberField(TEXT("viewport_width"), AbsoluteSize.X);
            AbsoluteJson->SetNumberField(TEXT("viewport_height"), AbsoluteSize.Y);
            AbsoluteJson->SetNumberField(TEXT("pixel_scale_x"), PixelScale.X);
            AbsoluteJson->SetNumberField(TEXT("pixel_scale_y"), PixelScale.Y);

            TSharedPtr<SWindow> ViewportWindow = ViewportClient->GetWindow();
            if (bGeometryAvailable && bProjected && bInViewport
                && ViewportWindow.IsValid() && FSlateApplication::IsInitialized())
            {
                bWindowVisible = ViewportWindow->IsVisible();
                bWindowMinimized = ViewportWindow->IsWindowMinimized();
                FSlateApplication& Slate = FSlateApplication::Get();
                const FWidgetPath HitPath = Slate.LocateWindowUnderMouse(
                    AbsolutePoint,
                    Slate.GetInteractiveTopLevelWindows(),
                    /*bIgnoreEnabledStatus=*/false,
                    Slate.GetUserIndexForMouse());
                bSlateHitTested = true;
                bSlatePathValid = HitPath.IsValid();
                if (bSlatePathValid)
                {
                    bOwningWindowIsHit = HitPath.GetWindow() == ViewportWindow.ToSharedRef();
                    bContainsGameViewport = HitPath.ContainsWidget(ViewportWidget.Get());
                    const TSharedRef<SWidget> Leaf = HitPath.GetLastWidget();
                    SlateHitJson->SetStringField(TEXT("leaf_type"), Leaf->GetTypeAsString());
                    // A modal/UMG/Slate control deeper than or beside SViewport
                    // will consume the synthetic click before gameplay sees it.
                    bWorldClickClear = bOwningWindowIsHit
                        && bContainsGameViewport
                        && &Leaf.Get() == ViewportWidget.Get();
                }
            }

            bAbsoluteAvailable = bProjected
                && bInViewport
                && bGeometryAvailable
                && bWindowVisible
                && !bWindowMinimized
                && bSlatePathValid
                && bWorldClickClear;
            if (bAbsoluteAvailable)
            {
                // x/y exist only when they are a currently hit-testable world
                // click. Keeping a stale/offscreen candidate out of these keys
                // prevents callers from feeding it blindly to pie_mouse.
                AbsoluteJson->SetNumberField(TEXT("x"), AbsolutePoint.X);
                AbsoluteJson->SetNumberField(TEXT("y"), AbsolutePoint.Y);
            }
        }
    }
    AbsoluteJson->SetBoolField(TEXT("geometry_available"), bGeometryAvailable);
    AbsoluteJson->SetBoolField(TEXT("available"), bAbsoluteAvailable);
    AbsoluteJson->SetStringField(TEXT("coordinate_space"), TEXT("absolute"));
    SlateHitJson->SetBoolField(TEXT("tested"), bSlateHitTested);
    SlateHitJson->SetBoolField(TEXT("path_valid"), bSlatePathValid);
    SlateHitJson->SetBoolField(TEXT("owning_window_is_hit"), bOwningWindowIsHit);
    SlateHitJson->SetBoolField(TEXT("contains_game_viewport"), bContainsGameViewport);
    SlateHitJson->SetBoolField(TEXT("window_visible"), bWindowVisible);
    SlateHitJson->SetBoolField(TEXT("window_minimized"), bWindowMinimized);
    SlateHitJson->SetBoolField(TEXT("world_click_clear"), bWorldClickClear);

    TSharedPtr<FJsonObject> HitJson = MakeShared<FJsonObject>();
    bool bWorldHitTested = false;
    bool bTargetIsFirstWorldHit = false;
    HitJson->SetBoolField(TEXT("requested"), Request.bTraceVisibility);
    HitJson->SetBoolField(TEXT("tested"), false);
    if (Request.bTraceVisibility && bProjected && bInViewport)
    {
        FHitResult Hit;
        FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(HaybaPIEProjectWorld), true);
        QueryParams.bReturnPhysicalMaterial = false;
        QueryParams.bReturnFaceIndex = false;
        const bool bHit = PlayerController->GetHitResultAtScreenPosition(
            ViewportPoint, ECC_Visibility, QueryParams, Hit);
        HitJson->SetBoolField(TEXT("tested"), true);
        bWorldHitTested = true;
        HitJson->SetBoolField(TEXT("blocking_hit"), bHit && Hit.bBlockingHit);
        const bool bDistanceValid = FMath::IsFinite(Hit.Distance);
        HitJson->SetBoolField(TEXT("distance_valid"), bDistanceValid);
        if (bDistanceValid) HitJson->SetNumberField(TEXT("distance"), Hit.Distance);

        AActor* HitActor = Hit.GetActor();
        UPrimitiveComponent* HitComponent = Hit.GetComponent();
        if (RuntimeActorIsUsable(HitActor, Selected->World))
        {
            HitJson->SetStringField(TEXT("actor_id"), HitActor->GetName());
            HitJson->SetStringField(TEXT("actor_path"), HitActor->GetPathName());
            HitJson->SetStringField(TEXT("actor_class"), HitActor->GetClass()->GetPathName());
        }
        if (IsValid(HitComponent) && HitComponent->GetWorld() == Selected->World)
        {
            HitJson->SetStringField(TEXT("component_name"), HitComponent->GetName());
            HitJson->SetStringField(TEXT("component_path"), HitComponent->GetPathName());
        }

        const bool bMatchesActor = TargetActor && HitActor == TargetActor;
        const bool bMatchesComponent = TargetComponent && HitComponent == TargetComponent;
        bTargetIsFirstWorldHit = bMatchesComponent || (!TargetComponent && bMatchesActor);
        HitJson->SetBoolField(TEXT("matches_target_actor"), bMatchesActor);
        HitJson->SetBoolField(TEXT("matches_target_component"), bMatchesComponent);
        if (!TargetActor)
            HitJson->SetStringField(TEXT("verdict"), bHit ? TEXT("blocking_object_under_point") : TEXT("no_blocking_object_under_point"));
        else if (bTargetIsFirstWorldHit)
            HitJson->SetStringField(TEXT("verdict"), TEXT("target_is_first_world_visibility_hit"));
        else if (bHit)
            HitJson->SetStringField(TEXT("verdict"), TEXT("another_object_is_first_world_visibility_hit"));
        else
            HitJson->SetStringField(TEXT("verdict"), TEXT("no_blocking_hit_target_not_proven"));
    }
    else if (Request.bTraceVisibility)
    {
        HitJson->SetStringField(TEXT("not_tested_reason"),
            bProjected ? TEXT("projected point is outside the PIE viewport") : TEXT("world point did not project in front of the camera"));
    }

    TSharedPtr<FJsonObject> TargetJson = MakeShared<FJsonObject>();
    TargetJson->SetStringField(TEXT("source"), TargetSource);
    TargetJson->SetObjectField(TEXT("world_location"), RuntimeVectorJson(TargetLocation));
    if (TargetActor)
    {
        TargetJson->SetStringField(TEXT("actor_id"), TargetActor->GetName());
        TargetJson->SetStringField(TEXT("actor_path"), TargetActor->GetPathName());
    }
    if (TargetComponent)
    {
        TargetJson->SetStringField(TEXT("component_name"), TargetComponent->GetName());
        TargetJson->SetStringField(TEXT("component_path"), TargetComponent->GetPathName());
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetObjectField(TEXT("world"), RuntimeWorldJson(*Selected, Selection));
    Out->SetArrayField(TEXT("available_worlds"), RuntimeAvailableWorldsJson(Worlds));
    Out->SetNumberField(TEXT("player_index"), Request.PlayerIndex);
    Out->SetObjectField(TEXT("target"), TargetJson);
    Out->SetObjectField(TEXT("viewport"), ViewportJson);
    Out->SetObjectField(TEXT("absolute"), AbsoluteJson);
    Out->SetObjectField(TEXT("slate_hit"), SlateHitJson);
    Out->SetObjectField(TEXT("visibility_hit"), HitJson);
    const bool bTargetClickReady = TargetActor
        && bAbsoluteAvailable
        && bWorldHitTested
        && bTargetIsFirstWorldHit;
    Out->SetBoolField(TEXT("target_click_ready"), bTargetClickReady);
    if (!TargetActor)
        Out->SetStringField(TEXT("target_click_status"), TEXT("no_actor_target_to_verify"));
    else if (!bAbsoluteAvailable)
        Out->SetStringField(TEXT("target_click_status"), TEXT("no_clear_slate_click_path"));
    else if (!bWorldHitTested)
        Out->SetStringField(TEXT("target_click_status"), TEXT("world_visibility_not_tested"));
    else if (!bTargetIsFirstWorldHit)
        Out->SetStringField(TEXT("target_click_status"), TEXT("target_is_not_first_world_visibility_hit"));
    else
        Out->SetStringField(TEXT("target_click_status"), TEXT("verified"));
    if (!bAbsoluteAvailable)
        Out->SetStringField(TEXT("warning"), TEXT(
            "no currently hit-testable world click is available (offscreen/behind camera, hidden/minimized/stale PIE window, or Slate/UMG obstruction); do not guess absolute mouse coordinates"));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPPIEHandler::PIEClickActor(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader Reader(P, TEXT("editor_pie_click_actor"));
    const HaybaPIERuntimeOps::FActorInteractionRequest Request =
        HaybaPIERuntimeOps::ParseActorInteraction(Reader);
    if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());

    // Reuse the complete projection/Slate/Visibility proof. This call executes
    // synchronously on the game thread, so the world cannot tick between proof
    // and dispatch. The interaction surface therefore cannot drift to a subtly
    // different definition of "clickable" than editor_pie_project_world.
    FHaybaHandlerResult Proof = PIEProjectWorld(P);
    if (!Proof.bOk)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_click_actor: target proof failed: %s"), *Proof.ErrorMessage));
    }
    if (!Proof.Data.IsValid())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: target proof returned no data"));

    bool bTargetClickReady = false;
    if (!Proof.Data->TryGetBoolField(TEXT("target_click_ready"), bTargetClickReady) || !bTargetClickReady)
    {
        FString Status = TEXT("unverified");
        Proof.Data->TryGetStringField(TEXT("target_click_status"), Status);
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_click_actor: refused unverified target (%s)"), *Status));
    }

    TArray<FPIEWorldEntry> Worlds;
    FPIEWorldEntry* Selected = nullptr;
    HaybaPIERuntimeOps::FWorldSelection Selection;
    FString Error;
    if (!RuntimeSelectWorld(
            Request.Projection.World.PIEInstance,
            true,
            Worlds,
            Selected,
            Selection,
            Error))
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_click_actor: %s"), *Error));
    }

    AActor* TargetActor = ResolveRuntimeActor(Selected->World, Request.Projection.Actor, Error);
    if (!TargetActor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_click_actor: %s"), *Error));
    if (TargetActor->IsHidden())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: target actor is hidden"));

    UPrimitiveComponent* RequiredComponent = nullptr;
    if (!Request.Projection.ComponentName.IsEmpty())
    {
        UActorComponent* Component = ResolveOwnedRuntimeComponent(
            TargetActor, Request.Projection.ComponentName, Error);
        RequiredComponent = Cast<UPrimitiveComponent>(Component);
        if (!RequiredComponent)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("editor_pie_click_actor: target component is not a primitive component: %s"),
                *Request.Projection.ComponentName));
        }
        if (!RequiredComponent->IsRegistered()
            || !RequiredComponent->IsVisible()
            || RequiredComponent->bHiddenInGame)
        {
            return FHaybaHandlerResult::Err(TEXT(
                "editor_pie_click_actor: requested primitive component is hidden, unregistered, or not visible"));
        }
    }

    APlayerController* PlayerController = RuntimeLocalPlayerController(
        Selected->World, Request.Projection.PlayerIndex, Error);
    if (!PlayerController)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_pie_click_actor: %s"), *Error));

    UGameViewportClient* ViewportClient = Selected->World->GetGameViewport();
    if (!ViewportClient || !ViewportClient->Viewport)
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: selected PIE world lost its viewport"));
    if (ViewportClient->IgnoreInput())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: game viewport is currently ignoring input"));
    if (!PlayerController->PlayerInput)
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: local player has no PlayerInput"));
    if (PlayerController->CurrentClickTraceChannel != ECC_Visibility)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: player controller click trace channel is not Visibility; verified dispatch would not match native click targeting"));
    }

    if (!PlayerController->bEnableClickEvents)
    {
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: player controller click events are disabled"));
    }
    if (!PlayerController->ClickEventKeys.Contains(EKeys::LeftMouseButton)
        && !PlayerController->ClickEventKeys.Contains(EKeys::AnyKey))
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: LeftMouseButton is not enabled in player controller ClickEventKeys"));
    }

    const TSharedPtr<FJsonObject>* VisibilityHit = nullptr;
    FString HitActorPath;
    FString HitComponentPath;
    if (!Proof.Data->TryGetObjectField(TEXT("visibility_hit"), VisibilityHit)
        || !VisibilityHit || !VisibilityHit->IsValid()
        || !(*VisibilityHit)->TryGetStringField(TEXT("actor_path"), HitActorPath)
        || !(*VisibilityHit)->TryGetStringField(TEXT("component_path"), HitComponentPath))
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: verified Visibility hit lost its exact actor/component identity"));
    }

    UPrimitiveComponent* HitComponent = FindObject<UPrimitiveComponent>(nullptr, *HitComponentPath);
    if (!IsValid(HitComponent)
        || HitComponent->GetWorld() != Selected->World
        || HitComponent->GetOwner() != TargetActor
        || HitActorPath != TargetActor->GetPathName())
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: Visibility hit no longer belongs to the requested actor in the selected PIE world"));
    }
    if (RequiredComponent && HitComponent != RequiredComponent)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: requested component is not the first Visibility hit"));
    }
    if (!HitComponent->IsRegistered()
        || !HitComponent->IsVisible()
        || HitComponent->bHiddenInGame)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: first Visibility-hit component is hidden, unregistered, or not visible"));
    }

    const TSharedPtr<FJsonObject>* ViewportProof = nullptr;
    const TSharedPtr<FJsonObject>* AbsoluteProof = nullptr;
    double ViewportX = 0.0;
    double ViewportY = 0.0;
    double AbsoluteX = 0.0;
    double AbsoluteY = 0.0;
    if (!Proof.Data->TryGetObjectField(TEXT("viewport"), ViewportProof)
        || !ViewportProof || !ViewportProof->IsValid()
        || !(*ViewportProof)->TryGetNumberField(TEXT("x"), ViewportX)
        || !(*ViewportProof)->TryGetNumberField(TEXT("y"), ViewportY)
        || !Proof.Data->TryGetObjectField(TEXT("absolute"), AbsoluteProof)
        || !AbsoluteProof || !AbsoluteProof->IsValid()
        || !(*AbsoluteProof)->TryGetNumberField(TEXT("x"), AbsoluteX)
        || !(*AbsoluteProof)->TryGetNumberField(TEXT("y"), AbsoluteY))
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: verified target proof lost its exact viewport/absolute coordinates"));
    }
    const FVector2D ViewportPoint(ViewportX, ViewportY);
    const FVector2D AbsolutePoint(AbsoluteX, AbsoluteY);

    const FString TargetActorPath = TargetActor->GetPathName();
    const FString TargetComponentPath = HitComponent->GetPathName();
    const TWeakObjectPtr<UWorld> WeakWorld(Selected->World);
    const TWeakObjectPtr<AActor> WeakTargetActor(TargetActor);
    const TWeakObjectPtr<UPrimitiveComponent> WeakHitComponent(HitComponent);
    const TWeakObjectPtr<APlayerController> WeakPlayerController(PlayerController);

    // APlayerController::InputKey gives Canvas HUD hit boxes first refusal and
    // suppresses primitive clicks whenever any box is under the point. Probe
    // that public HUD surface without dispatching it; direct primitive dispatch
    // would otherwise click through Canvas UI that Slate cannot see.
    if (AHUD* HUD = PlayerController->GetHUD())
    {
        if (const FHUDHitBox* HUDHit = HUD->GetHitBoxAtCoordinates(ViewportPoint, false))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("editor_pie_click_actor: Canvas HUD hit box '%s' blocks the world target"),
                *HUDHit->GetName().ToString()));
        }
    }

    if (!FSlateApplication::IsInitialized())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: Slate is not initialized"));
    TSharedPtr<SViewport> ViewportWidget = ViewportClient->GetGameViewportWidget();
    FSceneViewport* SceneViewport = ViewportClient->GetGameViewport();
    if (!ViewportWidget.IsValid() || !SceneViewport)
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: live PIE scene viewport is unavailable"));
    if (ViewportWidget->HasMouseCapture())
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: refused while the PIE viewport has mouse capture"));

    FSlateApplication& Slate = FSlateApplication::Get();
    ULocalPlayer* CanonicalLocalPlayer = PlayerController->GetLocalPlayer();
    TSharedPtr<FSlateUser> LocalSlateUser = CanonicalLocalPlayer
        ? CanonicalLocalPlayer->GetSlateUser()
        : nullptr;
    if (!CanonicalLocalPlayer || !LocalSlateUser.IsValid())
        return FHaybaHandlerResult::Err(TEXT("editor_pie_click_actor: local player has no Slate user"));
    const FPlatformUserId CanonicalPlatformUser = CanonicalLocalPlayer->GetPlatformUserId();

    if (!Slate.GetPressedMouseButtons().IsEmpty()
        || PlayerController->IsInputKeyDown(EKeys::LeftMouseButton))
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: refused while another mouse gesture is already active"));
    }
    if (LocalSlateUser->HasCursorCapture()
        || LocalSlateUser->IsDragDropping())
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: refused while the selected Slate user has capture or drag state"));
    }

    // Exact click needs no synthetic pointer event. Locate the point to reject
    // Slate/UMG obstruction, but never call a Slate or scene-viewport mouse
    // route: UE's public move paths can recenter the desktop cursor through
    // private stale-capture state. Hover therefore fails during parsing.
    const FWidgetPath ProvenSlatePath = Slate.LocateWindowUnderMouse(
        AbsolutePoint,
        Slate.GetInteractiveTopLevelWindows(),
        /*bIgnoreEnabledStatus=*/false,
        LocalSlateUser->GetUserIndex());
    if (!ProvenSlatePath.IsValid()
        || !ProvenSlatePath.ContainsWidget(ViewportWidget.Get())
        || &ProvenSlatePath.GetLastWidget().Get() != ViewportWidget.Get())
    {
        return FHaybaHandlerResult::Err(TEXT(
            "editor_pie_click_actor: Slate/UMG obstruction appeared before interaction"));
    }

    // Slate routing and gameplay delegates are re-entrant. Every boundary
    // below re-establishes the complete contract from weak identities: exact
    // PIE/local player, live viewport, input policy, visible primitive, no UI
    // blocker, cached point, and first Visibility hit. Nothing relies on a raw
    // pointer surviving a callback.
    auto ValidateExactInteractionState = [&](const TCHAR* Stage, FString& OutFailure) -> bool
    {
        UWorld* CurrentWorld = WeakWorld.Get();
        AActor* CurrentActor = WeakTargetActor.Get();
        UPrimitiveComponent* CurrentComponent = WeakHitComponent.Get();
        APlayerController* CurrentController = WeakPlayerController.Get();
        if (!IsValid(CurrentWorld)
            || !IsValid(CurrentActor)
            || !IsValid(CurrentComponent)
            || !IsValid(CurrentController)
            || CurrentActor->IsActorBeingDestroyed())
        {
            OutFailure = FString::Printf(TEXT("%s: target, controller, or PIE world was destroyed"), Stage);
            return false;
        }
        if (CurrentActor->GetWorld() != CurrentWorld
            || CurrentComponent->GetWorld() != CurrentWorld
            || CurrentController->GetWorld() != CurrentWorld
            || CurrentComponent->GetOwner() != CurrentActor
            || CurrentActor->IsHidden()
            || !CurrentComponent->IsRegistered()
            || !CurrentComponent->IsVisible()
            || CurrentComponent->bHiddenInGame)
        {
            OutFailure = FString::Printf(TEXT("%s: exact actor/component is no longer visible and world-owned"), Stage);
            return false;
        }

        UGameInstance* CurrentGameInstance = CurrentWorld->GetGameInstance();
        ULocalPlayer* CurrentLocalPlayer = CurrentGameInstance
            ? CurrentGameInstance->GetLocalPlayerByIndex(Request.Projection.PlayerIndex)
            : nullptr;
        if (!CurrentLocalPlayer
            || CurrentLocalPlayer != CurrentController->GetLocalPlayer()
            || CurrentLocalPlayer->GetPlayerController(CurrentWorld) != CurrentController
            || CurrentLocalPlayer->GetSlateUser() != LocalSlateUser
            || CurrentLocalPlayer->GetPlatformUserId() != CanonicalPlatformUser)
        {
            OutFailure = FString::Printf(TEXT("%s: player_index no longer resolves to the same local player/controller"), Stage);
            return false;
        }

        UGameViewportClient* CurrentViewportClient = CurrentWorld->GetGameViewport();
        if (!CurrentViewportClient
            || CurrentViewportClient != ViewportClient
            || !CurrentViewportClient->Viewport
            || CurrentViewportClient->GetGameViewport() != SceneViewport
            || CurrentViewportClient->GetGameViewportWidget() != ViewportWidget
            || ViewportWidget->HasMouseCapture()
            || CurrentViewportClient->IgnoreInput()
            || !CurrentController->PlayerInput
            || CurrentController->CurrentClickTraceChannel != ECC_Visibility)
        {
            OutFailure = FString::Printf(TEXT("%s: viewport, PlayerInput, or Visibility click policy changed"), Stage);
            return false;
        }
        if (!CurrentController->bEnableClickEvents
            || (!CurrentController->ClickEventKeys.Contains(EKeys::LeftMouseButton)
                && !CurrentController->ClickEventKeys.Contains(EKeys::AnyKey))
            || !Slate.GetPressedMouseButtons().IsEmpty()
            || CurrentController->IsInputKeyDown(EKeys::LeftMouseButton)
            || LocalSlateUser->HasCursorCapture()
            || LocalSlateUser->IsDragDropping())
        {
            OutFailure = FString::Printf(TEXT("%s: controller input policy or active-gesture state changed"), Stage);
            return false;
        }

        const FWidgetPath CurrentSlatePath = Slate.LocateWindowUnderMouse(
            AbsolutePoint,
            Slate.GetInteractiveTopLevelWindows(),
            /*bIgnoreEnabledStatus=*/false,
            LocalSlateUser->GetUserIndex());
        if (!CurrentSlatePath.IsValid()
            || !CurrentSlatePath.ContainsWidget(ViewportWidget.Get())
            || &CurrentSlatePath.GetLastWidget().Get() != ViewportWidget.Get())
        {
            OutFailure = FString::Printf(TEXT("%s: Slate/UMG no longer routes the selected user directly to the viewport"), Stage);
            return false;
        }
        if (AHUD* CurrentHUD = CurrentController->GetHUD())
        {
            if (CurrentHUD->GetHitBoxAtCoordinates(ViewportPoint, false))
            {
                OutFailure = FString::Printf(TEXT("%s: a Canvas HUD hit box blocks the target"), Stage);
                return false;
            }
        }

        FHitResult CurrentHit;
        const bool bCurrentHit = CurrentController->GetHitResultAtScreenPosition(
            ViewportPoint, ECC_Visibility, true, CurrentHit);
        if (!bCurrentHit
            || !CurrentHit.bBlockingHit
            || CurrentHit.GetActor() != CurrentActor
            || CurrentHit.GetComponent() != CurrentComponent)
        {
            OutFailure = FString::Printf(TEXT("%s: first Visibility hit no longer matches the exact target"), Stage);
            return false;
        }
        return true;
    };

    FString RoutedFailure;
    if (!ValidateExactInteractionState(TEXT("after Slate routing"), RoutedFailure))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_pie_click_actor: %s; no gameplay event was dispatched"), *RoutedFailure));
    }
    TSharedPtr<FJsonObject> Dispatch = MakeShared<FJsonObject>();
    Dispatch->SetStringField(TEXT("path"),
        TEXT("verified APlayerController world-click stage -> UPrimitiveComponent::DispatchOnClicked/Released"));
    Dispatch->SetStringField(TEXT("player_controller_path"), PlayerController->GetPathName());
    Dispatch->SetStringField(TEXT("primitive_component_path"), TargetComponentPath);
    Dispatch->SetBoolField(TEXT("os_input_used"), false);
    Dispatch->SetBoolField(TEXT("desktop_cursor_moved"), false);
    Dispatch->SetBoolField(TEXT("pointer_routed"), false);

    bool bPressed = false;
    bool bReleased = false;
    bool bReleaseSent = false;
    bool bReleaseTargetStillMatches = false;
    FString ReleaseSuppressedReason;
    // APlayerController::InputKey cannot be made exact: it executes arbitrary
    // PlayerInput code before tracing and does not report which primitive it
    // eventually dispatched. Enter at the controller's native world-click
    // stage after proving every guard. DispatchOnClicked is the exact engine
    // call APlayerController uses, without an unchecked re-entrant trace.
    UPrimitiveComponent* PressComponent = WeakHitComponent.Get();
    PressComponent->DispatchOnClicked(EKeys::LeftMouseButton);
    bPressed = true;

    FString ReleaseFailure;
    bReleaseTargetStillMatches = ValidateExactInteractionState(
        TEXT("before release"), ReleaseFailure);
    if (bReleaseTargetStillMatches)
    {
        bReleaseSent = true;
        WeakHitComponent->DispatchOnReleased(EKeys::LeftMouseButton);
        bReleased = true;
    }
    else
    {
        ReleaseSuppressedReason = ReleaseFailure;
    }
    Dispatch->SetBoolField(TEXT("pressed"), bPressed);
    Dispatch->SetBoolField(TEXT("release_sent"), bReleaseSent);
    Dispatch->SetBoolField(TEXT("released"), bReleased);
    Dispatch->SetBoolField(TEXT("release_target_still_matches"), bReleaseTargetStillMatches);
    if (!ReleaseSuppressedReason.IsEmpty())
        Dispatch->SetStringField(TEXT("release_suppressed_reason"), ReleaseSuppressedReason);
    const bool bLeftMouseDownAfter = WeakPlayerController.IsValid()
        && WeakPlayerController->IsInputKeyDown(EKeys::LeftMouseButton);
    Dispatch->SetBoolField(TEXT("left_mouse_down_after"), bLeftMouseDownAfter);
    if (bLeftMouseDownAfter)
    {
        Dispatch->SetStringField(TEXT("warning"), TEXT(
            "LeftMouseButton remains down after release; stop PIE before further input"));
    }

    TSharedPtr<FJsonObject> Postcondition = MakeShared<FJsonObject>();
    const bool bTargetValidAfter = WeakTargetActor.IsValid()
        && WeakTargetActor->GetWorld() == Selected->World
        && !WeakTargetActor->IsActorBeingDestroyed();
    const bool bComponentValidAfter = WeakHitComponent.IsValid()
        && WeakHitComponent->GetWorld() == Selected->World;
    Postcondition->SetBoolField(TEXT("target_valid_after"), bTargetValidAfter);
    Postcondition->SetBoolField(TEXT("component_valid_after"), bComponentValidAfter);
    Postcondition->SetStringField(TEXT("target_actor_path_before"), TargetActorPath);
    Postcondition->SetStringField(TEXT("target_component_path_before"), TargetComponentPath);
    // Hayba can observe delivery and object lifetime generically. Selection/UI
    // state is application-specific and must be read back with the game's own
    // assertion or editor_pie_widget_tree rather than invented here.
    Postcondition->SetBoolField(TEXT("application_specific_state_observed"), false);

    Proof.Data->SetStringField(TEXT("action"), Request.Action);
    Proof.Data->SetObjectField(TEXT("dispatch"), Dispatch);
    Proof.Data->SetObjectField(TEXT("postcondition"), Postcondition);
    return FHaybaHandlerResult::Ok(Proof.Data);
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
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEActorList(const TSharedPtr<FJsonObject>&)  { return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEActorInspect(const TSharedPtr<FJsonObject>&){ return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEProjectWorld(const TSharedPtr<FJsonObject>&){ return FHaybaHandlerResult::Err(TEXT("editor-only")); }
FHaybaHandlerResult FHaybaMCPPIEHandler::PIEClickActor(const TSharedPtr<FJsonObject>&){ return FHaybaHandlerResult::Err(TEXT("editor-only")); }

#endif  // WITH_EDITOR
