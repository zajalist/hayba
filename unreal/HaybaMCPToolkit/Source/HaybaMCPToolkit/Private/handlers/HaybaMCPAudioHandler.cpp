#include "HaybaMCPAudioHandler.h"

#include "HaybaAudioOps.h"
#include "HaybaMCPAssetGuard.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPReflection.h"

#include "ActiveSound.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetToolsModule.h"
#include "AudioDevice.h"
#include "AudioDeviceManager.h"
#include "AudioMixerBlueprintLibrary.h"
#include "AudioMixerDevice.h"
#include "Components/AudioComponent.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "EditorAssetLibrary.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Factories/SoundAttenuationFactory.h"
#include "Factories/SoundClassFactory.h"
#include "Factories/SoundConcurrencyFactory.h"
#include "Factories/SoundMixFactory.h"
#include "Factories/SoundSubmixFactory.h"
#include "HAL/FileManager.h"
#include "Kismet/GameplayStatics.h"
#include "JsonObjectConverter.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Sound/SampleBufferIO.h"
#include "Sound/SoundAttenuation.h"
#include "Sound/SoundBase.h"
#include "Sound/SoundClass.h"
#include "Sound/SoundConcurrency.h"
#include "Sound/SoundEffectSubmix.h"
#include "Sound/SoundMix.h"
#include "Sound/SoundSubmix.h"
#include "Sound/SoundWave.h"
#include "UObject/SoftObjectPath.h"

namespace
{
    using HaybaAudioOps::EAssetType;

    UWorld* ActiveAudioWorld()
    {
        if (GEditor && GEditor->PlayWorld) return GEditor->PlayWorld;
        if (GEngine)
        {
            for (const FWorldContext& Context : GEngine->GetWorldContexts())
            {
                if (Context.WorldType == EWorldType::PIE && Context.World()) return Context.World();
            }
        }
        if (GEditor)
        {
            if (UWorld* World = GEditor->GetEditorWorldContext().World()) return World;
        }
        return GWorld;
    }

    FString WorldKind(const UWorld* World)
    {
        if (!World) return TEXT("none");
        return World->WorldType == EWorldType::PIE ? TEXT("pie") : TEXT("editor");
    }

    UObject* LoadAudioObject(const FString& Path)
    {
        return FSoftObjectPath(HaybaAudioOps::NormalizeObjectPath(Path)).TryLoad();
    }

    template<typename T>
    T* LoadAudioAsset(const FString& Path)
    {
        return Cast<T>(LoadAudioObject(Path));
    }

    FString ObjectPath(const UObject* Object)
    {
        return Object ? Object->GetPathName() : FString();
    }

    TSharedPtr<FJsonValue> JString(const FString& Value)
    {
        return MakeShared<FJsonValueString>(Value);
    }

