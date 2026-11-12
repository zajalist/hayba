#pragma once

// The blueprint domain's decidable rules, taken out of the editor.
//
// Same split as HaybaActorOps.h and HaybaUIOps.h: the parts that decide things
// are pure and tested here, the parts that touch UBlueprint stay in the handler.
// Both rules below were found by calling the commands against a live editor and
// watching them answer ok for work that had gone wrong. See #320.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPParams.h"

namespace HaybaBlueprintOps
{
    // ── Where a created asset actually lands ─────────────────────────────────

    struct FResolvedPackage
    {
        /** The package that will be created, e.g. /Game/UI/BP_Menu */
        FString PackageName;
        /** The directory the trailing component was stripped to. */
        FString Directory;
        /** True when `package_path`'s last component is NOT the asset name.
         *
         *  The contract is that package_path is the FULL intended asset path and
         *  its trailing component is discarded — so "/Game/Temp" + name "BP_X"
         *  silently produces /Game/BP_X, one directory up from where a caller
         *  reading the parameter name would expect. That happened twice while
         *  writing these descriptions, once leaving an asset at the content
         *  root. The command cannot know which was meant, so it says so. */
        bool bTrailingIsNotName = false;
    };

    /** Compose the package a create command will write to, and notice when the
     *  caller most likely passed a folder. Pure: no packages are touched. */
    FResolvedPackage ResolvePackage(const FString& PackagePath, const FString& AssetName);

    /** The note to attach when the trailing component was not the asset name.
     *  Empty when there is nothing worth saying. */
    FString PackagePathNote(const FResolvedPackage& Resolved, const FString& PackagePath);

    // ── Whether a function name is free ──────────────────────────────────────

    /** An error message if `Requested` collides with an existing graph, empty
     *  otherwise.
     *
     *  blueprint_add_function had no such check. It created a second graph with
     *  the same name, the blueprint stopped compiling with "Found more than one
     *  function with the same name", nothing was rolled back, and the reply was
     *  ok:true carrying compile_errors — verified live. Graph names compare
     *  case-insensitively, because FName does. */
    FString FunctionNameConflict(const TArray<FString>& ExistingGraphNames, const FString& Requested);

    // ── What a type string means ─────────────────────────────────────────────

    enum class ETypeKind : uint8
    {
        None, Bool, Int, Int64, Real, String, Name, Text, Byte,
        Enum, Struct, Object, Class, SoftObject, SoftClass,
    };

    /** A parsed variable / parameter type. Parsing never loads anything: the
     *  handler resolves ObjectPath, so this stays testable without an editor. */
    struct FTypeSpec
    {
        ETypeKind Kind = ETypeKind::None;
        /** Class, struct or enum path for the reference kinds; empty otherwise. */
        FString ObjectPath;
        bool bArray = false;
        /** Why the spec was refused. Empty when it parsed. */
        FString Error;

        bool IsValid() const { return Error.IsEmpty() && Kind != ETypeKind::None; }
    };

    /** Parse the type grammar shared by variables, function parameters and
     *  custom-event inputs:
     *
     *    bool | int | int64 | float | double | string | name | text | byte
     *    vector | rotator | transform | linear_color | vector2d   (engine structs)
     *    object:<class> | class:<class> | soft_object:<class> | soft_class:<class>
     *    struct:<struct> | enum:<enum>
     *    array<any of the above>
     *
     *  Case-insensitive; surrounding whitespace ignored. Anything else is refused
     *  with a reason rather than guessed at. */
    FTypeSpec ParseTypeSpec(const FString& Spec);

    // ── Which UFunction an event name means ──────────────────────────────────

    /** The UFunction behind the name a caller wrote. Callers write what the node
     *  shows ("BeginPlay", "Event BeginPlay"); actors implement it as
     *  "ReceiveBeginPlay". Names that are already function names pass through. */
    FString CanonicalEventFunctionName(const FString& Requested);

