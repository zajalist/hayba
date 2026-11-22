#include "HaybaMCPLightEdit.h"
#include "HaybaMCPModule.h"
#include "Components/LightComponent.h"
#include "Editor.h"
#include "Engine/Light.h"
#include "EngineUtils.h"
#include "Json.h"
#include "UObject/UnrealType.h"

namespace HaybaLightEdit
{
    static FString Identity(const ALight* Light)
    {
        static const FString EditorInstance = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        return Light->GetPathName() + TEXT("#") + Light->GetActorGuid().ToString(EGuidFormats::Digits) +
            TEXT("#") + LexToString(Light->GetLightComponent()->GetUniqueID()) + TEXT("#") + EditorInstance;
    }

    static TSharedRef<FJsonObject> Describe(ALight* Light)
    {
        const auto Row = MakeShared<FJsonObject>();
        Row->SetStringField(TEXT("id"), Identity(Light));
        Row->SetStringField(TEXT("actor_id"), Light->GetName());
        Row->SetStringField(TEXT("label"), Light->GetActorLabel());
        Row->SetStringField(TEXT("type"), Light->GetClass()->GetName());
        Row->SetNumberField(TEXT("intensity"), Light->GetLightComponent()->Intensity);
        return Row;
    }

    FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
    {
        if (Cmd == TEXT("lighting_review_status"))
        {
            FString Id;
            if (!P->TryGetStringField(TEXT("proposal_id"), Id) || Id.IsEmpty())
                return FHaybaHandlerResult::Err(TEXT("Missing review ID."));
            const auto* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit");
            const auto Out = MakeShared<FJsonObject>();
            const auto Matches = [&Id](const FHaybaExactExternalApproval& Approval) {
                return Approval.ProposalId == Id && Approval.Command == TEXT("lighting_set_intensity_checked") &&
                    FDateTime::UtcNow() < Approval.ExpiresAt;
            };
            Out->SetStringField(TEXT("status"), Module && Matches(Module->ApprovedExternalOperation) ? TEXT("approved") :
                Module && Matches(Module->PendingExternalOperation) ? TEXT("pending") : TEXT("closed"));
            return FHaybaHandlerResult::Ok(Out);
        }
        UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
        if (!World || GEditor->PlayWorld) return FHaybaHandlerResult::Err(TEXT("Open the level in edit mode before inspecting lights."));
        const bool bCatalog = Cmd == TEXT("lighting_list_loaded");
        FString First, Second;
        if (!bCatalog && (!P->TryGetStringField(TEXT("first"), First) || !P->TryGetStringField(TEXT("second"), Second) ||
            First.IsEmpty() || Second.IsEmpty() || First == Second))
            return FHaybaHandlerResult::Err(TEXT("Choose two distinct lights."));
        ALight* Pair[2] = {};
        TArray<TSharedPtr<FJsonValue>> Rows;
        for (TActorIterator<ALight> It(World); It; ++It)
        {
            ALight* Light = *It;
            if (!IsValid(Light) || !IsValid(Light->GetLightComponent()) || !FMath::IsFinite(Light->GetLightComponent()->Intensity)) continue;
            if (bCatalog) {
                if (Rows.Num() >= 1024) return FHaybaHandlerResult::Err(TEXT("More than 1024 loaded lights. Inspect two by their exact names in chat."));
                Rows.Add(MakeShared<FJsonValueObject>(Describe(Light)));
                continue;
            }
            const FString Id = Identity(Light);
            for (int32 Index = 0; Index < 2; ++Index)
            {
                const FString& Ref = Index == 0 ? First : Second;
                if (Id != Ref && Light->GetActorLabel() != Ref && Light->GetName() != Ref) continue;
                if (Pair[Index]) return FHaybaHandlerResult::Err(TEXT("Ambiguous light name. Select the two lights in the Lighting editor."));
                Pair[Index] = Light;
            }
        }
        const auto Out = MakeShared<FJsonObject>();
        if (!bCatalog)
        {
            if (!Pair[0] || !Pair[1] || Pair[0] == Pair[1]) return FHaybaHandlerResult::Err(TEXT("Both distinct lights must still be loaded in the same level."));
            if (Cmd == TEXT("lighting_set_intensity_checked"))
            {
                double Before, Other, Next;
                FString Target;
                if (Identity(Pair[0]) != First || Identity(Pair[1]) != Second ||
                    !P->TryGetStringField(TEXT("actor_id"), Target) || Pair[0]->GetName() != Target ||
                    !P->TryGetNumberField(TEXT("expected"), Before) || !P->TryGetNumberField(TEXT("other_expected"), Other) ||
                    !P->TryGetNumberField(TEXT("intensity"), Next) || !FMath::IsFinite(Next) || Next < 0 ||
                    Next > TNumericLimits<float>::Max() || static_cast<double>(static_cast<float>(Next)) != Next ||
                    Pair[0]->GetLightComponent()->Intensity != Before || Pair[1]->GetLightComponent()->Intensity != Other)
                    return FHaybaHandlerResult::Err(TEXT("The inspected lights or values changed. Inspect again before applying."));
                ULightComponent* Component = Pair[0]->GetLightComponent();
                FProperty* Property = FindFProperty<FProperty>(ULightComponentBase::StaticClass(), GET_MEMBER_NAME_CHECKED(ULightComponentBase, Intensity));
                if (!Property) return FHaybaHandlerResult::Err(TEXT("Intensity is unavailable."));
                Pair[0]->Modify();
                Component->Modify();
                Component->PreEditChange(Property);
                Component->Intensity = static_cast<float>(Next);
                FPropertyChangedEvent Change(Property, EPropertyChangeType::ValueSet);
                Component->PostEditChangeProperty(Change);
                // Construction scripts can recreate components during PostEditChangeProperty.
                if (!IsValid(Pair[0]) || !IsValid(Pair[0]->GetLightComponent()) || !IsValid(Pair[1]) || !IsValid(Pair[1]->GetLightComponent()))
                    return FHaybaHandlerResult::Err(TEXT("The editor reconstructed a light. Inspect the level before continuing."));
            }
            for (ALight* Light : Pair) Rows.Add(MakeShared<FJsonValueObject>(Describe(Light)));
        }
        Out->SetStringField(TEXT("map"), World->GetPackage()->GetName());
        Out->SetArrayField(TEXT("lights"), Rows);
        return FHaybaHandlerResult::Ok(Out);
    }
}
