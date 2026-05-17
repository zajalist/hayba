#include "HaybaMCPGASHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

#include "Abilities/GameplayAbility.h"
#include "AbilitySystemComponent.h"
#include "AbilitySystemInterface.h"
#include "GameplayEffect.h"
#include "GameplayEffectTypes.h"
#include "GameplayModMagnitudeCalculation.h"
#include "AttributeSet.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPGAS, Log, All);

TArray<FString> FHaybaMCPGASHandler::GetCommands() const
{
    return {
        TEXT("gas_create_ability"),
        TEXT("gas_grant_ability"),
        TEXT("gas_create_effect"),
        TEXT("gas_apply_effect")
    };
}

FHaybaHandlerResult FHaybaMCPGASHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("gas_create_ability")) return GasCreateAbility(P);
    if (Cmd == TEXT("gas_grant_ability"))  return GasGrantAbility(P);
    if (Cmd == TEXT("gas_create_effect"))  return GasCreateEffect(P);
    if (Cmd == TEXT("gas_apply_effect"))   return GasApplyEffect(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("GASHandler: unknown command %s"), *Cmd));
}

static AActor* GasFindActorInWorld(UWorld* World, const FString& NameOrPath)
{
    if (!World) return nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* A = *It;
        if (!A) continue;
        if (A->GetName() == NameOrPath) return A;
        if (A->GetPathName() == NameOrPath) return A;
        if (A->GetActorLabel() == NameOrPath) return A;
    }
    return nullptr;
}

static UAbilitySystemComponent* GasFindASC(AActor* Actor)
{
    if (!Actor) return nullptr;
    if (IAbilitySystemInterface* ASI = Cast<IAbilitySystemInterface>(Actor))
    {
        if (UAbilitySystemComponent* ASC = ASI->GetAbilitySystemComponent())
            return ASC;
    }
    return Actor->FindComponentByClass<UAbilitySystemComponent>();
}