    TArray<TSharedPtr<FJsonValue>> StringArray(const TArray<FString>& Values)
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        Result.Reserve(Values.Num());
        for (const FString& Value : Values) Result.Add(JString(Value));
        return Result;
    }

    FString EnumName(const UEnum* Enum, const int64 Value)
    {
        return Enum ? Enum->GetNameStringByValue(Value) : FString::FromInt(static_cast<int32>(Value));
    }

    FString PlayStateName(const EAudioComponentPlayState State)
    {
        if (const UEnum* Enum = StaticEnum<EAudioComponentPlayState>()) return Enum->GetNameStringByValue(static_cast<int64>(State));
        return FString::FromInt(static_cast<int32>(State));
    }

    FString SampleRateQualityName(const ESoundwaveSampleRateSettings Value)
    {
        switch (Value)
        {
        case ESoundwaveSampleRateSettings::Max: return TEXT("Max");
        case ESoundwaveSampleRateSettings::High: return TEXT("High");
        case ESoundwaveSampleRateSettings::Medium: return TEXT("Medium");
        case ESoundwaveSampleRateSettings::Low: return TEXT("Low");
        case ESoundwaveSampleRateSettings::Min: return TEXT("Min");
        default: return TEXT("Unknown");
        }
    }

    FString RecordingKey(const USoundSubmix* Submix)
    {
        return Submix ? Submix->GetPathName() : TEXT("<master>");
    }

    USoundSubmix* OptionalSubmix(const TSharedPtr<FJsonObject>& P, FString& OutError)
    {
        FString Path;
        if (!P.IsValid() || !P->TryGetStringField(TEXT("submix_path"), Path) || Path.IsEmpty()) return nullptr;
        USoundSubmix* Submix = LoadAudioAsset<USoundSubmix>(Path);
        if (!Submix) OutError = FString::Printf(TEXT("could not load SoundSubmix: %s"), *Path);
        return Submix;
    }

    TSharedPtr<FJsonObject> SoundClassSnapshot(const USoundClass* Asset)
    {
        const FSoundClassProperties& S = Asset->Properties;
        auto Out = MakeShared<FJsonObject>();
        Out->SetNumberField(TEXT("volume"), S.Volume);
        Out->SetNumberField(TEXT("pitch"), S.Pitch);
        Out->SetNumberField(TEXT("low_pass_filter_frequency"), S.LowPassFilterFrequency);
        Out->SetNumberField(TEXT("attenuation_distance_scale"), S.AttenuationDistanceScale);
        Out->SetBoolField(TEXT("always_play"), S.bAlwaysPlay);
        Out->SetBoolField(TEXT("is_ui_sound"), S.bIsUISound);
        Out->SetBoolField(TEXT("is_music"), S.bIsMusic);
        Out->SetBoolField(TEXT("apply_ambient_volumes"), S.bApplyAmbientVolumes);
        Out->SetBoolField(TEXT("reverb"), S.bReverb);
        Out->SetNumberField(TEXT("default_2d_reverb_send_amount"), S.Default2DReverbSendAmount);
        Out->SetStringField(TEXT("default_submix"), ObjectPath(S.DefaultSubmix));
        Out->SetStringField(TEXT("parent_sound_class"), ObjectPath(Asset->ParentClass));
        TArray<TSharedPtr<FJsonValue>> Children;
        for (const USoundClass* Child : Asset->ChildClasses) Children.Add(JString(ObjectPath(Child)));
        Out->SetArrayField(TEXT("child_sound_classes"), Children);
        return Out;
    }

    TSharedPtr<FJsonObject> SoundMixSnapshot(const USoundMix* Asset)
    {
        auto Out = MakeShared<FJsonObject>();
        Out->SetNumberField(TEXT("initial_delay"), Asset->InitialDelay);
        Out->SetNumberField(TEXT("fade_in_time"), Asset->FadeInTime);
        Out->SetNumberField(TEXT("duration"), Asset->Duration);
        Out->SetNumberField(TEXT("fade_out_time"), Asset->FadeOutTime);
        Out->SetBoolField(TEXT("apply_eq"), Asset->bApplyEQ);
        Out->SetNumberField(TEXT("eq_priority"), Asset->EQPriority);
        TArray<TSharedPtr<FJsonValue>> Overrides;
        for (const FSoundClassAdjuster& A : Asset->SoundClassEffects)
        {
            auto Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("sound_class_path"), ObjectPath(A.SoundClassObject));
            Entry->SetNumberField(TEXT("volume"), A.VolumeAdjuster);
            Entry->SetNumberField(TEXT("pitch"), A.PitchAdjuster);
            Entry->SetNumberField(TEXT("low_pass_filter_frequency"), A.LowPassFilterFrequency);
            Entry->SetBoolField(TEXT("apply_to_children"), A.bApplyToChildren);
            Entry->SetNumberField(TEXT("voice_center_channel_volume"), A.VoiceCenterChannelVolumeAdjuster);
            Overrides.Add(MakeShared<FJsonValueObject>(Entry));
        }
        Out->SetArrayField(TEXT("class_overrides"), Overrides);
        return Out;
    }

    TSharedPtr<FJsonObject> ConcurrencySnapshot(const USoundConcurrency* Asset)
    {
        const FSoundConcurrencySettings& S = Asset->Concurrency;
        auto Out = MakeShared<FJsonObject>();
        Out->SetNumberField(TEXT("max_count"), S.GetMaxCount());
        Out->SetBoolField(TEXT("limit_to_owner"), S.bLimitToOwner);
        Out->SetStringField(TEXT("resolution_rule"), EnumName(StaticEnum<EMaxConcurrentResolutionRule::Type>(), S.ResolutionRule));
        Out->SetNumberField(TEXT("retrigger_time"), S.RetriggerTime);
        Out->SetNumberField(TEXT("volume_scale"), S.GetVolumeScale());
        Out->SetStringField(TEXT("volume_scale_mode"), EnumName(StaticEnum<EConcurrencyVolumeScaleMode>(), static_cast<int64>(S.VolumeScaleMode)));
        Out->SetNumberField(TEXT("volume_scale_attack_time"), S.VolumeScaleAttackTime);
        Out->SetNumberField(TEXT("volume_scale_release_time"), S.VolumeScaleReleaseTime);
        Out->SetNumberField(TEXT("voice_steal_release_time"), S.VoiceStealReleaseTime);
        Out->SetBoolField(TEXT("volume_scale_can_release"), S.bVolumeScaleCanRelease);
        return Out;
    }

    TSharedPtr<FJsonObject> AttenuationSnapshot(const USoundAttenuation* Asset)
    {
        const FSoundAttenuationSettings& S = Asset->Attenuation;
        auto Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("attenuate"), S.bAttenuate);
        Out->SetBoolField(TEXT("spatialize"), S.bSpatialize);
        Out->SetStringField(TEXT("distance_model"), EnumName(StaticEnum<EAttenuationDistanceModel>(), static_cast<int64>(S.DistanceAlgorithm)));
        Out->SetStringField(TEXT("attenuation_shape"), EnumName(StaticEnum<EAttenuationShape::Type>(), S.AttenuationShape));
        auto Extents = MakeShared<FJsonObject>();
        Extents->SetNumberField(TEXT("x"), S.AttenuationShapeExtents.X);
        Extents->SetNumberField(TEXT("y"), S.AttenuationShapeExtents.Y);
        Extents->SetNumberField(TEXT("z"), S.AttenuationShapeExtents.Z);
        Out->SetObjectField(TEXT("shape_extents"), Extents);
        Out->SetNumberField(TEXT("falloff_distance"), S.FalloffDistance);
        Out->SetBoolField(TEXT("air_absorption"), S.bAttenuateWithLPF);
        Out->SetBoolField(TEXT("listener_focus"), S.bEnableListenerFocus);
        Out->SetBoolField(TEXT("occlusion"), S.bEnableOcclusion);
        Out->SetBoolField(TEXT("complex_occlusion"), S.bUseComplexCollisionForOcclusion);
        Out->SetBoolField(TEXT("reverb_send"), S.bEnableReverbSend);
        return Out;
    }

    TSharedPtr<FJsonObject> SubmixSnapshot(const USoundSubmix* Asset)
    {
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("parent_submix"), ObjectPath(Asset->ParentSubmix));
        Out->SetBoolField(TEXT("auto_disable"), Asset->bAutoDisable);
        Out->SetNumberField(TEXT("auto_disable_time"), Asset->AutoDisableTime);
        Out->SetBoolField(TEXT("mute_when_backgrounded"), Asset->bMuteWhenBackgrounded);
        Out->SetNumberField(TEXT("envelope_attack_ms"), Asset->EnvelopeFollowerAttackTime);
        Out->SetNumberField(TEXT("envelope_release_ms"), Asset->EnvelopeFollowerReleaseTime);
        TArray<TSharedPtr<FJsonValue>> Effects;
        for (const UObject* Effect : Asset->SubmixEffectChain) Effects.Add(JString(ObjectPath(Effect)));
        Out->SetArrayField(TEXT("effect_chain"), Effects);
        TArray<TSharedPtr<FJsonValue>> Children;
        for (const UObject* Child : Asset->ChildSubmixes) Children.Add(JString(ObjectPath(Child)));
        Out->SetArrayField(TEXT("child_submixes"), Children);
        return Out;
    }

    TSharedPtr<FJsonObject> SoundWaveSnapshot(const USoundWave* Asset)
    {
        auto Out = MakeShared<FJsonObject>();
        Out->SetNumberField(TEXT("duration_seconds"), Asset->GetDuration());
        Out->SetNumberField(TEXT("sample_rate"), Asset->GetSampleRateForCurrentPlatform());
        Out->SetNumberField(TEXT("imported_sample_rate"), Asset->GetImportedSampleRate());
        Out->SetNumberField(TEXT("channels"), Asset->NumChannels);
        Out->SetNumberField(TEXT("compression_quality"), Asset->GetCompressionQuality());
        Out->SetStringField(TEXT("compression_type"), EnumName(StaticEnum<ESoundAssetCompressionType>(), static_cast<int64>(Asset->GetSoundAssetCompressionTypeEnum())));
        Out->SetStringField(TEXT("sample_rate_quality"), SampleRateQualityName(Asset->SampleRateQuality));
        Out->SetStringField(TEXT("loading_behavior"), EnumName(StaticEnum<ESoundWaveLoadingBehavior>(), static_cast<int64>(Asset->LoadingBehavior)));
        Out->SetBoolField(TEXT("looping"), Asset->bLooping);
        Out->SetNumberField(TEXT("volume"), Asset->Volume);
        Out->SetNumberField(TEXT("pitch"), Asset->Pitch);
        Out->SetStringField(TEXT("sound_class"), ObjectPath(Asset->SoundClassObject));
        Out->SetStringField(TEXT("attenuation"), ObjectPath(Asset->AttenuationSettings));
        Out->SetStringField(TEXT("base_submix"), ObjectPath(Asset->SoundSubmixObject));
        TArray<TSharedPtr<FJsonValue>> Concurrency;
        for (const USoundConcurrency* C : Asset->ConcurrencySet) Concurrency.Add(JString(ObjectPath(C)));
        Out->SetArrayField(TEXT("concurrency"), Concurrency);
        return Out;
    }

    EAssetType TypeOf(const UObject* Object)
    {
        if (Object->IsA<USoundClass>()) return EAssetType::SoundClass;
        if (Object->IsA<USoundMix>()) return EAssetType::SoundMix;
        if (Object->IsA<USoundConcurrency>()) return EAssetType::SoundConcurrency;
        if (Object->IsA<USoundAttenuation>()) return EAssetType::SoundAttenuation;
        if (Object->IsA<USoundSubmix>()) return EAssetType::SoundSubmix;
        if (Object->IsA<USoundWave>()) return EAssetType::SoundWave;
        return EAssetType::Unsupported;
    }

    TSharedPtr<FJsonObject> Snapshot(const UObject* Object)
    {
        if (const auto* A = Cast<USoundClass>(Object)) return SoundClassSnapshot(A);
        if (const auto* A = Cast<USoundMix>(Object)) return SoundMixSnapshot(A);
        if (const auto* A = Cast<USoundConcurrency>(Object)) return ConcurrencySnapshot(A);
        if (const auto* A = Cast<USoundAttenuation>(Object)) return AttenuationSnapshot(A);
        if (const auto* A = Cast<USoundSubmix>(Object)) return SubmixSnapshot(A);
        if (const auto* A = Cast<USoundWave>(Object)) return SoundWaveSnapshot(A);
        return MakeShared<FJsonObject>();
    }

    TSharedPtr<FJsonObject> AssetEnvelope(const UObject* Object)
    {
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Object->GetPathName());
        Out->SetStringField(TEXT("asset_type"), HaybaAudioOps::AssetTypeName(TypeOf(Object)));
        Out->SetBoolField(TEXT("dirty"), Object->GetOutermost()->IsDirty());
        Out->SetObjectField(TEXT("settings"), Snapshot(Object));
        return Out;
    }

    UFactory* FactoryFor(const EAssetType Type)
    {
        switch (Type)
        {
        case EAssetType::SoundClass: return NewObject<USoundClassFactory>();
        case EAssetType::SoundMix: return NewObject<USoundMixFactory>();
        case EAssetType::SoundConcurrency: return NewObject<USoundConcurrencyFactory>();
        case EAssetType::SoundAttenuation: return NewObject<USoundAttenuationFactory>();
        case EAssetType::SoundSubmix: return NewObject<USoundSubmixFactory>();
        default: return nullptr;
        }
    }

    UClass* ClassFor(const EAssetType Type)
    {
        switch (Type)
        {
        case EAssetType::SoundClass: return USoundClass::StaticClass();
        case EAssetType::SoundMix: return USoundMix::StaticClass();
        case EAssetType::SoundConcurrency: return USoundConcurrency::StaticClass();
        case EAssetType::SoundAttenuation: return USoundAttenuation::StaticClass();
        case EAssetType::SoundSubmix: return USoundSubmix::StaticClass();
        default: return nullptr;
        }
    }

    const TMap<FString, FString>& StructMapping(const EAssetType Type)
    {
        static const TMap<FString, FString> SoundClass = {
            {TEXT("volume"), TEXT("Volume")}, {TEXT("pitch"), TEXT("Pitch")},
            {TEXT("low_pass_filter_frequency"), TEXT("LowPassFilterFrequency")},
            {TEXT("attenuation_distance_scale"), TEXT("AttenuationDistanceScale")},
            {TEXT("always_play"), TEXT("bAlwaysPlay")}, {TEXT("is_ui_sound"), TEXT("bIsUISound")},
            {TEXT("is_music"), TEXT("bIsMusic")}, {TEXT("apply_ambient_volumes"), TEXT("bApplyAmbientVolumes")},
            {TEXT("reverb"), TEXT("bReverb")},
            {TEXT("default_2d_reverb_send_amount"), TEXT("Default2DReverbSendAmount")},
            {TEXT("default_submix"), TEXT("DefaultSubmix")},
        };
        static const TMap<FString, FString> Concurrency = {
            {TEXT("max_count"), TEXT("MaxCount")}, {TEXT("limit_to_owner"), TEXT("bLimitToOwner")},
            {TEXT("resolution_rule"), TEXT("ResolutionRule")}, {TEXT("retrigger_time"), TEXT("RetriggerTime")},
            {TEXT("volume_scale"), TEXT("VolumeScale")}, {TEXT("volume_scale_mode"), TEXT("VolumeScaleMode")},
            {TEXT("volume_scale_attack_time"), TEXT("VolumeScaleAttackTime")},
            {TEXT("volume_scale_release_time"), TEXT("VolumeScaleReleaseTime")},
            {TEXT("voice_steal_release_time"), TEXT("VoiceStealReleaseTime")},
            {TEXT("volume_scale_can_release"), TEXT("bVolumeScaleCanRelease")},
        };
        static const TMap<FString, FString> Attenuation = {
            {TEXT("attenuate"), TEXT("bAttenuate")}, {TEXT("spatialize"), TEXT("bSpatialize")},
            {TEXT("distance_model"), TEXT("DistanceAlgorithm")}, {TEXT("attenuation_shape"), TEXT("AttenuationShape")},
            {TEXT("falloff_distance"), TEXT("FalloffDistance")},
            {TEXT("air_absorption"), TEXT("bAttenuateWithLPF")}, {TEXT("listener_focus"), TEXT("bEnableListenerFocus")},
            {TEXT("occlusion"), TEXT("bEnableOcclusion")}, {TEXT("complex_occlusion"), TEXT("bUseComplexCollisionForOcclusion")},
            {TEXT("reverb_send"), TEXT("bEnableReverbSend")},
        };
        static const TMap<FString, FString> Empty;
        if (Type == EAssetType::SoundClass) return SoundClass;
        if (Type == EAssetType::SoundConcurrency) return Concurrency;
        if (Type == EAssetType::SoundAttenuation) return Attenuation;
        return Empty;
    }

    const TMap<FString, FString>& ObjectMapping(const EAssetType Type)
    {
        static const TMap<FString, FString> Mix = {
            {TEXT("initial_delay"), TEXT("InitialDelay")}, {TEXT("fade_in_time"), TEXT("FadeInTime")},
            {TEXT("duration"), TEXT("Duration")}, {TEXT("fade_out_time"), TEXT("FadeOutTime")},
            {TEXT("apply_eq"), TEXT("bApplyEQ")}, {TEXT("eq_priority"), TEXT("EQPriority")},
        };
        static const TMap<FString, FString> Submix = {
            {TEXT("auto_disable"), TEXT("bAutoDisable")}, {TEXT("auto_disable_time"), TEXT("AutoDisableTime")},
            {TEXT("mute_when_backgrounded"), TEXT("bMuteWhenBackgrounded")},
            {TEXT("envelope_attack_ms"), TEXT("EnvelopeFollowerAttackTime")},
            {TEXT("envelope_release_ms"), TEXT("EnvelopeFollowerReleaseTime")},
        };
        static const TMap<FString, FString> Wave = {
            {TEXT("compression_quality"), TEXT("CompressionQuality")},
            {TEXT("compression_type"), TEXT("SoundAssetCompressionType")},
            {TEXT("sample_rate_quality"), TEXT("SampleRateQuality")},
            {TEXT("loading_behavior"), TEXT("LoadingBehavior")},
            {TEXT("looping"), TEXT("bLooping")}, {TEXT("volume"), TEXT("Volume")},
            {TEXT("pitch"), TEXT("Pitch")},
        };
        static const TMap<FString, FString> Empty;
        if (Type == EAssetType::SoundMix) return Mix;
        if (Type == EAssetType::SoundSubmix) return Submix;
        if (Type == EAssetType::SoundWave) return Wave;
        return Empty;
    }

    TSet<FString> AllowedKeys(const EAssetType Type)
    {
        TSet<FString> Keys;
        for (const auto& Pair : StructMapping(Type)) Keys.Add(Pair.Key);
        for (const auto& Pair : ObjectMapping(Type)) Keys.Add(Pair.Key);
        if (Type == EAssetType::SoundClass) Keys.Add(TEXT("parent_sound_class"));
        if (Type == EAssetType::SoundClass) Keys.Add(TEXT("default_submix"));
        if (Type == EAssetType::SoundMix) Keys.Add(TEXT("class_overrides"));
        if (Type == EAssetType::SoundAttenuation) Keys.Add(TEXT("shape_extents"));
        if (Type == EAssetType::SoundSubmix)
        {
            Keys.Add(TEXT("parent_submix"));
            Keys.Add(TEXT("effect_chain"));
        }
        if (Type == EAssetType::SoundWave)
        {
            Keys.Add(TEXT("sound_class"));
            Keys.Add(TEXT("attenuation"));
            Keys.Add(TEXT("base_submix"));
            Keys.Add(TEXT("concurrency"));
        }
        return Keys;
    }

    template<typename T>
    bool ParseNullableAudioRef(const TSharedPtr<FJsonValue>& Value, const FString& Setting,
        T*& Out, FString& Error)
    {
        Out = nullptr;
        if (!Value.IsValid() || Value->Type == EJson::Null) return true;
        if (Value->Type != EJson::String || Value->AsString().IsEmpty())
        {
            Error = FString::Printf(TEXT("%s must be a non-empty asset path or null"), *Setting);
            return false;
        }
        Out = LoadAudioAsset<T>(Value->AsString());
        if (!Out)
        {
            Error = FString::Printf(TEXT("%s did not resolve to %s: %s"),
                *Setting, *T::StaticClass()->GetName(), *Value->AsString());
            return false;
        }
        return true;
    }

    template<typename T>
    bool ParseAudioRefArray(const TSharedPtr<FJsonValue>& Value, const FString& Setting,
        TArray<TObjectPtr<T>>& Out, FString& Error)
    {
        if (!Value.IsValid() || Value->Type != EJson::Array)
        {
            Error = FString::Printf(TEXT("%s must be an array"), *Setting);
            return false;
        }
        for (int32 Index = 0; Index < Value->AsArray().Num(); ++Index)
        {
            const TSharedPtr<FJsonValue>& Item = Value->AsArray()[Index];
            if (!Item.IsValid() || Item->Type != EJson::String || Item->AsString().IsEmpty())
            {
                Error = FString::Printf(TEXT("%s[%d] must be a non-empty asset path"), *Setting, Index);
                return false;
            }
            T* Asset = LoadAudioAsset<T>(Item->AsString());
            if (!Asset)
            {
                Error = FString::Printf(TEXT("%s[%d] did not resolve to %s: %s"),
                    *Setting, Index, *T::StaticClass()->GetName(), *Item->AsString());
                return false;
            }
            Out.Add(Asset);
        }
        return true;
    }

    bool EqualJson(const TSharedPtr<FJsonValue>& A, const TSharedPtr<FJsonValue>& B)
    {
        FString SA;
        FString SB;
        const TSharedRef<TJsonWriter<>> WA = TJsonWriterFactory<>::Create(&SA);
        const TSharedRef<TJsonWriter<>> WB = TJsonWriterFactory<>::Create(&SB);
        FJsonSerializer::Serialize(A, TEXT(""), WA);
        FJsonSerializer::Serialize(B, TEXT(""), WB);
        WA->Close();
        WB->Close();
        return SA == SB;
    }

    TSharedPtr<FJsonValue> PropertyJson(FProperty* Property, const void* Container)
    {
        if (!Property || !Container) return nullptr;
        return FJsonObjectConverter::UPropertyToJsonValue(
            Property, Property->ContainerPtrToValuePtr<void>(Container), 0, 0);
    }

    bool ApplyObjectProperty(UObject* Asset, const FString& PropertyName, const TSharedPtr<FJsonValue>& Value, bool& OutChanged)
    {
        FProperty* Property = Asset->GetClass()->FindPropertyByName(FName(*PropertyName));
        if (!Property) return false;
        const TSharedPtr<FJsonValue> Before = PropertyJson(Property, Asset);
        if (!HaybaReflection::SetValueFromJson(Property, Asset, Value, Asset)) return false;
        const TSharedPtr<FJsonValue> After = PropertyJson(Property, Asset);
        OutChanged = !EqualJson(Before, After);
        return true;
    }

    bool ApplyStructProperty(UScriptStruct* Struct, void* StructPtr, const FString& PropertyName,
        const TSharedPtr<FJsonValue>& Value, bool& OutChanged)
    {
        FProperty* Property = Struct->FindPropertyByName(FName(*PropertyName));
        if (!Property) return false;
        const TSharedPtr<FJsonValue> Before = PropertyJson(Property, StructPtr);
        if (!HaybaReflection::SetValueFromJson(Property, StructPtr, Value, nullptr)) return false;
        const TSharedPtr<FJsonValue> After = PropertyJson(Property, StructPtr);
        OutChanged = !EqualJson(Before, After);
        return true;
    }

    bool ParseMixOverrides(const TSharedPtr<FJsonValue>& Value, TArray<FSoundClassAdjuster>& Out, FString& Error)
    {
        if (!Value.IsValid() || Value->Type != EJson::Array)
        {
            Error = TEXT("class_overrides must be an array");
            return false;
        }
        for (int32 Index = 0; Index < Value->AsArray().Num(); ++Index)
        {
            const TSharedPtr<FJsonValue>& Item = Value->AsArray()[Index];
            if (!Item.IsValid() || Item->Type != EJson::Object)
            {
                Error = FString::Printf(TEXT("class_overrides[%d] must be an object"), Index);
                return false;
            }
            const TSharedPtr<FJsonObject>& Obj = Item->AsObject();
            FString Path;
            if (!Obj->TryGetStringField(TEXT("sound_class_path"), Path) || Path.IsEmpty())
            {
                Error = FString::Printf(TEXT("class_overrides[%d].sound_class_path is required"), Index);
                return false;
            }
            USoundClass* Class = LoadAudioAsset<USoundClass>(Path);
            if (!Class)
            {
                Error = FString::Printf(TEXT("class_overrides[%d] could not load SoundClass: %s"), Index, *Path);
                return false;
            }
            FSoundClassAdjuster Adjuster;
            Adjuster.SoundClassObject = Class;
            double Number = 0.0;
            bool Flag = false;
            if (Obj->TryGetNumberField(TEXT("volume"), Number)) Adjuster.VolumeAdjuster = static_cast<float>(Number);
            if (Obj->TryGetNumberField(TEXT("pitch"), Number)) Adjuster.PitchAdjuster = static_cast<float>(Number);
            if (Obj->TryGetNumberField(TEXT("low_pass_filter_frequency"), Number)) Adjuster.LowPassFilterFrequency = static_cast<float>(Number);
            if (Obj->TryGetBoolField(TEXT("apply_to_children"), Flag)) Adjuster.bApplyToChildren = Flag;
            if (Obj->TryGetNumberField(TEXT("voice_center_channel_volume"), Number)) Adjuster.VoiceCenterChannelVolumeAdjuster = static_cast<float>(Number);
            Out.Add(Adjuster);
        }
        return true;
    }

    bool MixOverridesEqual(const TArray<FSoundClassAdjuster>& A, const TArray<FSoundClassAdjuster>& B)
    {
        if (A.Num() != B.Num()) return false;
        for (int32 I = 0; I < A.Num(); ++I)
        {
            if (A[I].SoundClassObject != B[I].SoundClassObject
                || A[I].VolumeAdjuster != B[I].VolumeAdjuster
                || A[I].PitchAdjuster != B[I].PitchAdjuster
                || A[I].LowPassFilterFrequency != B[I].LowPassFilterFrequency
                || A[I].bApplyToChildren != B[I].bApplyToChildren
                || A[I].VoiceCenterChannelVolumeAdjuster != B[I].VoiceCenterChannelVolumeAdjuster) return false;
        }
        return true;
    }

    FHaybaHandlerResult AudioAssetCreate(const TSharedPtr<FJsonObject>& P)
    {
        if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("audio_asset_create: missing params"));
        FString Path;
        FString TypeText;
        FHaybaParamReader Reader(P, TEXT("audio_asset_create"));
        Path = Reader.RequiredString(TEXT("path"));
        TypeText = Reader.RequiredString(TEXT("asset_type"));
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());

        const EAssetType Type = HaybaAudioOps::ParseAssetType(TypeText);
        if (Type == EAssetType::SoundWave)
            return FHaybaHandlerResult::Err(TEXT("audio_asset_create: SoundWave creation requires imported PCM data; use asset_import, then audio_asset_set"));
        UClass* Class = ClassFor(Type);
        UFactory* Factory = FactoryFor(Type);
        if (!Class || !Factory)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_create: unsupported asset_type '%s'"), *TypeText));

        const HaybaAudioOps::FAssetTarget Target = HaybaAudioOps::ResolveAssetTarget(Path);
        if (!Target.IsValid()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_create: %s"), *Target.Error));
        if (HaybaAssetGuard::AssetNameTaken(Target.Directory, Target.AssetName))
            return FHaybaHandlerResult::Err(HaybaAssetGuard::NameTakenError(TEXT("audio_asset_create"), Target.Directory, Target.AssetName));

        IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
        UObject* Asset = AssetTools.CreateAsset(Target.AssetName, Target.Directory, Class, Factory);
        if (!Asset) return FHaybaHandlerResult::Err(TEXT("audio_asset_create: AssetTools.CreateAsset returned null"));
        Asset->Modify();
        Asset->MarkPackageDirty();

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("asset_type"), HaybaAudioOps::AssetTypeName(Type));
        Out->SetStringField(TEXT("persistence"), TEXT("dirty_in_memory"));
        Out->SetObjectField(TEXT("readback"), AssetEnvelope(Asset));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult AudioAssetInspect(const TSharedPtr<FJsonObject>& P)
    {
        FString Path;
        FHaybaParamReader Reader(P, TEXT("audio_asset_inspect"));
        Path = Reader.RequiredString(TEXT("path"));
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        UObject* Asset = LoadAudioObject(Path);
        if (!Asset) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_inspect: could not load %s"), *Path));
        if (TypeOf(Asset) == EAssetType::Unsupported)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_inspect: %s is %s, not a supported audio settings asset"), *Asset->GetPathName(), *Asset->GetClass()->GetName()));
        return FHaybaHandlerResult::Ok(AssetEnvelope(Asset));
    }

    FHaybaHandlerResult AudioAssetSet(const TSharedPtr<FJsonObject>& P)
    {
        FString Path;
        FHaybaParamReader Reader(P, TEXT("audio_asset_set"));
        Path = Reader.RequiredString(TEXT("path"));
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        const TSharedPtr<FJsonObject>* Settings = nullptr;
        if (!P->TryGetObjectField(TEXT("settings"), Settings) || !Settings || !Settings->IsValid() || (*Settings)->Values.Num() == 0)
            return FHaybaHandlerResult::Err(TEXT("audio_asset_set: settings must be a non-empty object"));

        UObject* Asset = LoadAudioObject(Path);
        if (!Asset) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: could not load %s"), *Path));
        const EAssetType Type = TypeOf(Asset);
        if (Type == EAssetType::Unsupported)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: unsupported asset class %s"), *Asset->GetClass()->GetName()));

        const TSet<FString> Allowed = AllowedKeys(Type);
        TArray<FString> Unknown;
        for (const auto& Pair : (*Settings)->Values)
        {
            const FString Key(Pair.Key);
            if (!Allowed.Contains(Key)) Unknown.Add(Key);
        }
        if (Unknown.Num() > 0)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: settings not valid for %s: %s"),
                *HaybaAudioOps::AssetTypeName(Type), *FString::Join(Unknown, TEXT(", "))));

        // Preflight every referenced asset before touching the target, so one
        // bad path cannot leave a half-applied settings object.
        USoundClass* NewParentClass = nullptr;
        USoundSubmixBase* NewParentSubmix = nullptr;
        USoundSubmix* NewDefaultSubmix = nullptr;
        USoundClass* NewWaveSoundClass = nullptr;
        USoundAttenuation* NewWaveAttenuation = nullptr;
        USoundSubmixBase* NewWaveSubmix = nullptr;
        FVector NewShapeExtents = FVector::ZeroVector;
        TArray<FSoundClassAdjuster> NewOverrides;
        TArray<TObjectPtr<USoundEffectSubmixPreset>> NewEffectChain;
        TSet<TObjectPtr<USoundConcurrency>> NewConcurrencySet;
        FString PreflightError;
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("parent_sound_class")))
        {
            if ((*V)->Type != EJson::Null)
            {
                NewParentClass = LoadAudioAsset<USoundClass>((*V)->AsString());
                if (!NewParentClass) return FHaybaHandlerResult::Err(TEXT("audio_asset_set: parent_sound_class did not resolve to a SoundClass"));
                if (NewParentClass == Asset) return FHaybaHandlerResult::Err(TEXT("audio_asset_set: a SoundClass cannot parent itself"));
            }
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("parent_submix")))
        {
            if ((*V)->Type != EJson::Null)
            {
                NewParentSubmix = Cast<USoundSubmixBase>(HaybaReflection::ResolveObjectRef(*V));
                if (!NewParentSubmix) return FHaybaHandlerResult::Err(TEXT("audio_asset_set: parent_submix did not resolve to a SoundSubmixBase"));
                if (NewParentSubmix == Asset) return FHaybaHandlerResult::Err(TEXT("audio_asset_set: a SoundSubmix cannot parent itself"));
            }
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("class_overrides")))
        {
            FString Error;
            if (!ParseMixOverrides(*V, NewOverrides, Error))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *Error));
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("default_submix")))
        {
            if (!ParseNullableAudioRef<USoundSubmix>(*V, TEXT("default_submix"), NewDefaultSubmix, PreflightError))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *PreflightError));
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("sound_class")))
        {
            if (!ParseNullableAudioRef<USoundClass>(*V, TEXT("sound_class"), NewWaveSoundClass, PreflightError))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *PreflightError));
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("attenuation")))
        {
            if (!ParseNullableAudioRef<USoundAttenuation>(*V, TEXT("attenuation"), NewWaveAttenuation, PreflightError))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *PreflightError));
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("base_submix")))
        {
            if (!ParseNullableAudioRef<USoundSubmixBase>(*V, TEXT("base_submix"), NewWaveSubmix, PreflightError))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *PreflightError));
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("effect_chain")))
        {
            if (!ParseAudioRefArray<USoundEffectSubmixPreset>(*V, TEXT("effect_chain"), NewEffectChain, PreflightError))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *PreflightError));
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("concurrency")))
        {
            TArray<TObjectPtr<USoundConcurrency>> ConcurrencyArray;
            if (!ParseAudioRefArray<USoundConcurrency>(*V, TEXT("concurrency"), ConcurrencyArray, PreflightError))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: %s"), *PreflightError));
            for (USoundConcurrency* Concurrency : ConcurrencyArray) NewConcurrencySet.Add(Concurrency);
        }
        if (const TSharedPtr<FJsonValue>* V = (*Settings)->Values.Find(TEXT("shape_extents")))
        {
            if (!V->IsValid() || (*V)->Type != EJson::Object)
                return FHaybaHandlerResult::Err(TEXT("audio_asset_set: shape_extents must be an object"));
            const TSharedPtr<FJsonObject>& Extents = (*V)->AsObject();
            double X = 0.0;
            double Y = 0.0;
            double Z = 0.0;
            if (!Extents->TryGetNumberField(TEXT("x"), X))
                return FHaybaHandlerResult::Err(TEXT("audio_asset_set: shape_extents.x is required"));
            Extents->TryGetNumberField(TEXT("y"), Y);
            Extents->TryGetNumberField(TEXT("z"), Z);
            if (!FMath::IsFinite(X) || !FMath::IsFinite(Y) || !FMath::IsFinite(Z) || X < 0.0 || Y < 0.0 || Z < 0.0)
                return FHaybaHandlerResult::Err(TEXT("audio_asset_set: shape_extents values must be finite and non-negative"));
            NewShapeExtents = FVector(X, Y, Z);
        }

        Asset->Modify();
        TArray<FString> Changed;
        TArray<FString> Unchanged;
        auto Record = [&](const FString& Key, const bool bChanged) { (bChanged ? Changed : Unchanged).Add(Key); };

        for (const auto& Pair : (*Settings)->Values)
        {
            const FString Key(Pair.Key);
            if (Key == TEXT("parent_sound_class"))
            {
                USoundClass* SoundClass = CastChecked<USoundClass>(Asset);
                const bool bChanged = SoundClass->ParentClass != NewParentClass;
                if (bChanged)
                {
                    if (SoundClass->ParentClass)
                    {
                        SoundClass->ParentClass->Modify();
                        SoundClass->ParentClass->ChildClasses.Remove(SoundClass);
                        SoundClass->ParentClass->MarkPackageDirty();
                    }
                    SoundClass->ParentClass = NewParentClass;
                    if (NewParentClass)
                    {
                        NewParentClass->Modify();
                        NewParentClass->ChildClasses.AddUnique(SoundClass);
                        NewParentClass->MarkPackageDirty();
                    }
                }
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("parent_submix"))
            {
                USoundSubmix* Submix = CastChecked<USoundSubmix>(Asset);
                const bool bChanged = Submix->ParentSubmix != NewParentSubmix;
                if (bChanged) Submix->SetParentSubmix(NewParentSubmix, true);
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("class_overrides"))
            {
                USoundMix* Mix = CastChecked<USoundMix>(Asset);
                const bool bChanged = !MixOverridesEqual(Mix->SoundClassEffects, NewOverrides);
                if (bChanged) Mix->SoundClassEffects = NewOverrides;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("default_submix"))
            {
                USoundClass* SoundClass = CastChecked<USoundClass>(Asset);
                const bool bChanged = SoundClass->Properties.DefaultSubmix != NewDefaultSubmix;
                if (bChanged) SoundClass->Properties.DefaultSubmix = NewDefaultSubmix;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("shape_extents"))
            {
                FSoundAttenuationSettings& Attenuation = CastChecked<USoundAttenuation>(Asset)->Attenuation;
                const bool bChanged = Attenuation.AttenuationShapeExtents != NewShapeExtents;
                if (bChanged) Attenuation.AttenuationShapeExtents = NewShapeExtents;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("effect_chain"))
            {
                USoundSubmix* Submix = CastChecked<USoundSubmix>(Asset);
                const bool bChanged = Submix->SubmixEffectChain != NewEffectChain;
                if (bChanged) Submix->SubmixEffectChain = NewEffectChain;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("sound_class"))
            {
                USoundWave* Wave = CastChecked<USoundWave>(Asset);
                const bool bChanged = Wave->SoundClassObject != NewWaveSoundClass;
                if (bChanged) Wave->SoundClassObject = NewWaveSoundClass;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("attenuation"))
            {
                USoundWave* Wave = CastChecked<USoundWave>(Asset);
                const bool bChanged = Wave->AttenuationSettings != NewWaveAttenuation;
                if (bChanged) Wave->AttenuationSettings = NewWaveAttenuation;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("base_submix"))
            {
                USoundWave* Wave = CastChecked<USoundWave>(Asset);
                const bool bChanged = Wave->SoundSubmixObject != NewWaveSubmix;
                if (bChanged) Wave->SoundSubmixObject = NewWaveSubmix;
                Record(Key, bChanged);
                continue;
            }
            if (Key == TEXT("concurrency"))
            {
                USoundWave* Wave = CastChecked<USoundWave>(Asset);
                bool bChanged = Wave->ConcurrencySet.Num() != NewConcurrencySet.Num();
                if (!bChanged)
                {
                    for (const TObjectPtr<USoundConcurrency>& Concurrency : NewConcurrencySet)
                    {
                        if (!Wave->ConcurrencySet.Contains(Concurrency))
                        {
                            bChanged = true;
                            break;
                        }
                    }
                }
                if (bChanged) Wave->ConcurrencySet = NewConcurrencySet;
                Record(Key, bChanged);
                continue;
            }

            bool bChanged = false;
            bool bApplied = false;
            if (const FString* PropertyName = StructMapping(Type).Find(Key))
            {
                if (Type == EAssetType::SoundClass)
                {
                    bApplied = ApplyStructProperty(FSoundClassProperties::StaticStruct(), &CastChecked<USoundClass>(Asset)->Properties, *PropertyName, Pair.Value, bChanged);
                }
                else if (Type == EAssetType::SoundConcurrency)
                {
                    bApplied = ApplyStructProperty(FSoundConcurrencySettings::StaticStruct(), &CastChecked<USoundConcurrency>(Asset)->Concurrency, *PropertyName, Pair.Value, bChanged);
                }
                else if (Type == EAssetType::SoundAttenuation)
                {
                    bApplied = ApplyStructProperty(FSoundAttenuationSettings::StaticStruct(), &CastChecked<USoundAttenuation>(Asset)->Attenuation, *PropertyName, Pair.Value, bChanged);
                }
            }
            else if (const FString* ObjectPropertyName = ObjectMapping(Type).Find(Key))
            {
                bApplied = ApplyObjectProperty(Asset, *ObjectPropertyName, Pair.Value, bChanged);
            }
            if (!bApplied)
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_set: failed to apply %s; no changes after this key were attempted"), *Key));
            Record(Key, bChanged);
        }

        if (Changed.Num() > 0)
        {
            Asset->PostEditChange();
            Asset->MarkPackageDirty();
        }

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("asset_type"), HaybaAudioOps::AssetTypeName(Type));
        Out->SetArrayField(TEXT("changed_keys"), StringArray(Changed));
        Out->SetArrayField(TEXT("unchanged_keys"), StringArray(Unchanged));
        Out->SetStringField(TEXT("persistence"), Changed.Num() > 0 ? TEXT("dirty_in_memory") : TEXT("unchanged"));
        Out->SetObjectField(TEXT("readback"), Snapshot(Asset));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult AudioAssetSave(const TSharedPtr<FJsonObject>& P)
    {
        FString Path;
        FHaybaParamReader Reader(P, TEXT("audio_asset_save"));
        Path = Reader.RequiredString(TEXT("path"));
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        UObject* Asset = LoadAudioObject(Path);
        if (!Asset) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_save: could not load %s"), *Path));
        if (TypeOf(Asset) == EAssetType::Unsupported)
            return FHaybaHandlerResult::Err(TEXT("audio_asset_save: target is not a supported audio settings asset"));

        if (!UEditorAssetLibrary::SaveLoadedAsset(Asset, false))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_save: SaveLoadedAsset failed for %s"), *Asset->GetPathName()));

        const FString PackageName = Asset->GetOutermost()->GetName();
        FString Filename;
        if (!FPackageName::DoesPackageExist(PackageName, &Filename) || !IFileManager::Get().FileExists(*Filename))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_asset_save: save returned true but no package file exists for %s"), *PackageName));

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("package_file"), FPaths::ConvertRelativePathToFull(Filename));
        Out->SetStringField(TEXT("persistence"), TEXT("saved_to_disk"));
        Out->SetObjectField(TEXT("readback"), AssetEnvelope(Asset));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult AudioList(const TSharedPtr<FJsonObject>& P)
    {
        FString Prefix;
        if (P.IsValid()) P->TryGetStringField(TEXT("path_prefix"), Prefix);
        FAssetRegistryModule& RegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
        TArray<FAssetData> Assets;
        RegistryModule.Get().GetAssetsByClass(USoundBase::StaticClass()->GetClassPathName(), Assets, true);

        TArray<TSharedPtr<FJsonValue>> Items;
        for (const FAssetData& Data : Assets)
        {
            const FString Path = Data.GetObjectPathString();
            if (!Prefix.IsEmpty() && !Path.StartsWith(Prefix)) continue;
            auto Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("path"), Path);
            Entry->SetStringField(TEXT("name"), Data.AssetName.ToString());
            Entry->SetStringField(TEXT("class"), Data.AssetClassPath.GetAssetName().ToString());
            FString Duration;
            FString SampleRate;
            if (Data.GetTagValue(TEXT("Duration"), Duration)) Entry->SetNumberField(TEXT("duration_seconds"), FCString::Atod(*Duration));
            if (Data.GetTagValue(TEXT("SampleRate"), SampleRate)) Entry->SetNumberField(TEXT("sample_rate"), FCString::Atoi(*SampleRate));
            Items.Add(MakeShared<FJsonValueObject>(Entry));
        }
        auto Out = MakeShared<FJsonObject>();
        Out->SetArrayField(TEXT("sounds"), Items);
        Out->SetNumberField(TEXT("count"), Items.Num());
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult ComponentPlay(const TSharedPtr<FJsonObject>& P,
        TMap<FString, TWeakObjectPtr<UAudioComponent>>& Components, const FString& Command)
    {
        FString Path;
        FHaybaParamReader Reader(P, Command);
        Path = Reader.RequiredString(TEXT("path"));
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        USoundBase* Sound = LoadAudioAsset<USoundBase>(Path);
        if (!Sound) return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: could not load USoundBase %s"), *Command, *Path));
        UWorld* World = ActiveAudioWorld();
        if (!World) return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: no active editor or PIE world"), *Command));

        double Volume = 1.0;
        double Pitch = 1.0;
        double StartTime = 0.0;
        P->TryGetNumberField(TEXT("volume"), Volume);
        P->TryGetNumberField(TEXT("pitch"), Pitch);
        P->TryGetNumberField(TEXT("start_time"), StartTime);
        if (Volume < 0.0 || Pitch <= 0.0 || StartTime < 0.0)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: volume/start_time must be >= 0 and pitch must be > 0"), *Command));

        USoundConcurrency* Concurrency = nullptr;
        FString ConcurrencyPath;
        if (P->TryGetStringField(TEXT("concurrency_path"), ConcurrencyPath) && !ConcurrencyPath.IsEmpty())
        {
            Concurrency = LoadAudioAsset<USoundConcurrency>(ConcurrencyPath);
            if (!Concurrency) return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: could not load SoundConcurrency %s"), *Command, *ConcurrencyPath));
        }
        UAudioComponent* Component = UGameplayStatics::SpawnSound2D(
            World, Sound, static_cast<float>(Volume), static_cast<float>(Pitch),
            static_cast<float>(StartTime), Concurrency, false, false);
        if (!Component) return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: SpawnSound2D returned null"), *Command));
        if (!Component->IsPlaying())
        {
            Component->Stop();
            Component->DestroyComponent();
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: component was created but playback did not become active (check concurrency/audio device)"), *Command));
        }

        const FString Id = LexToString(Component->GetAudioComponentID());
        Components.Add(Id, Component);
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("component_id"), Id);
        Out->SetStringField(TEXT("sound_path"), Sound->GetPathName());
        Out->SetStringField(TEXT("world"), WorldKind(World));
        Out->SetStringField(TEXT("play_state"), PlayStateName(Component->GetPlayState()));
        Out->SetNumberField(TEXT("volume"), Component->VolumeMultiplier);
        Out->SetNumberField(TEXT("pitch"), Component->PitchMultiplier);
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult ComponentControl(const TSharedPtr<FJsonObject>& P,
        TMap<FString, TWeakObjectPtr<UAudioComponent>>& Components)
    {
        FString Id;
        FString Action;
        FHaybaParamReader Reader(P, TEXT("audio_component_control"));
        Id = Reader.RequiredString(TEXT("component_id"));
        Action = Reader.RequiredString(TEXT("action")).ToLower();
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        const TWeakObjectPtr<UAudioComponent>* Found = Components.Find(Id);
        UAudioComponent* Component = Found ? Found->Get() : nullptr;
        if (!IsValid(Component))
        {
            Components.Remove(Id);
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_component_control: unknown or expired component_id %s"), *Id));
        }

        double Duration = 0.0;
        double Level = 1.0;
        double StartTime = 0.0;
        P->TryGetNumberField(TEXT("duration"), Duration);
        P->TryGetNumberField(TEXT("level"), Level);
        P->TryGetNumberField(TEXT("start_time"), StartTime);
        if (Duration < 0.0 || Level < 0.0 || StartTime < 0.0)
            return FHaybaHandlerResult::Err(TEXT("audio_component_control: duration, level, and start_time must be >= 0"));

        if (Action == TEXT("play")) Component->Play(static_cast<float>(StartTime));
        else if (Action == TEXT("stop")) Component->Stop();
        else if (Action == TEXT("pause")) Component->SetPaused(true);
        else if (Action == TEXT("resume")) Component->SetPaused(false);
        else if (Action == TEXT("fade_in")) Component->FadeIn(static_cast<float>(Duration), static_cast<float>(Level), static_cast<float>(StartTime));
        else if (Action == TEXT("fade_out")) Component->FadeOut(static_cast<float>(Duration), static_cast<float>(Level));
        else if (Action == TEXT("set_volume")) Component->SetVolumeMultiplier(static_cast<float>(Level));
        else if (Action == TEXT("set_pitch")) Component->SetPitchMultiplier(static_cast<float>(Level));
        else if (Action == TEXT("reset_parameters")) Component->ResetParameters();
        else if (Action == TEXT("set_parameter"))
        {
            FString Name;
            FString Type;
            if (!P->TryGetStringField(TEXT("parameter_name"), Name) || Name.IsEmpty())
                return FHaybaHandlerResult::Err(TEXT("audio_component_control: set_parameter requires parameter_name"));
            if (!P->TryGetStringField(TEXT("parameter_type"), Type) || Type.IsEmpty())
                return FHaybaHandlerResult::Err(TEXT("audio_component_control: set_parameter requires parameter_type (float|int|bool|wave|trigger)"));
            Type = Type.ToLower();
            const TSharedPtr<FJsonValue> Value = P->TryGetField(TEXT("parameter_value"));
            if (Type == TEXT("float") && Value.IsValid()) Component->SetFloatParameter(FName(*Name), static_cast<float>(Value->AsNumber()));
            else if (Type == TEXT("int") && Value.IsValid()) Component->SetIntParameter(FName(*Name), static_cast<int32>(Value->AsNumber()));
            else if (Type == TEXT("bool") && Value.IsValid()) Component->SetBoolParameter(FName(*Name), Value->AsBool());
            else if (Type == TEXT("wave") && Value.IsValid())
            {
                USoundWave* Wave = LoadAudioAsset<USoundWave>(Value->AsString());
                if (!Wave) return FHaybaHandlerResult::Err(TEXT("audio_component_control: wave parameter_value did not resolve to a SoundWave"));
                Component->SetWaveParameter(FName(*Name), Wave);
            }
            else if (Type == TEXT("trigger")) Component->SetTriggerParameter(FName(*Name));
            else return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_component_control: invalid or missing value for parameter_type %s"), *Type));
        }
        else return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_component_control: unknown action %s"), *Action));

        if ((Action == TEXT("play") || Action == TEXT("fade_in")) && !Component->IsPlaying())
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_component_control: %s dispatched but component is not playing"), *Action));

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("component_id"), Id);
        Out->SetStringField(TEXT("action_applied"), Action);
        Out->SetStringField(TEXT("play_state"), PlayStateName(Component->GetPlayState()));
        Out->SetNumberField(TEXT("volume"), Component->VolumeMultiplier);
        Out->SetNumberField(TEXT("pitch"), Component->PitchMultiplier);
        Out->SetBoolField(TEXT("virtualized"), Component->IsVirtualized());
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult ActiveSounds(const TSharedPtr<FJsonObject>& P,
        TMap<FString, TWeakObjectPtr<UAudioComponent>>& Components)
    {
        if (!GEngine) return FHaybaHandlerResult::Err(TEXT("audio_active_sounds: GEngine is unavailable"));
        FAudioDeviceHandle Device = GEngine->GetMainAudioDevice();
        if (!Device.IsValid()) return FHaybaHandlerResult::Err(TEXT("audio_active_sounds: no main audio device"));
        bool bIncludePreview = false;
        int32 Limit = 256;
        if (P.IsValid())
        {
            P->TryGetBoolField(TEXT("include_preview"), bIncludePreview);
            P->TryGetNumberField(TEXT("limit"), Limit);
        }
        Limit = FMath::Clamp(Limit, 1, 2048);

        TArray<TSharedPtr<FJsonValue>> Sounds;
        int32 VirtualCount = 0;
        for (const FActiveSound* Active : Device->GetActiveSounds())
        {
            if (!Active || (!bIncludePreview && Active->IsPreviewSound())) continue;
            if (Sounds.Num() >= Limit) break;
            auto Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("sound_path"), ObjectPath(Active->GetSound()));
            Entry->SetStringField(TEXT("component_id"), LexToString(Active->GetAudioComponentID()));
            Entry->SetNumberField(TEXT("instance_id"), Active->GetInstanceID());
            Entry->SetNumberField(TEXT("volume"), Active->GetVolume());
            Entry->SetNumberField(TEXT("pitch"), Active->GetPitch());
            Entry->SetBoolField(TEXT("looping"), Active->IsLooping());
            Entry->SetBoolField(TEXT("playing_audio"), Active->IsPlayingAudio());
            Entry->SetBoolField(TEXT("paused"), Active->bIsPaused);
            Entry->SetStringField(TEXT("owner"), Active->GetOwnerName());
            Entry->SetStringField(TEXT("component"), Active->GetAudioComponentName());
            if (!Active->IsPlayingAudio()) ++VirtualCount;
            Sounds.Add(MakeShared<FJsonValueObject>(Entry));
        }
        for (auto It = Components.CreateIterator(); It; ++It) if (!It.Value().IsValid()) It.RemoveCurrent();

        auto Out = MakeShared<FJsonObject>();
        Out->SetNumberField(TEXT("active_sound_count"), Sounds.Num());
        Out->SetNumberField(TEXT("active_voice_count"), Device->GetNumActiveSources());
        Out->SetNumberField(TEXT("virtual_sound_count"), VirtualCount);
        Out->SetNumberField(TEXT("managed_component_count"), Components.Num());
        Out->SetBoolField(TEXT("truncated"), Sounds.Num() >= Limit);
        Out->SetArrayField(TEXT("sounds"), Sounds);
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult MeterStart(const TSharedPtr<FJsonObject>& P, TSet<FString>& Active)
    {
        UWorld* World = ActiveAudioWorld();
        if (!World) return FHaybaHandlerResult::Err(TEXT("audio_meter_start: no active world"));
        if (!FAudioDeviceManager::GetAudioMixerDeviceFromWorldContext(World))
            return FHaybaHandlerResult::Err(TEXT("audio_meter_start: current audio device is not an Audio Mixer device"));
        FString Error;
        USoundSubmix* Submix = OptionalSubmix(P, Error);
        if (!Error.IsEmpty()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_start: %s"), *Error));
        const FString Key = RecordingKey(Submix);
        if (Active.Contains(Key)) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_start: analyzer already active for %s"), *Key));

        FString FFT = TEXT("medium");
        if (P.IsValid()) P->TryGetStringField(TEXT("fft_size"), FFT);
        FFT = FFT.ToLower();
        EFFTSize Size = EFFTSize::Medium;
        if (FFT == TEXT("min")) Size = EFFTSize::Min;
        else if (FFT == TEXT("small")) Size = EFFTSize::Small;
        else if (FFT == TEXT("medium")) Size = EFFTSize::Medium;
        else if (FFT == TEXT("large")) Size = EFFTSize::Large;
        else if (FFT == TEXT("very_large")) Size = EFFTSize::VeryLarge;
        else if (FFT == TEXT("max")) Size = EFFTSize::Max;
        else return FHaybaHandlerResult::Err(TEXT("audio_meter_start: fft_size must be min|small|medium|large|very_large|max"));

        UAudioMixerBlueprintLibrary::StartAnalyzingOutput(World, Submix, Size);
        Active.Add(Key);
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("submix"), Key);
        Out->SetStringField(TEXT("fft_size"), FFT);
        Out->SetStringField(TEXT("analyzer_state"), TEXT("started"));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult MeterRead(const TSharedPtr<FJsonObject>& P, const TSet<FString>& Active)
    {
        UWorld* World = ActiveAudioWorld();
        if (!World) return FHaybaHandlerResult::Err(TEXT("audio_meter_read: no active world"));
        FString Error;
        USoundSubmix* Submix = OptionalSubmix(P, Error);
        if (!Error.IsEmpty()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_read: %s"), *Error));
        const FString Key = RecordingKey(Submix);
        if (!Active.Contains(Key)) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_read: no analyzer active for %s; call audio_meter_start first"), *Key));
        const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
        if (!P->TryGetArrayField(TEXT("frequencies_hz"), Values) || !Values || Values->Num() == 0)
            return FHaybaHandlerResult::Err(TEXT("audio_meter_read: frequencies_hz must be a non-empty array"));
        if (Values->Num() > 256) return FHaybaHandlerResult::Err(TEXT("audio_meter_read: frequencies_hz is capped at 256 bins"));
        TArray<float> Frequencies;
        for (int32 Index = 0; Index < Values->Num(); ++Index)
        {
            const double Frequency = (*Values)[Index]->AsNumber();
            if (Frequency <= 0.0 || Frequency > 24000.0)
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_read: frequencies_hz[%d] must be in (0, 24000]"), Index));
            Frequencies.Add(static_cast<float>(Frequency));
        }
        TArray<float> Magnitudes;
        TArray<float> Phases;
        UAudioMixerBlueprintLibrary::GetMagnitudeForFrequencies(World, Frequencies, Magnitudes, Submix);
        UAudioMixerBlueprintLibrary::GetPhaseForFrequencies(World, Frequencies, Phases, Submix);
        if (Magnitudes.Num() != Frequencies.Num())
            return FHaybaHandlerResult::Err(TEXT("audio_meter_read: Audio Mixer returned no spectral data; wait at least one audio render block after start"));

        bool bHasMeasuredEnergy = false;
        for (int32 Index = 0; Index < Magnitudes.Num(); ++Index)
        {
            if (!FMath::IsFinite(Magnitudes[Index]) || Magnitudes[Index] < 0.0f)
                return FHaybaHandlerResult::Err(TEXT("audio_meter_read: Audio Mixer returned invalid spectral magnitudes"));
            if (Phases.IsValidIndex(Index) && !FMath::IsFinite(Phases[Index]))
                return FHaybaHandlerResult::Err(TEXT("audio_meter_read: Audio Mixer returned invalid spectral phases"));
            bHasMeasuredEnergy |= Magnitudes[Index] > SMALL_NUMBER;
        }
        if (!bHasMeasuredEnergy)
            return FHaybaHandlerResult::Err(
                TEXT("audio_meter_read: analyzer returned only zero bins; no measurable output is available for this world/submix"));

        TArray<TSharedPtr<FJsonValue>> Bins;
        for (int32 Index = 0; Index < Frequencies.Num(); ++Index)
        {
            auto Bin = MakeShared<FJsonObject>();
            const float Magnitude = Magnitudes[Index];
            Bin->SetNumberField(TEXT("frequency_hz"), Frequencies[Index]);
            Bin->SetNumberField(TEXT("magnitude_linear"), Magnitude);
            Bin->SetNumberField(TEXT("magnitude_db"), 20.0f * FMath::LogX(10.0f, FMath::Max(Magnitude, 1.e-8f)));
            if (Phases.IsValidIndex(Index)) Bin->SetNumberField(TEXT("phase_radians"), Phases[Index]);
            Bins.Add(MakeShared<FJsonValueObject>(Bin));
        }
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("submix"), Key);
        Out->SetStringField(TEXT("analyzer_state"), TEXT("running"));
        Out->SetArrayField(TEXT("bins"), Bins);
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult MeterStop(const TSharedPtr<FJsonObject>& P, TSet<FString>& Active)
    {
        UWorld* World = ActiveAudioWorld();
        if (!World) return FHaybaHandlerResult::Err(TEXT("audio_meter_stop: no active world"));
        FString Error;
        USoundSubmix* Submix = OptionalSubmix(P, Error);
        if (!Error.IsEmpty()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_stop: %s"), *Error));
        const FString Key = RecordingKey(Submix);
        if (!Active.Contains(Key)) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_meter_stop: no analyzer active for %s"), *Key));
        UAudioMixerBlueprintLibrary::StopAnalyzingOutput(World, Submix);
        Active.Remove(Key);
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("submix"), Key);
        Out->SetStringField(TEXT("analyzer_state"), TEXT("stopped"));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult RecordingStart(const TSharedPtr<FJsonObject>& P, TSet<FString>& Active)
    {
        UWorld* World = ActiveAudioWorld();
        if (!World) return FHaybaHandlerResult::Err(TEXT("audio_recording_start: no active world"));
        if (!FAudioDeviceManager::GetAudioMixerDeviceFromWorldContext(World))
            return FHaybaHandlerResult::Err(TEXT("audio_recording_start: current audio device is not an Audio Mixer device"));
        FString Error;
        USoundSubmix* Submix = OptionalSubmix(P, Error);
        if (!Error.IsEmpty()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_recording_start: %s"), *Error));
        const FString Key = RecordingKey(Submix);
        if (Active.Contains(Key)) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_recording_start: recording already active for %s"), *Key));
        double ExpectedDuration = 10.0;
        if (P.IsValid()) P->TryGetNumberField(TEXT("expected_duration"), ExpectedDuration);
        if (ExpectedDuration <= 0.0 || ExpectedDuration > 3600.0)
            return FHaybaHandlerResult::Err(TEXT("audio_recording_start: expected_duration must be in (0, 3600] seconds"));
        UAudioMixerBlueprintLibrary::StartRecordingOutput(World, static_cast<float>(ExpectedDuration), Submix);
        Active.Add(Key);
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("submix"), Key);
        Out->SetNumberField(TEXT("expected_duration"), ExpectedDuration);
        Out->SetStringField(TEXT("recording_state"), TEXT("started"));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult RecordingStop(const TSharedPtr<FJsonObject>& P, TSet<FString>& Active)
    {
        UWorld* World = ActiveAudioWorld();
        if (!World) return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: no active world"));
        Audio::FMixerDevice* Mixer = FAudioDeviceManager::GetAudioMixerDeviceFromWorldContext(World);
        if (!Mixer) return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: current audio device is not an Audio Mixer device"));
        FString Error;
        USoundSubmix* Submix = OptionalSubmix(P, Error);
        if (!Error.IsEmpty()) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_recording_stop: %s"), *Error));
        const FString Key = RecordingKey(Submix);
        if (!Active.Contains(Key)) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_recording_stop: no recording active for %s"), *Key));
        FString Filename;
        if (!P->TryGetStringField(TEXT("filename"), Filename) || Filename.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: filename is required"));
        Filename = FPaths::GetBaseFilename(Filename);
        if (Filename.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: filename has no valid basename"));
        FString RelativePath;
        P->TryGetStringField(TEXT("relative_path"), RelativePath);
        RelativePath.ReplaceInline(TEXT("\\"), TEXT("/"));
        if (FPaths::IsRelative(RelativePath) == false || RelativePath.Contains(TEXT("..")))
            return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: relative_path must stay inside Saved/BouncedWavFiles"));

        float Channels = 0.0f;
        float SampleRate = 0.0f;
        Audio::FAlignedFloatBuffer& Buffer = Mixer->StopRecording(Submix, Channels, SampleRate);
        Active.Remove(Key);
        if (Buffer.Num() == 0)
            return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: Audio Mixer returned zero samples"));
        Audio::TSampleBuffer<int16> Samples(Buffer, static_cast<int32>(Channels), static_cast<int32>(SampleRate));
        Audio::FSoundWavePCMWriter Writer;
        FString OutputPath;
        if (!Writer.SynchronouslyWriteToWavFile(Samples, Filename, RelativePath, &OutputPath))
            return FHaybaHandlerResult::Err(TEXT("audio_recording_stop: synchronous WAV writer failed"));
        if (!IFileManager::Get().FileExists(*OutputPath))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_recording_stop: writer returned success but file is absent: %s"), *OutputPath));

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("submix"), Key);
        Out->SetStringField(TEXT("recording_state"), TEXT("stopped"));
        Out->SetStringField(TEXT("wav_path"), FPaths::ConvertRelativePathToFull(OutputPath));
        Out->SetNumberField(TEXT("sample_count"), Buffer.Num());
        Out->SetNumberField(TEXT("channel_count"), Channels);
        Out->SetNumberField(TEXT("sample_rate"), SampleRate);
        Out->SetNumberField(TEXT("duration_seconds"), Buffer.Num() / FMath::Max(1.0f, Channels * SampleRate));
        return FHaybaHandlerResult::Ok(Out);
    }

    FHaybaHandlerResult AudioSetVolume(const TSharedPtr<FJsonObject>& P)
    {
        FString Category;
        FHaybaParamReader Reader(P, TEXT("audio_set_volume"));
        Category = Reader.RequiredString(TEXT("category"));
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        double Volume = 1.0;
        if (!P->TryGetNumberField(TEXT("volume"), Volume)) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: missing volume"));
        if (Volume < 0.0) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: volume must be >= 0"));
        if (!Category.Equals(TEXT("master"), ESearchCase::IgnoreCase))
            return FHaybaHandlerResult::Err(TEXT("audio_set_volume: only master is supported; use SoundClass/SoundMix assets for category routing"));
        if (!GEngine) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: GEngine is unavailable"));
        FAudioDeviceHandle Device = GEngine->GetMainAudioDevice();
        if (!Device.IsValid()) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: no main audio device"));
        Device->SetTransientPrimaryVolume(static_cast<float>(Volume));
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("category"), TEXT("master"));
        Out->SetNumberField(TEXT("requested_volume"), Volume);
        Out->SetStringField(TEXT("scope"), TEXT("transient_audio_device_primary_volume"));
        return FHaybaHandlerResult::Ok(Out);
    }
}

TArray<FString> FHaybaMCPAudioHandler::GetCommands() const
{
    return {
        TEXT("audio_list"),
        TEXT("audio_play"),
        TEXT("audio_set_volume"),
        TEXT("audio_asset_create"),
        TEXT("audio_asset_inspect"),
        TEXT("audio_asset_set"),
        TEXT("audio_asset_save"),
        TEXT("audio_component_play"),
        TEXT("audio_component_control"),
        TEXT("audio_active_sounds"),
        TEXT("audio_meter_start"),
        TEXT("audio_meter_read"),
        TEXT("audio_meter_stop"),
        TEXT("audio_recording_start"),
        TEXT("audio_recording_stop"),
    };
}

FHaybaHandlerResult FHaybaMCPAudioHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("audio_list")) return AudioList(Params);
    if (Cmd == TEXT("audio_play")) return ComponentPlay(Params, ManagedComponents, Cmd);
    if (Cmd == TEXT("audio_set_volume")) return AudioSetVolume(Params);
    if (Cmd == TEXT("audio_asset_create")) return AudioAssetCreate(Params);
    if (Cmd == TEXT("audio_asset_inspect")) return AudioAssetInspect(Params);
    if (Cmd == TEXT("audio_asset_set")) return AudioAssetSet(Params);
    if (Cmd == TEXT("audio_asset_save")) return AudioAssetSave(Params);
    if (Cmd == TEXT("audio_component_play")) return ComponentPlay(Params, ManagedComponents, Cmd);
    if (Cmd == TEXT("audio_component_control")) return ComponentControl(Params, ManagedComponents);
    if (Cmd == TEXT("audio_active_sounds")) return ActiveSounds(Params, ManagedComponents);
    if (Cmd == TEXT("audio_meter_start")) return MeterStart(Params, ActiveAnalyzers);
    if (Cmd == TEXT("audio_meter_read")) return MeterRead(Params, ActiveAnalyzers);
    if (Cmd == TEXT("audio_meter_stop")) return MeterStop(Params, ActiveAnalyzers);
    if (Cmd == TEXT("audio_recording_start")) return RecordingStart(Params, ActiveRecordings);
    if (Cmd == TEXT("audio_recording_stop")) return RecordingStop(Params, ActiveRecordings);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("AudioHandler: unknown command %s"), *Cmd));
}
