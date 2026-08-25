// SHaybaValidatorPanel.h — runtime validator history browser.
//
// Reads `.scratch/validator-history.jsonl` (written by the MCP server) and
// understands both field spellings for a finding's detail object: `data`
// since the verdict collapse, `context` for older records.
// renders it as a filterable table. Per-row actions dismiss findings (writes
// resolved:true back to disk), jump to the linked actor, and re-run the rule.
//
// File-watching keeps the table live without an explicit refresh button —
// any append/edit by the MCP server triggers a re-read.

#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

class STableViewBase;
class ITableRow;
struct FFileChangeData;
template <typename T> class SComboBox;

/** Mirror of the TS-side ValidatorFinding. Keep field names in sync with
 *  `mcp-tools/hayba-mcp/src/validator/rules.ts`. */
struct FHaybaValidatorFinding
{
    FString RuleId;
    FString Severity;   // "error" | "warning" | "info"
    FString Message;
    FString Hint;
    TArray<FString> Refs;
    FString Timestamp;  // ISO; doubles as the stable resolve key
    FString ToolName;
    bool bResolved = false;
    FString ResolvedAt;

    /** Optional context fields surfaced for per-row actions. */
    FString ActorLabel;
    FString ActorId;
    FString GraphPath;

    /** Raw JSON of the original line — preserved so Resolve writes back
     *  without losing fields the panel doesn't model. */
    FString RawJson;
};

class SHaybaValidatorPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaValidatorPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    virtual ~SHaybaValidatorPanel() override;

    /** Re-read the on-disk history file. */
    void Refresh();

    /** Public bridges so the per-row Slate widget (declared in the .cpp) can
     *  call these actions without needing friend access. */
    FReply OnDismissClicked_Public(TSharedPtr<FHaybaValidatorFinding> Item);
    FReply OnJumpToActorClicked_Public(TSharedPtr<FHaybaValidatorFinding> Item);

private:
    // ── Data ────────────────────────────────────────────────────────────
    TArray<TSharedPtr<FHaybaValidatorFinding>> AllItems;
    TArray<TSharedPtr<FHaybaValidatorFinding>> FilteredItems;
    TSharedPtr<FHaybaValidatorFinding> Selected;

    // ── Filters ────────────────────────────────────────────────────────
    FString SearchText;
    bool bShowError = true;
    bool bShowWarning = true;
    bool bShowInfo = true;
    bool bIncludeResolved = false;

    // ── Widgets ────────────────────────────────────────────────────────
    TSharedPtr<SListView<TSharedPtr<FHaybaValidatorFinding>>> ListView;
    TSharedPtr<class STextBlock> HeaderText;

    // ── File watching ──────────────────────────────────────────────────
    FString WatchedDir;
    FString HistoryFile;
    FDelegateHandle WatcherHandle;

    void ApplyFilter();
    TSharedRef<ITableRow> OnGenerateRow(TSharedPtr<FHaybaValidatorFinding> Item, const TSharedRef<STableViewBase>& Owner);
    void OnSelectionChanged(TSharedPtr<FHaybaValidatorFinding> Item, ESelectInfo::Type);
    void OnDirectoryChanged(const TArray<FFileChangeData>& Changes);

    FReply OnClearAllClicked();
    FReply OnReRunAllClicked();
    FReply OnDismissClicked(TSharedPtr<FHaybaValidatorFinding> Item);
    FReply OnJumpToActorClicked(TSharedPtr<FHaybaValidatorFinding> Item);

    void UpdateHeader();

    /** Default path the MCP server writes to. Honours HAYBA_VALIDATOR_HISTORY
     *  if it is set in the editor process env (matches the TS side). */
    static FString DefaultHistoryPath();
    static FString DefaultScratchDir();

    /** Rewrites the JSONL file with the given findings, preserving order. */
    bool WriteAllFindings(const TArray<TSharedPtr<FHaybaValidatorFinding>>& Findings) const;

    /** Parse one JSONL line into a finding. Returns nullptr on malformed input. */
    static TSharedPtr<FHaybaValidatorFinding> ParseFindingLine(const FString& Line);
    /** Round-trip a finding back to JSON, preserving anything in RawJson. */
    static FString FindingToJson(const FHaybaValidatorFinding& F);
};
