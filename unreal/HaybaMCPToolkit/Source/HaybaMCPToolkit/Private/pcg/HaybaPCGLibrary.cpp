#include "pcg/HaybaPCGLibrary.h"

#include "PCGNode.h"
#include "PCGCommon.h" // EPCGNodeTitleType
#include "PCGGraph.h"
#include "HaybaMCPReflection.h"
#include "StructUtils/PropertyBag.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FString UHaybaPCGLibrary::GetPCGNodeTitle(UPCGNode* Node)
{
	if (!Node)
	{
		return FString();
	}

	// EPCGNodeTitleType::FullTitle is the multi-line display title shown in the
	// PCG graph editor (e.g. "Shape : 3D Grid"). Verified UE 5.8:
	//   PCGNode.h:71   FText GetNodeTitle(EPCGNodeTitleType) const  (PCG_API)
	//   PCGCommon.h:725 enum class EPCGNodeTitleType : uint8 { FullTitle, ListView }
	return Node->GetNodeTitle(EPCGNodeTitleType::FullTitle).ToString();
}

FString UHaybaPCGLibrary::SetPCGGraphUserParameter(UPCGGraph* Graph, FName Name, const FString& StructType, const FString& ValueJson)
{
	if (!Graph || Name.IsNone())
	{
		return TEXT("needs a PCG graph and a parameter name; nothing was changed");
	}

	TSharedPtr<FJsonValue> Value;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ValueJson), Value) || !Value.IsValid())
	{
		Value = MakeShared<FJsonValueString>(ValueJson); // not JSON: UE text form, imported by the property itself
	}

	// PCG does not export structs such as FPCGVirtualTexturePrimingInfo, so they are found by path or name.
	UScriptStruct* Struct = nullptr;
	if (!StructType.IsEmpty())
	{
		Struct = StructType.StartsWith(TEXT("/"))
			? LoadObject<UScriptStruct>(nullptr, *StructType)
			: FindFirstObject<UScriptStruct>(*StructType, EFindFirstObjectOptions::NativeFirst);
		if (!Struct)
		{
			return FString::Printf(TEXT("no struct '%s'; nothing was changed"), *StructType);
		}
	}

	const FPropertyBagPropertyDesc* Desc = Graph->GetUserParametersStruct()->FindPropertyDescByName(Name);
	if (Desc && Struct && Desc->ValueTypeObject.Get() != Struct)
	{
		return FString::Printf(TEXT("parameter '%s' already exists with another type; nothing was changed"), *Name.ToString());
	}
	if (!Desc && !Struct)
	{
		return FString::Printf(TEXT("no parameter '%s'; pass StructType to add it. Nothing was changed"), *Name.ToString());
	}

	Graph->Modify();
	if (!Desc && Graph->AddUserParameters({ FPropertyBagPropertyDesc(Name, EPropertyBagPropertyType::Struct, Struct) })
		!= EPropertyBagAlterationResult::Success)
	{
		return FString::Printf(TEXT("could not add parameter '%s'"), *Name.ToString());
	}

	// UpdateUserParametersStruct refreshes graph instances and components afterwards, as an editor change would.
	FString Error;
	Graph->UpdateUserParametersStruct([&](FInstancedPropertyBag& Bag)
	{
		const FPropertyBagPropertyDesc* Param = Bag.FindPropertyDescByName(Name);
		FProperty* Prop = Param ? const_cast<FProperty*>(Param->CachedProperty) : nullptr;
		void* Memory = Bag.GetMutableValue().GetMemory();
		const FStructProperty* StructProp = CastField<FStructProperty>(Prop);
		if (StructProp && Memory && Value->Type == EJson::Object)
		{
			// Field by field, naming every key that did not land rather than calling a partial write a success.
			TArray<FString> NotApplied;
			HaybaReflection::ApplyStructFields(StructProp->Struct, StructProp->ContainerPtrToValuePtr<void>(Memory), Value->AsObject(), &NotApplied);
			if (NotApplied.Num() > 0)
			{
				Error = FString::Printf(TEXT("parameter '%s' was set except %s"), *Name.ToString(), *FString::Join(NotApplied, TEXT(", ")));
			}
		}
		else if (!Prop || !Memory || !HaybaReflection::SetValueFromJson(Prop, Memory, Value, Graph))
		{
			Error = FString::Printf(TEXT("parameter '%s': could not apply %s"), *Name.ToString(), *ValueJson);
		}
	});
	return Error;
}
