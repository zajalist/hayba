#include "HaybaBlueprintOps.h"
#include "Misc/PackageName.h"

namespace HaybaBlueprintOps
{
    FResolvedPackage ResolvePackage(const FString& PackagePath, const FString& AssetName)
    {
        FResolvedPackage Out;
        Out.Directory = FPackageName::GetLongPackagePath(PackagePath);
        Out.PackageName = Out.Directory / AssetName;

        // The component that was thrown away. If it is not the asset name, the
        // caller probably passed a folder and expected the asset inside it.
        FString Trailing = PackagePath;
        int32 Slash = INDEX_NONE;
        if (PackagePath.FindLastChar(TEXT('/'), Slash) && Slash != INDEX_NONE)
        {
            Trailing = PackagePath.Mid(Slash + 1);
        }
        Out.bTrailingIsNotName = !Trailing.IsEmpty() && !Trailing.Equals(AssetName, ESearchCase::IgnoreCase);
        return Out;
    }

    FString PackagePathNote(const FResolvedPackage& Resolved, const FString& PackagePath)
    {
        if (!Resolved.bTrailingIsNotName) return FString();
        return FString::Printf(
            TEXT("'package_path' is the full intended asset path and its last component is discarded, so \"%s\" "
                 "resolved to the folder \"%s\" and the asset was created at \"%s\". If you meant the folder "
                 "\"%s\", pass package_path=\"%s/<name>\"."),
            *PackagePath, *Resolved.Directory, *Resolved.PackageName, *PackagePath, *PackagePath);
    }

    FString FunctionNameConflict(const TArray<FString>& ExistingGraphNames, const FString& Requested)
    {
        for (const FString& Existing : ExistingGraphNames)
        {
            if (Existing.Equals(Requested, ESearchCase::IgnoreCase))
            {
                return FString::Printf(
                    TEXT("blueprint_add_function: '%s' already exists on this blueprint (as '%s'). "
                         "Adding it again compiles to \"Found more than one function with the same name\" and leaves "
                         "the blueprint broken, so nothing was changed. Pick another name, or edit the existing graph."),
                    *Requested, *Existing);
            }
        }
        return FString();
    }

    static const TCHAR* TypeGrammar =
        TEXT("bool, int, int64, float, double, string, name, text, byte, vector, rotator, transform, linear_color, "
             "vector2d, object:<class path>, class:<class path>, soft_object:<class path>, soft_class:<class path>, "
             "struct:<struct path>, enum:<enum path>, or array<one of those>");