    // ── Whether a parameter list can be built as asked ───────────────────────

    /** An error if the names are empty, collide case-insensitively, or reuse a
     *  pin name every node already has (execute, then, self). Empty otherwise.
     *  The editor would otherwise rename silently ("A" → "A_0"), and a caller
     *  wiring by name would land on a pin it never asked for. */
    FString ParamNamesProblem(const TArray<FString>& Names);
    // ── blueprint_graph_batch: one op stands for one existing command ────────

    /** One translated batch op. Error is set instead of Command when the op is
     *  malformed or names a ref that no earlier op created. */
    struct FBatchStep
    {
        FString Command;
        TSharedPtr<FJsonObject> Params;
        /** Caller name for the node this op creates; empty when it creates none. */
        FString Ref;
        FString Error;
    };

    /** Translate one op ({op, ref?, ...the single command's own args}) into the
     *  command it stands for. Node fields (node_id, from_node, to_node,
     *  node_ids[], moves[].node_id) may hold a ref created earlier in the same
     *  batch; those are replaced with the node GUID from Refs. connect defaults
     *  from_pin to "then" and to_pin to "execute". Pure: touches no Blueprint. */
    FBatchStep TranslateBatchOp(const TSharedPtr<FJsonObject>& Op, const FString& Path,
        const FString& DefaultGraph, const TMap<FString, FString>& Refs);

    // ── Comment boxes sized without a graph widget ───────────────────────────

    struct FNodeBox { int32 X = 0; int32 Y = 0; int32 W = 0; int32 H = 0; };

    /** A node's footprint. Known sizes (comments, resized nodes) win; otherwise
     *  it is estimated from the title and the longest visible pin labels,
     *  because K2 node sizes only exist in the Slate widget. */
    FNodeBox EstimateNodeBox(int32 X, int32 Y, int32 KnownW, int32 KnownH, int32 TitleChars,
        int32 NumIn, int32 NumOut, int32 MaxInChars, int32 MaxOutChars);

    /** The comment rectangle that encloses Boxes with Pad on every side plus a
     *  title band on top. Boxes must not be empty. */
    FNodeBox CommentAround(const TArray<FNodeBox>& Boxes, int32 Pad, int32 TitleBand);

    /** For every item, the index of the comment that owns it, or INDEX_NONE.
     *  An item belongs to the smallest comment (larger than itself) whose rect
     *  contains the item's top-left corner. The corner, not the whole box,
     *  because undersized boxes are exactly what needs fixing: their nodes spill
     *  right and down, but still start inside. Comments nest by the same rule. */
    TArray<int32> AssignOwners(const TArray<FNodeBox>& Items, const TArray<bool>& IsComment);

    /** Remove overlaps by pushing movable boxes straight down, in top-to-bottom
     *  order, below whatever they hit (plus Gap). Fixed boxes never move.
     *  Returns how many boxes moved. Columns keep their X. */
    int32 PushApart(TArray<FNodeBox>& Boxes, const TArray<bool>& Movable, int32 Gap);

    /** True when Inner lies entirely within Outer. */
    bool Encloses(const FNodeBox& Outer, const FNodeBox& Inner);

    // ── Variable / parameter types ───────────────────────────────────────────

    struct FPinTypeSpec
    {
        /** Canonical kind: bool, int, int64, byte, float, string, name, text, vector,
         *  rotator, transform, linear_color, object, class, soft_object, soft_class,
         *  struct or enum. */
        FString Kind;
        /** For object, class, soft_object, soft_class, struct and enum: the class, struct or enum path. */
        FString ObjectPath;
    };

    /** Parse "float", "object:/Script/Engine.Actor", "struct:/Game/S_Item.S_Item",
     *  "enum:/Game/E_Verb.E_Verb" and their aliases. Pure: nothing is loaded. */
    bool ParsePinTypeSpec(const FString& Spec, FPinTypeSpec& Out, FString& Error);
}
