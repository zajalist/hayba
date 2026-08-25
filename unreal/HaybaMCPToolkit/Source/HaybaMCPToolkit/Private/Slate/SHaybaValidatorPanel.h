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

    /** The signed margin, when the producer measured one.
     *
     *  The IA's verdict contract needs an amount and a direction, not just a
     *  severity: "+1.8 m" satisfied versus "-0.6 m" needing attention. The TS
     *  side has always emitted this under `measurement`; nothing here modelled
     *  it, so every row rendered as a bare severity chip.
     *
     *  bHasMeasurement distinguishes "measured exactly zero" -- a subject
     *  sitting precisely on its limit, which is meaningful -- from "no
     *  measurement supplied". A bare double cannot tell those apart. */
    bool    bHasMeasurement = false;
    double  MarginValue = 0.0;
    FString MarginUnit;
    FString MarginDetail;

    /** The fix translation, when the producer returned one. This is what makes
     *  the IA's "available next action" available. */
    bool    bHasFix = false;
    FVector FixTranslate = FVector::ZeroVector;

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
    // Pure JSON helpers -- no widget state, no side effects. Public so the
    // format they implement can be tested directly. The detail object's field
    // was renamed from `context` to `data` once already without this parser
    // being updated, and an empty context column is not a loud failure.

    /** Parse one JSONL line into a finding. Returns nullptr on malformed input. */
    static TSharedPtr<FHaybaValidatorFinding> ParseFindingLine(const FString& Line);
    /** Round-trip a finding back to JSON, preserving anything in RawJson. */
    static FString FindingToJson(const FHaybaValidatorFinding& F);

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
    FReply OnApplyFixClicked_Public(TSharedPtr<FHaybaValidatorFinding> Item);

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

    /** Move the finding's actor along its fix vector, transacted. */
    FReply OnApplyFixClicked(TSharedPtr<FHaybaValidatorFinding> Item);

    /** Shared by Jump and Fix so the two can never disagree about
     *  which actor a finding refers to. */
    static AActor* ResolveActor(const TSharedPtr<FHaybaValidatorFinding>& Item);

    void UpdateHeader();

    /** Default path the MCP server writes to. Honours HAYBA_VALIDATOR_HISTORY
     *  if it is set in the editor process env (matches the TS side). */
    static FString DefaultHistoryPath();
    static FString DefaultScratchDir();

    /** Rewrites the JSONL file with the given findings, preserving order. */
    bool WriteAllFindings(const TArray<TSharedPtr<FHaybaValidatorFinding>>& Findings) const;

};