    FTypeSpec ParseTypeSpec(const FString& Spec)
    {
        FTypeSpec Out;
        FString S = Spec.TrimStartAndEnd();
        if (S.IsEmpty())
        {
            Out.Error = FString::Printf(TEXT("empty type. Accepted: %s."), TypeGrammar);
            return Out;
        }

        if (S.StartsWith(TEXT("array<"), ESearchCase::IgnoreCase))
        {
            if (!S.EndsWith(TEXT(">")))
            {
                Out.Error = FString::Printf(TEXT("'%s' opens array< but never closes it."), *Spec);
                return Out;
            }
            const FString Inner = S.Mid(6, S.Len() - 7).TrimStartAndEnd();
            if (Inner.StartsWith(TEXT("array<"), ESearchCase::IgnoreCase))
            {
                // Blueprint containers do not nest; the pin type would be refused
                // later with a message that no longer names what was asked for.
                Out.Error = FString::Printf(TEXT("'%s': arrays of arrays are not a Blueprint type."), *Spec);
                return Out;
            }
            Out = ParseTypeSpec(Inner);
            if (Out.Error.IsEmpty()) Out.bArray = true;
            return Out;
        }

        FString Prefix, Path;
        if (S.Split(TEXT(":"), &Prefix, &Path))
        {
            Prefix = Prefix.TrimStartAndEnd().ToLower();
            Path = Path.TrimStartAndEnd();
            static const TMap<FString, ETypeKind> ReferenceKinds = {
                { TEXT("object"), ETypeKind::Object },         { TEXT("class"), ETypeKind::Class },
                { TEXT("soft_object"), ETypeKind::SoftObject }, { TEXT("soft_class"), ETypeKind::SoftClass },
                { TEXT("struct"), ETypeKind::Struct },         { TEXT("enum"), ETypeKind::Enum },
            };
            const ETypeKind* Kind = ReferenceKinds.Find(Prefix);
            if (!Kind)
            {
                Out.Error = FString::Printf(TEXT("'%s': unknown reference kind '%s'. Accepted: %s."), *Spec, *Prefix, TypeGrammar);
                return Out;
            }
            if (Path.IsEmpty() || !Path.StartsWith(TEXT("/")))
            {
                Out.Error = FString::Printf(
                    TEXT("'%s' needs a full path after '%s:', e.g. %s:/Script/Engine.SplineComponent."), *Spec, *Prefix, *Prefix);
                return Out;
            }
            Out.Kind = *Kind;
            Out.ObjectPath = Path;
            return Out;
        }

        static const TMap<FString, ETypeKind> Scalars = {
            { TEXT("bool"), ETypeKind::Bool },     { TEXT("boolean"), ETypeKind::Bool },
            { TEXT("int"), ETypeKind::Int },       { TEXT("integer"), ETypeKind::Int },   { TEXT("int32"), ETypeKind::Int },
            { TEXT("int64"), ETypeKind::Int64 },
            { TEXT("float"), ETypeKind::Real },    { TEXT("double"), ETypeKind::Real },   { TEXT("real"), ETypeKind::Real },
            { TEXT("string"), ETypeKind::String }, { TEXT("fstring"), ETypeKind::String },
            { TEXT("name"), ETypeKind::Name },     { TEXT("fname"), ETypeKind::Name },
            { TEXT("text"), ETypeKind::Text },     { TEXT("ftext"), ETypeKind::Text },
            { TEXT("byte"), ETypeKind::Byte },     { TEXT("uint8"), ETypeKind::Byte },
        };
        static const TMap<FString, FString> EngineStructs = {
            { TEXT("vector"), TEXT("/Script/CoreUObject.Vector") },
            { TEXT("rotator"), TEXT("/Script/CoreUObject.Rotator") },
            { TEXT("transform"), TEXT("/Script/CoreUObject.Transform") },
            { TEXT("linear_color"), TEXT("/Script/CoreUObject.LinearColor") },
            { TEXT("linearcolor"), TEXT("/Script/CoreUObject.LinearColor") },
            { TEXT("vector2d"), TEXT("/Script/CoreUObject.Vector2D") },
        };

        const FString Lower = S.ToLower();
        if (const ETypeKind* Kind = Scalars.Find(Lower))
        {
            Out.Kind = *Kind;
            return Out;
        }
        if (const FString* StructPath = EngineStructs.Find(Lower))
        {
            Out.Kind = ETypeKind::Struct;
            Out.ObjectPath = *StructPath;
            return Out;
        }
        Out.Error = FString::Printf(TEXT("unknown type '%s'. Accepted: %s."), *Spec, TypeGrammar);
        return Out;
    }

    FString CanonicalEventFunctionName(const FString& Requested)
    {
        FString Name = Requested.TrimStartAndEnd();
        if (Name.StartsWith(TEXT("Event "), ESearchCase::IgnoreCase))
        {
            Name = Name.Mid(6).TrimStartAndEnd();
        }
        // Actor events whose node title drops the "Receive" the UFunction carries.
        static const TCHAR* ActorEvents[] = {
            TEXT("BeginPlay"), TEXT("EndPlay"), TEXT("Tick"), TEXT("Destroyed"),
            TEXT("ActorBeginOverlap"), TEXT("ActorEndOverlap"), TEXT("Hit"), TEXT("AnyDamage"),
            TEXT("PointDamage"), TEXT("RadialDamage"), TEXT("ActorOnClicked"), TEXT("ActorBeginCursorOver"),
            TEXT("ActorEndCursorOver"), TEXT("Possessed"), TEXT("UnPossessed"),
        };
        for (const TCHAR* Event : ActorEvents)
        {
            if (Name.Equals(Event, ESearchCase::IgnoreCase))
            {
                return FString(TEXT("Receive")) + Event;
            }
        }
        return Name;
    }

    FString ParamNamesProblem(const TArray<FString>& Names)
    {
        static const TCHAR* Reserved[] = { TEXT("execute"), TEXT("then"), TEXT("self") };
        for (int32 I = 0; I < Names.Num(); ++I)
        {
            const FString Name = Names[I].TrimStartAndEnd();
            if (Name.IsEmpty())
            {
                return FString::Printf(TEXT("parameter %d has no name."), I + 1);
            }
            for (const TCHAR* R : Reserved)
            {
                if (Name.Equals(R, ESearchCase::IgnoreCase))
                {
                    return FString::Printf(TEXT("'%s' is reserved: every node already has a pin by that name."), *Name);
                }
            }
            for (int32 J = 0; J < I; ++J)
            {
                if (Names[J].TrimStartAndEnd().Equals(Name, ESearchCase::IgnoreCase))
                {
                    return FString::Printf(
                        TEXT("duplicate parameter name '%s' (names compare case-insensitively; the editor would rename the second one)."),
                        *Name);
                }
            }
        }
        return FString();
    }
}
