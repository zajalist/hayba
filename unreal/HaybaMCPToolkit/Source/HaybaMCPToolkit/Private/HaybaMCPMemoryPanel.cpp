#include "HaybaMCPMemoryPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/SBoxPanel.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"

// The Memory tab browses the PLUMB stores the MCP server writes under the
// project's .scratch/ — the same no-bridge, file-tail convention the Validator
// panel uses. profiles.json = baked Physical Asset Profiles; constraints.json =
// the bound constraint library.
namespace
{
    FString ScratchDir()
    {
        const FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
        if (!Override.IsEmpty()) return FPaths::GetPath(Override);
        return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"));
    }

    TSharedPtr<FJsonObject> ReadJsonObject(const FString& Path)
    {
        FString Raw;
        if (!FFileHelper::LoadFileToString(Raw, *Path)) return nullptr;
        TSharedPtr<FJsonObject> Obj;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
        if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid()) return nullptr;
        return Obj;
    }
}

void SHaybaMCPMemoryPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right).Padding(8)
        [
            SNew(SButton)
            .Text(NSLOCTEXT("Hayba", "MemRefresh", "Refresh"))
            .OnClicked(this, &SHaybaMCPMemoryPanel::OnRefresh)
        ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SAssignNew(EntryList, SListView<TSharedPtr<FString>>)
            .ListItemsSource(&Entries)
            .OnGenerateRow(this, &SHaybaMCPMemoryPanel::GenerateRow)
        ]
    ];
}

void SHaybaMCPMemoryPanel::SetResults(const TArray<FString>& InEntries)
{
    Entries.Reset();
    for (const auto& E : InEntries) Entries.Add(MakeShared<FString>(E));
    if (EntryList.IsValid()) EntryList->RequestListRefresh();
}

FReply SHaybaMCPMemoryPanel::OnRefresh()
{
    const FString Dir = ScratchDir();
    TArray<FString> Lines;

    // ── Profiles ────────────────────────────────────────────────────────────
    if (const TSharedPtr<FJsonObject> Profiles = ReadJsonObject(FPaths::Combine(Dir, TEXT("profiles.json"))))
    {
        Lines.Add(FString::Printf(TEXT("── Profiles (%d) ──"), Profiles->Values.Num()));
        for (const auto& Pair : Profiles->Values)
        {
            const TSharedPtr<FJsonObject> P = Pair.Value->AsObject();
            if (!P.IsValid()) continue;
            FString Archetype = P->GetStringField(TEXT("profile"));
            int32 AffCount = 0;
            if (const TSharedPtr<FJsonObject> Sem = P->GetObjectField(TEXT("semantics")))
            {
                const TArray<TSharedPtr<FJsonValue>>* Aff;
                if (Sem->TryGetArrayField(TEXT("affordances"), Aff)) AffCount = Aff->Num();
            }
            FString Locked;
            if (const TSharedPtr<FJsonObject> Prov = P->GetObjectField(TEXT("provenance")))
            {
                const TArray<TSharedPtr<FJsonValue>>* LockedArr;
                if (Prov->TryGetArrayField(TEXT("locked"), LockedArr) && LockedArr->Num() > 0)
                {
                    TArray<FString> L;
                    for (const auto& V : *LockedArr) L.Add(V->AsString());
                    Locked = FString::Printf(TEXT("  locked:[%s]"), *FString::Join(L, TEXT(", ")));
                }
            }
            Lines.Add(FString::Printf(TEXT("📦 %s  [%s]  affordances:%d%s"), *Pair.Key, *Archetype, AffCount, *Locked));
        }
    }

    // ── Constraints ─────────────────────────────────────────────────────────
    if (const TSharedPtr<FJsonObject> Constraints = ReadJsonObject(FPaths::Combine(Dir, TEXT("constraints.json"))))
    {
        Lines.Add(FString::Printf(TEXT("── Constraints (%d) ──"), Constraints->Values.Num()));
        for (const auto& Pair : Constraints->Values)
        {
            const TSharedPtr<FJsonObject> C = Pair.Value->AsObject();
            if (!C.IsValid()) continue;
            const FString Primitive = C->GetStringField(TEXT("primitive"));
            FString Bind = TEXT("?");
            if (const TSharedPtr<FJsonObject> B = C->GetObjectField(TEXT("binding")))
            {
                FString Asset;
                if (B->TryGetStringField(TEXT("asset"), Asset)) Bind = Asset;
                else if (const TSharedPtr<FJsonObject> TagObj = B->GetObjectField(TEXT("tag")))
                    Bind = FString::Printf(TEXT("#%s=%s"), *TagObj->GetStringField(TEXT("axis")), *TagObj->GetStringField(TEXT("value")));
            }
            bool bHard = false; C->TryGetBoolField(TEXT("hard"), bHard);
            Lines.Add(FString::Printf(TEXT("⚖ %s: %s%s → %s"), *Pair.Key, *Primitive, bHard ? TEXT(" (hard)") : TEXT(""), *Bind));
        }
    }

    if (Lines.Num() == 0)
    {
        Lines.Add(FString::Printf(TEXT("No PLUMB profiles or constraints found under %s"), *Dir));
        Lines.Add(TEXT("Use plumb_profile_bake / plumb_constraint_define to populate."));
    }
    SetResults(Lines);
    return FReply::Handled();
}

TSharedRef<ITableRow> SHaybaMCPMemoryPanel::GenerateRow(TSharedPtr<FString> Entry, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<TSharedPtr<FString>>, Owner)
        [ SNew(STextBlock).AutoWrapText(true).Text(FText::FromString(*Entry)) ];
}
