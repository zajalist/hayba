#include "HaybaBlueprintOps.h"
#include "Misc/PackageName.h"
#include "Misc/Guid.h"
#include "Dom/JsonValue.h"

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
    FBatchStep TranslateBatchOp(const TSharedPtr<FJsonObject>& Op, const FString& Path,
        const FString& DefaultGraph, const TMap<FString, FString>& Refs)
    {
        static const TMap<FString, FString> OpToCommand = {
            { TEXT("add_node"),   TEXT("blueprint_add_node") },
            { TEXT("add_event"),  TEXT("blueprint_add_event") },
            { TEXT("connect"),    TEXT("blueprint_connect_nodes") },
            { TEXT("set_pin"),    TEXT("blueprint_set_pin_default") },
            { TEXT("comment"),    TEXT("blueprint_add_comment") },
            { TEXT("move"),       TEXT("blueprint_move_nodes") },
            { TEXT("remove"),     TEXT("blueprint_remove_nodes") },
            { TEXT("disconnect"), TEXT("blueprint_disconnect") },
            { TEXT("fit_comments"), TEXT("blueprint_fit_comments") },
        };
        FBatchStep Step;
        FString OpName;
        if (!Op.IsValid() || !Op->TryGetStringField(TEXT("op"), OpName))
        {
            Step.Error = TEXT("each op must be an object with an 'op' field");
            return Step;
        }
        const FString* Command = OpToCommand.Find(OpName);
        if (!Command)
        {
            Step.Error = FString::Printf(TEXT("unknown op '%s'. Ops: add_node, add_event, connect, set_pin, comment, move, remove, disconnect, fit_comments"), *OpName);
            return Step;
        }

        Step.Params = MakeShared<FJsonObject>();
        for (const auto& Pair : Op->Values)
        {
            const FString Key(Pair.Key);
            if (Key != TEXT("op") && Key != TEXT("ref")) Step.Params->SetField(Key, Pair.Value);
        }
        // One batch edits one Blueprint; an op cannot point somewhere else.
        Step.Params->SetStringField(TEXT("path"), Path);
        if (!Step.Params->HasField(TEXT("graph_name")) && !DefaultGraph.IsEmpty())
            Step.Params->SetStringField(TEXT("graph_name"), DefaultGraph);
        if (OpName == TEXT("connect"))
        {
            if (!Step.Params->HasField(TEXT("from_pin"))) Step.Params->SetStringField(TEXT("from_pin"), TEXT("then"));
            if (!Step.Params->HasField(TEXT("to_pin")))   Step.Params->SetStringField(TEXT("to_pin"), TEXT("execute"));
        }
        // move takes one node inline as a convenience; the command takes a list.
        if (OpName == TEXT("move") && !Step.Params->HasField(TEXT("moves")) && Step.Params->HasField(TEXT("node_id")))
        {
            TSharedPtr<FJsonObject> One = MakeShared<FJsonObject>();
            for (const TCHAR* K : { TEXT("node_id"), TEXT("x"), TEXT("y"), TEXT("width"), TEXT("height") })
            {
                if (Step.Params->HasField(K)) { One->SetField(K, Step.Params->TryGetField(K)); Step.Params->RemoveField(K); }
            }
            Step.Params->SetArrayField(TEXT("moves"), { MakeShared<FJsonValueObject>(One) });
        }

        // A node field holds either a GUID from an earlier call or a ref from this batch.
        auto Resolve = [&Refs, &Step](const FString& Value, FString& Out) -> bool
        {
            if (const FString* Guid = Refs.Find(Value)) { Out = *Guid; return true; }
            FGuid Parsed;
            if (FGuid::Parse(Value, Parsed)) { Out = Value; return true; }
            Step.Error = FString::Printf(TEXT("'%s' is neither a node GUID nor a ref created by an earlier op"), *Value);
            return false;
        };
        for (const TCHAR* Key : { TEXT("node_id"), TEXT("from_node"), TEXT("to_node") })
        {
            FString Value, Resolved;
            if (Step.Params->TryGetStringField(Key, Value))
            {
                if (!Resolve(Value, Resolved)) return Step;
                Step.Params->SetStringField(Key, Resolved);
            }
        }
        const TArray<TSharedPtr<FJsonValue>>* Ids = nullptr;
        if (Step.Params->TryGetArrayField(TEXT("node_ids"), Ids))
        {
            TArray<TSharedPtr<FJsonValue>> Out;
            for (const TSharedPtr<FJsonValue>& V : *Ids)
            {
                FString Resolved;
                if (!V.IsValid() || V->Type != EJson::String || !Resolve(V->AsString(), Resolved))
                {
                    if (Step.Error.IsEmpty()) Step.Error = TEXT("node_ids must be strings");
                    return Step;
                }
                Out.Add(MakeShared<FJsonValueString>(Resolved));
            }
            Step.Params->SetArrayField(TEXT("node_ids"), Out);
        }
        const TArray<TSharedPtr<FJsonValue>>* Moves = nullptr;
        if (Step.Params->TryGetArrayField(TEXT("moves"), Moves))
        {
            TArray<TSharedPtr<FJsonValue>> Out;
            for (const TSharedPtr<FJsonValue>& V : *Moves)
            {
                const TSharedPtr<FJsonObject>* M = nullptr;
                FString Id, Resolved;
                if (!V.IsValid() || !V->TryGetObject(M) || !(*M)->TryGetStringField(TEXT("node_id"), Id))
                {
                    Step.Error = TEXT("each move needs a node_id");
                    return Step;
                }
                if (!Resolve(Id, Resolved)) return Step;
                TSharedPtr<FJsonObject> Copy = MakeShared<FJsonObject>();
                Copy->Values = (*M)->Values;
                Copy->SetStringField(TEXT("node_id"), Resolved);
                Out.Add(MakeShared<FJsonValueObject>(Copy));
            }
            Step.Params->SetArrayField(TEXT("moves"), Out);
        }

        if (Op->TryGetStringField(TEXT("ref"), Step.Ref))
        {
            FGuid Parsed;
            if (Step.Ref.IsEmpty() || FGuid::Parse(Step.Ref, Parsed))
            {
                Step.Error = TEXT("a ref must be a non-empty name that is not itself a GUID");
                return Step;
            }
            if (Refs.Contains(Step.Ref))
            {
                Step.Error = FString::Printf(TEXT("ref '%s' is already used by an earlier op"), *Step.Ref);
                return Step;
            }
        }
        Step.Command = *Command;
        return Step;
    }

    FNodeBox EstimateNodeBox(int32 X, int32 Y, int32 KnownW, int32 KnownH, int32 TitleChars,
        int32 NumIn, int32 NumOut, int32 MaxInChars, int32 MaxOutChars)
    {
        // shortcut: ~7 px per character at the default graph font; widget sizes
        // are not available off-screen. Pad generously rather than clip.
        FNodeBox Box;
        Box.X = X;
        Box.Y = Y;
        Box.W = KnownW > 0 ? KnownW
            : FMath::Max3(140, TitleChars * 7 + 48, (MaxInChars + MaxOutChars) * 7 + 96);
        Box.H = KnownH > 0 ? KnownH : 40 + 26 * FMath::Max(NumIn, NumOut);
        return Box;
    }

    FNodeBox CommentAround(const TArray<FNodeBox>& Boxes, int32 Pad, int32 TitleBand)
    {
        if (Boxes.Num() == 0) return FNodeBox();
        int32 MinX = MAX_int32, MinY = MAX_int32, MaxX = MIN_int32, MaxY = MIN_int32;
        for (const FNodeBox& B : Boxes)
        {
            MinX = FMath::Min(MinX, B.X);
            MinY = FMath::Min(MinY, B.Y);
            MaxX = FMath::Max(MaxX, B.X + B.W);
            MaxY = FMath::Max(MaxY, B.Y + B.H);
        }
        FNodeBox Out;
        Out.X = MinX - Pad;
        Out.Y = MinY - Pad - TitleBand;
        Out.W = (MaxX - MinX) + 2 * Pad;
        Out.H = (MaxY - MinY) + 2 * Pad + TitleBand;
        return Out;
    }

    static int64 Area(const FNodeBox& B) { return static_cast<int64>(B.W) * static_cast<int64>(B.H); }

    static bool Overlaps(const FNodeBox& A, const FNodeBox& B)
    {
        return A.X < B.X + B.W && B.X < A.X + A.W && A.Y < B.Y + B.H && B.Y < A.Y + A.H;
    }

    TArray<int32> AssignOwners(const TArray<FNodeBox>& Items, const TArray<bool>& IsComment)
    {
        TArray<int32> Owners;
        Owners.Init(INDEX_NONE, Items.Num());
        for (int32 I = 0; I < Items.Num(); ++I)
        {
            const FNodeBox& Item = Items[I];
            for (int32 C = 0; C < Items.Num(); ++C)
            {
                if (C == I || !IsComment.IsValidIndex(C) || !IsComment[C]) continue;
                const FNodeBox& Box = Items[C];
                const bool bCornerInside = Item.X >= Box.X && Item.X < Box.X + Box.W
                    && Item.Y >= Box.Y && Item.Y < Box.Y + Box.H;
                // A comment only nests in a strictly larger one, so ownership can never cycle.
                if (!bCornerInside || (IsComment[I] && Area(Box) <= Area(Item))) continue;
                if (Owners[I] == INDEX_NONE || Area(Box) < Area(Items[Owners[I]])) Owners[I] = C;
            }
        }
        return Owners;
    }

    int32 PushApart(TArray<FNodeBox>& Boxes, const TArray<bool>& Movable, int32 Gap)
    {
        TArray<int32> Placed;
        TArray<int32> Order;
        for (int32 I = 0; I < Boxes.Num(); ++I)
        {
            if (Movable.IsValidIndex(I) && Movable[I]) Order.Add(I);
            else Placed.Add(I);
        }
        Order.Sort([&Boxes](int32 A, int32 B)
        {
            return Boxes[A].Y != Boxes[B].Y ? Boxes[A].Y < Boxes[B].Y : Boxes[A].X < Boxes[B].X;
        });
        int32 Moved = 0;
        for (const int32 I : Order)
        {
            const int32 StartY = Boxes[I].Y;
            // Each push lands strictly lower, below one more placed box, so this ends.
            for (int32 Guard = 0; Guard <= Placed.Num(); ++Guard)
            {
                int32 Hit = INDEX_NONE;
                for (const int32 P : Placed)
                {
                    if (Overlaps(Boxes[I], Boxes[P])) { Hit = P; break; }
                }
                if (Hit == INDEX_NONE) break;
                Boxes[I].Y = Boxes[Hit].Y + Boxes[Hit].H + Gap;
            }
            if (Boxes[I].Y != StartY) ++Moved;
            Placed.Add(I);
        }
        return Moved;
    }

    bool Encloses(const FNodeBox& Outer, const FNodeBox& Inner)
    {
        return Inner.X >= Outer.X && Inner.Y >= Outer.Y
            && Inner.X + Inner.W <= Outer.X + Outer.W && Inner.Y + Inner.H <= Outer.Y + Outer.H;
    }

    bool ParsePinTypeSpec(const FString& Spec, FPinTypeSpec& Out, FString& Error)
    {
        static const TMap<FString, FString> Simple = {
            { TEXT("bool"), TEXT("bool") }, { TEXT("boolean"), TEXT("bool") },
            { TEXT("int"), TEXT("int") }, { TEXT("integer"), TEXT("int") }, { TEXT("int64"), TEXT("int64") },
            { TEXT("byte"), TEXT("byte") },
            { TEXT("float"), TEXT("float") }, { TEXT("double"), TEXT("float") }, { TEXT("real"), TEXT("float") },
            { TEXT("string"), TEXT("string") }, { TEXT("fstring"), TEXT("string") },
            { TEXT("name"), TEXT("name") }, { TEXT("fname"), TEXT("name") },
            { TEXT("text"), TEXT("text") }, { TEXT("ftext"), TEXT("text") },
            { TEXT("vector"), TEXT("vector") }, { TEXT("rotator"), TEXT("rotator") },
            { TEXT("transform"), TEXT("transform") }, { TEXT("linear_color"), TEXT("linear_color") },
            { TEXT("linearcolor"), TEXT("linear_color") },
        };
        static const TSet<FString> WithPath = {
            TEXT("object"), TEXT("class"), TEXT("soft_object"), TEXT("soft_class"), TEXT("struct"), TEXT("enum"),
        };
        Out = FPinTypeSpec();
        FString Kind = Spec.TrimStartAndEnd(), Path;
        if (Kind.Split(TEXT(":"), &Kind, &Path, ESearchCase::CaseSensitive, ESearchDir::FromStart))
        {
            Kind = Kind.ToLower();
            if (!WithPath.Contains(Kind) || Path.IsEmpty() || !Path.StartsWith(TEXT("/")))
            {
                Error = FString::Printf(TEXT("type '%s': only object, class, soft_object, soft_class, struct and enum take ':/Path.To.Type'"), *Spec);
                return false;
            }
            Out.Kind = Kind;
            Out.ObjectPath = Path;
            return true;
        }
        if (const FString* Canonical = Simple.Find(Kind.ToLower()))
        {
            Out.Kind = *Canonical;
            return true;
        }
        Error = FString::Printf(
            TEXT("unsupported type '%s'. Use bool, int, int64, byte, float, string, name, text, vector, rotator, transform, linear_color, or object:/class:/soft_object:/soft_class:/struct:/enum: followed by a path"),
            *Spec);
        return false;
    }
}