FHaybaHandlerResult FHaybaMCPGASHandler::GasCreateAbility(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name;
    if (!P->TryGetStringField(TEXT("path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("gas_create_ability: missing path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("gas_create_ability: missing name"));

    const FString FullPkg = PkgPath / Name;
    UPackage* Package = CreatePackage(*FullPkg);
    if (!Package)
        return FHaybaHandlerResult::Err(TEXT("gas_create_ability: CreatePackage failed"));

    UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(
        UGameplayAbility::StaticClass(), Package, *Name, BPTYPE_Normal,
        UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
    if (!BP)
        return FHaybaHandlerResult::Err(TEXT("gas_create_ability: CreateBlueprint failed"));

    FAssetRegistryModule::AssetCreated(BP);
    Package->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BP->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPGASHandler::GasGrantAbility(const TSharedPtr<FJsonObject>& P)
{
    FString ActorPath, AbilityPath;
    int32 Level = 1;
    int32 InputId = -1;
    if (!P->TryGetStringField(TEXT("actor_path"), ActorPath))
        return FHaybaHandlerResult::Err(TEXT("gas_grant_ability: missing actor_path"));
    if (!P->TryGetStringField(TEXT("ability_path"), AbilityPath))
        return FHaybaHandlerResult::Err(TEXT("gas_grant_ability: missing ability_path"));
    P->TryGetNumberField(TEXT("level"), Level);
    P->TryGetNumberField(TEXT("input_id"), InputId);

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = GasFindActorInWorld(World, ActorPath);
    if (!Actor) return FHaybaHandlerResult::Err(FString::Printf(TEXT("gas_grant_ability: actor not found: %s"), *ActorPath));

    UAbilitySystemComponent* ASC = GasFindASC(Actor);
    if (!ASC) return FHaybaHandlerResult::Err(TEXT("gas_grant_ability: actor has no UAbilitySystemComponent"));

    UClass* AbilityClass = nullptr;
    if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AbilityPath))
    {
        AbilityClass = BP->GeneratedClass;
    }
    if (!AbilityClass)
    {
        AbilityClass = LoadClass<UGameplayAbility>(nullptr, *(AbilityPath + TEXT("_C")));
    }
    if (!AbilityClass || !AbilityClass->IsChildOf(UGameplayAbility::StaticClass()))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("gas_grant_ability: ability class not found: %s"), *AbilityPath));

    UGameplayAbility* CDO = AbilityClass->GetDefaultObject<UGameplayAbility>();
    FGameplayAbilitySpec Spec(CDO, Level, InputId);
    FGameplayAbilitySpecHandle Handle = ASC->GiveAbility(Spec);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("handle"), Handle.Handle);
    Out->SetStringField(TEXT("ability"), AbilityClass->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPGASHandler::GasCreateEffect(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name, DurationPolicy = TEXT("Instant");
    if (!P->TryGetStringField(TEXT("path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("gas_create_effect: missing path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("gas_create_effect: missing name"));
    P->TryGetStringField(TEXT("duration_policy"), DurationPolicy);

    const FString FullPkg = PkgPath / Name;
    UPackage* Package = CreatePackage(*FullPkg);
    if (!Package)
        return FHaybaHandlerResult::Err(TEXT("gas_create_effect: CreatePackage failed"));

    UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(
        UGameplayEffect::StaticClass(), Package, *Name, BPTYPE_Normal,
        UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
    if (!BP)
        return FHaybaHandlerResult::Err(TEXT("gas_create_effect: CreateBlueprint failed"));

    UClass* GenClass = BP->GeneratedClass;
    if (!GenClass)
        return FHaybaHandlerResult::Err(TEXT("gas_create_effect: BP missing GeneratedClass"));

    UGameplayEffect* CDO = GenClass->GetDefaultObject<UGameplayEffect>();
    if (!CDO)
        return FHaybaHandlerResult::Err(TEXT("gas_create_effect: CDO null"));

    // Duration policy
    if (DurationPolicy.Equals(TEXT("Duration"), ESearchCase::IgnoreCase))
    {
        CDO->DurationPolicy = EGameplayEffectDurationType::HasDuration;
        double DurSec = 0.0;
        if (P->TryGetNumberField(TEXT("duration_seconds"), DurSec))
        {
            FGameplayEffectModifierMagnitude DurMag(FScalableFloat((float)DurSec));
            CDO->DurationMagnitude = DurMag;
        }
    }
    else if (DurationPolicy.Equals(TEXT("Infinite"), ESearchCase::IgnoreCase))
    {
        CDO->DurationPolicy = EGameplayEffectDurationType::Infinite;
    }
    else
    {
        CDO->DurationPolicy = EGameplayEffectDurationType::Instant;
    }

    // Modifiers: [{ attribute: "AttributeSetClassPath.Property", op: "Additive|Multiplicative|Override", magnitude: 5.0 }]
    const TArray<TSharedPtr<FJsonValue>>* Mods = nullptr;
    if (P->TryGetArrayField(TEXT("modifiers"), Mods))
    {
        for (const TSharedPtr<FJsonValue>& V : *Mods)
        {
            const TSharedPtr<FJsonObject>* ModObj;
            if (!V->TryGetObject(ModObj) || !ModObj->IsValid()) continue;

            FString AttrPath, Op = TEXT("Additive");
            double Magnitude = 0.0;
            (*ModObj)->TryGetStringField(TEXT("attribute"), AttrPath);
            (*ModObj)->TryGetStringField(TEXT("op"), Op);
            (*ModObj)->TryGetNumberField(TEXT("magnitude"), Magnitude);

            FGameplayModifierInfo ModInfo;
            if (Op.Equals(TEXT("Multiplicative"), ESearchCase::IgnoreCase)) ModInfo.ModifierOp = EGameplayModOp::Multiplicitive;
            else if (Op.Equals(TEXT("Override"), ESearchCase::IgnoreCase)) ModInfo.ModifierOp = EGameplayModOp::Override;
            else if (Op.Equals(TEXT("Division"), ESearchCase::IgnoreCase)) ModInfo.ModifierOp = EGameplayModOp::Division;
            else ModInfo.ModifierOp = EGameplayModOp::Additive;

            ModInfo.ModifierMagnitude = FGameplayEffectModifierMagnitude(FScalableFloat((float)Magnitude));

            // attribute path expected like "/Script/MyModule.MyAttributeSet:Health"
            FGameplayAttribute Attribute;
            if (!AttrPath.IsEmpty())
            {
                FString ClassPart, PropPart;
                if (AttrPath.Split(TEXT(":"), &ClassPart, &PropPart))
                {
                    if (UClass* AttrClass = LoadClass<UAttributeSet>(nullptr, *ClassPart))
                    {
                        if (FProperty* Prop = FindFProperty<FProperty>(AttrClass, *PropPart))
                        {
                            Attribute = FGameplayAttribute(Prop);
                        }
                    }
                }
            }
            ModInfo.Attribute = Attribute;
            CDO->Modifiers.Add(ModInfo);
        }
    }

    CDO->MarkPackageDirty();
    BP->MarkPackageDirty();
    FAssetRegistryModule::AssetCreated(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BP->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    Out->SetStringField(TEXT("duration_policy"), DurationPolicy);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPGASHandler::GasApplyEffect(const TSharedPtr<FJsonObject>& P)
{
    FString ActorPath, EffectPath;
    double Level = 1.0;
    if (!P->TryGetStringField(TEXT("actor_path"), ActorPath))
        return FHaybaHandlerResult::Err(TEXT("gas_apply_effect: missing actor_path"));
    if (!P->TryGetStringField(TEXT("effect_path"), EffectPath))
        return FHaybaHandlerResult::Err(TEXT("gas_apply_effect: missing effect_path"));
    P->TryGetNumberField(TEXT("level"), Level);

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = GasFindActorInWorld(World, ActorPath);
    if (!Actor) return FHaybaHandlerResult::Err(FString::Printf(TEXT("gas_apply_effect: actor not found: %s"), *ActorPath));

    UAbilitySystemComponent* ASC = GasFindASC(Actor);
    if (!ASC) return FHaybaHandlerResult::Err(TEXT("gas_apply_effect: actor has no UAbilitySystemComponent"));

    UClass* EffectClass = nullptr;
    if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *EffectPath))
    {
        EffectClass = BP->GeneratedClass;
    }
    if (!EffectClass)
    {
        EffectClass = LoadClass<UGameplayEffect>(nullptr, *(EffectPath + TEXT("_C")));
    }
    if (!EffectClass || !EffectClass->IsChildOf(UGameplayEffect::StaticClass()))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("gas_apply_effect: effect class not found: %s"), *EffectPath));

    UGameplayEffect* EffectCDO = EffectClass->GetDefaultObject<UGameplayEffect>();

    FGameplayEffectContextHandle Context = ASC->MakeEffectContext();
    Context.AddSourceObject(Actor);

    FActiveGameplayEffectHandle ActiveHandle = ASC->ApplyGameplayEffectToSelf(EffectCDO, (float)Level, Context);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("active_handle"), ActiveHandle.IsValid() ? (double)GetTypeHash(ActiveHandle) : 0.0);
    Out->SetBoolField(TEXT("valid"), ActiveHandle.IsValid());
    Out->SetStringField(TEXT("effect"), EffectClass->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}
