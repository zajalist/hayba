// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.cpp
//
// Single-purpose chat panel — see HaybaMCPChatPanel.h for the design contract.
// All Wizard / ModeSelect / MCPStatus / inline-Settings / Steps-sidebar code
// was removed; those concerns live in dedicated panels. This file should stay
// focused on conversation, input, and per-message affordances.
//
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPAgentClient.h"
#include "HaybaMCPActivityModel.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPStyle.h"
#include "Slate/SHaybaActivityCard.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPWizardPrompt.h"

#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SComboButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Text/SMultiLineEditableText.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SOverlay.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"

#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformTime.h"
#include "DragAndDrop/AssetDragDropOp.h"
#include "Input/DragAndDrop.h"          // FExternalDragOperation (SlateCore)
#include "AssetRegistry/AssetData.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserModule.h"
#include "IContentBrowserSingleton.h"
#include "Misc/PackageName.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "Editor.h"
#include "Styling/AppStyle.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"

#define LOCTEXT_NAMESPACE "HaybaMCPToolkit"

namespace
{
    const FLinearColor ColorSuccess(0.40f, 0.95f, 0.55f);
    const FLinearColor ColorError  (1.00f, 0.40f, 0.40f);
    const FLinearColor ColorMuted  (0.55f, 0.57f, 0.65f);

    bool SupportsReasoningEffort(const FString& Provider, const FString& Effort)
    {
        if (Provider == TEXT("anthropic"))
            return Effort == TEXT("low") || Effort == TEXT("medium") || Effort == TEXT("high") ||
                Effort == TEXT("xhigh") || Effort == TEXT("max");
        if (Provider == TEXT("deepseek"))
            return Effort == TEXT("low") || Effort == TEXT("high") || Effort == TEXT("max");
        if (Provider == TEXT("openai") || Provider == TEXT("openrouter"))
            return Effort == TEXT("none") || Effort == TEXT("minimal") || Effort == TEXT("low") ||
                Effort == TEXT("medium") || Effort == TEXT("high") || Effort == TEXT("xhigh") ||
                (Provider == TEXT("openrouter") && Effort == TEXT("max"));
        return false;
    }

    bool ValidModelId(const FString& Id)
    {
        if (Id.IsEmpty() || Id.Len() > 256) return false;
        for (const TCHAR Character : Id)
            if (FChar::IsWhitespace(Character) || Character < 32 || Character == 127) return false;
        return true;
    }

    void Toast(const FText& Msg)
    {
        FNotificationInfo Info(Msg);
        Info.ExpireDuration = 2.0f;
        FSlateNotificationManager::Get().AddNotification(Info);
    }

    void CollectButtons(const TSharedRef<SWidget>& Widget, TArray<TSharedRef<SButton>>& Out)
    {
        if (Widget->GetType() == TEXT("SButton")) Out.Add(StaticCastSharedRef<SButton>(Widget));
        FChildren* Children = Widget->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I) CollectButtons(Children->GetChildAt(I), Out);
    }

    bool ContainsWidget(const TSharedRef<SWidget>& Root, const TSharedRef<SWidget>& Target)
    {
        if (Root == Target) return true;
        FChildren* Children = Root->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I)
            if (ContainsWidget(Children->GetChildAt(I), Target)) return true;
        return false;
    }

    FString FirstText(const TSharedRef<SWidget>& Widget)
    {
        if (Widget->GetType() == TEXT("STextBlock"))
            return StaticCastSharedRef<STextBlock>(Widget)->GetText().ToString();
        FChildren* Children = Widget->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I)
        {
            const FString Value = FirstText(Children->GetChildAt(I));
            if (!Value.IsEmpty()) return Value;
        }
        return FString();
    }

}

void HaybaChatFocus::ReplaceActivityContent(const TSharedRef<SBox>& Slot, const TSharedRef<SWidget>& Content)
{
    TSharedPtr<SWidget> Focused = FSlateApplication::IsInitialized()
        ? FSlateApplication::Get().GetKeyboardFocusedWidget() : nullptr;
    FString FocusedAction;
    bool bFocusedHeader = false;
    if (Focused.IsValid())
    {
        TArray<TSharedRef<SButton>> OldButtons;
        CollectButtons(Slot, OldButtons);
        for (int32 I = 0; I < OldButtons.Num(); ++I)
        {
            if (!ContainsWidget(OldButtons[I], Focused.ToSharedRef())) continue;
            bFocusedHeader = I == 0;
            if (!bFocusedHeader) FocusedAction = FirstText(OldButtons[I]);
            break;
        }
    }
    Slot->SetContent(Content);
    if (!bFocusedHeader && FocusedAction.IsEmpty()) return;

    TArray<TSharedRef<SButton>> NewButtons;
    CollectButtons(Content, NewButtons);
    if (NewButtons.IsEmpty()) return;
    TSharedRef<SButton> FocusTarget = NewButtons[0]; // A removed action returns focus to the activity header.
    if (!bFocusedHeader)
        for (int32 I = 1; I < NewButtons.Num(); ++I)
            if (FirstText(NewButtons[I]) == FocusedAction) { FocusTarget = NewButtons[I]; break; }
    FSlateApplication::Get().SetKeyboardFocus(FocusTarget, EFocusCause::SetDirectly);
}

bool HaybaChatText::IsSafeWebLink(const FString& Target)
{
    // Deliberately narrow: no OS protocols, credentials, local paths, ports,
    // Unicode host spoofing or shell metacharacters passed to LaunchURL.
    if (!Target.StartsWith(TEXT("https://"), ESearchCase::CaseSensitive) || Target.Len() > 2048) return false;
    for (TCHAR C : Target)
        if (C <= 32 || C >= 127 || FString(TEXT("\\\"'<>`|^{}")).Contains(FString::Chr(C))) return false;
    FString Host = Target.Mid(8);
    int32 End = Host.Len();
    for (TCHAR Delimiter : FString(TEXT("/?#")))
    {
        int32 At;
        if (Host.FindChar(Delimiter, At)) End = FMath::Min(End, At);
    }
    Host.LeftInline(End);
    if (!Host.Contains(TEXT(".")) || Host.StartsWith(TEXT(".")) || Host.EndsWith(TEXT("."))) return false;
    TArray<FString> Labels;
    Host.ParseIntoArray(Labels, TEXT("."), false);
    for (const FString& Label : Labels)
    {
        if (Label.IsEmpty() || Label.Len() > 63 || Label.StartsWith(TEXT("-")) || Label.EndsWith(TEXT("-"))) return false;
        for (TCHAR C : Label) if (!FChar::IsAlnum(C) && C != '-') return false;
    }
    if (Labels.Last().Len() < 2) return false;
    for (TCHAR C : Labels.Last()) if (!FChar::IsAlpha(C)) return false;
    return true;
}

bool HaybaChatText::IsSafeAssetReference(const FString& Target)
{
    // Content Browser navigation only; never load an object or execute a path.
    if (!Target.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive) || Target.Len() > 1024) return false;
    for (TCHAR C : Target)
        if (C >= 127 || (!FChar::IsAlnum(C) && C != '_' && C != '/' && C != '.')) return false;
    return !Target.Contains(TEXT("..")) && FPackageName::IsValidObjectPath(Target);
}

TArray<HaybaChatText::FBlock> HaybaChatText::Parse(const FString& Text)
{
    TArray<FBlock> Result;
    TArray<FString> Lines;
    Text.Replace(TEXT("\r\n"), TEXT("\n")).ParseIntoArray(Lines, TEXT("\n"), false);
    FBlock Paragraph;
    auto FlushParagraph = [&]()
    {
        if (!Paragraph.Text.IsEmpty()) Result.Add(MoveTemp(Paragraph));
        Paragraph = FBlock{};
    };
    bool bCode = false;
    FBlock Code;
    for (int32 Index = 0; Index < Lines.Num(); ++Index)
    {
        const FString& Line = Lines[Index];
        if (bCode)
        {
            if (Line.TrimStartAndEnd() == TEXT("```"))
            {
                Result.Add(MoveTemp(Code));
                bCode = false;
            }
            else Code.Text += Line + (Index + 1 < Lines.Num() ? TEXT("\n") : TEXT(""));
            continue;
        }
        if (Line.StartsWith(TEXT("```")) && !Line.Mid(3).Contains(TEXT("`")))
        {
            FlushParagraph();
            Code = FBlock{};
            Code.Kind = EBlock::Code;
            Code.Label = Line.Mid(3).TrimStartAndEnd().Left(32);
            bCode = true;
            continue;
        }
        if (Line.TrimStartAndEnd().IsEmpty()) { FlushParagraph(); continue; }
        int32 MarkerLength = 0;
        if (Line.StartsWith(TEXT("- ")) || Line.StartsWith(TEXT("* ")) || Line.StartsWith(TEXT("+ "))) MarkerLength = 2;
        else
        {
            int32 Digit = 0;
            while (Digit < Line.Len() && Digit < 9 && FChar::IsDigit(Line[Digit])) ++Digit;
            if (Digit > 0 && Line.Mid(Digit, 2) == TEXT(". ")) MarkerLength = Digit + 2;
        }
        if (MarkerLength > 0)
        {
            FlushParagraph();
            FBlock Item;
            Item.Kind = EBlock::ListItem;
            Item.Label = Line.Left(MarkerLength).TrimEnd();
            Item.Text = Line.Mid(MarkerLength);
            Result.Add(MoveTemp(Item));
            continue;
        }
        int32 Heading = 0;
        while (Heading < Line.Len() && Heading < 6 && Line[Heading] == '#') ++Heading;
        if (Heading > 0 && Line.IsValidIndex(Heading) && Line[Heading] == ' ')
        {
            FlushParagraph();
            FBlock Item;
            Item.Kind = EBlock::Heading;
            Item.Text = Line.Mid(Heading + 1);
            Result.Add(MoveTemp(Item));
            continue;
        }
        // Only a complete standalone link is recognized. Inline/HTML/image
        // markup, unknown protocols and approval-looking text remain literal.
        const int32 Split = Line.Find(TEXT("]("));
        if (Line.StartsWith(TEXT("[")) && Split > 1 && Line.EndsWith(TEXT(")")))
        {
            const FString Target = Line.Mid(Split + 2, Line.Len() - Split - 3);
            if (IsSafeWebLink(Target) || IsSafeAssetReference(Target))
            {
                FlushParagraph();
                FBlock Link;
                Link.Kind = EBlock::Link;
                Link.Text = Line.Left(Split).Mid(1);
                Link.Target = Target;
                Result.Add(MoveTemp(Link));
                continue;
            }
        }
        if (!Paragraph.Text.IsEmpty()) Paragraph.Text += TEXT("\n");
        Paragraph.Text += Line;
    }
    FlushParagraph();
    if (bCode) Result.Add(MoveTemp(Code));
    return Result;
}

void SHaybaChatMessageBody::Construct(const FArguments& Args)
{
    bPlainText = Args._PlainText;
    ChildSlot [ SAssignNew(Stack, SVerticalBox) ];
}

SHaybaChatMessageBody::FRenderedBlock SHaybaChatMessageBody::BuildBlock(const HaybaChatText::FBlock& Block)
{
    FRenderedBlock Rendered;
    Rendered.Block = Block;
    const bool bCode = Block.Kind == HaybaChatText::EBlock::Code;
    const FTextBlockStyle& Style = FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Body");
    SAssignNew(Rendered.Text, SMultiLineEditableText)
        .Text(FText::FromString(Block.Text))
        .TextStyle(&Style)
        .Font(bCode ? FCoreStyle::GetDefaultFontStyle("Mono", 11) : FHaybaMCPStyle::Font(13, Block.Kind == HaybaChatText::EBlock::Heading))
        .IsReadOnly(true).AutoWrapText(true).WrapTextAt(720.f)
        .WrappingPolicy(ETextWrappingPolicy::AllowPerCharacterWrapping)
        .LineHeightPercentage(1.2f).Margin(FMargin(0.f));
    Rendered.Widget = Rendered.Text;
    if (Block.Kind == HaybaChatText::EBlock::ListItem)
    {
        Rendered.Widget = SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 8.f, 0.f)
            [ SNew(STextBlock).Text(FText::FromString(Block.Label)).Font(FHaybaMCPStyle::Font(13)) ]
            + SHorizontalBox::Slot().FillWidth(1.f) [ Rendered.Text.ToSharedRef() ];
    }
    else if (bCode)
    {
        const TWeakPtr<SMultiLineEditableText> WeakText = Rendered.Text;
        Rendered.Widget = SNew(SBorder)
            .BorderImage(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Settings.Section"))).Padding(10.f)
            [ SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 6.f)
                [ SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                    [ SNew(STextBlock).Text(FText::FromString(Block.Label.IsEmpty() ? TEXT("Code") : Block.Label))
                        .Font(FHaybaMCPStyle::Font(11)).OverflowPolicy(ETextOverflowPolicy::Ellipsis) ]
                    + SHorizontalBox::Slot().AutoWidth()
                    [ SNew(SButton).ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                        .Text(LOCTEXT("CopyCode", "Copy code")).ToolTipText(LOCTEXT("CopyCodeTip", "Copy the complete code block, without fences"))
                        .OnClicked_Lambda([WeakText]()
                        {
                            if (const auto Text = WeakText.Pin()) FPlatformApplicationMisc::ClipboardCopy(*Text->GetText().ToString());
                            return FReply::Handled();
                        }) ] ]
                + SVerticalBox::Slot().AutoHeight() [ Rendered.Text.ToSharedRef() ] ];
    }
    else if (Block.Kind == HaybaChatText::EBlock::Link)
    {
        const FString Target = Block.Target;
        const bool bAsset = HaybaChatText::IsSafeAssetReference(Target);
        FString Host = bAsset ? FString() : Target.Mid(8);
        if (!bAsset)
        {
            int32 End = Host.Len();
            for (TCHAR Delimiter : FString(TEXT("/?#")))
            {
                int32 At;
                if (Host.FindChar(Delimiter, At)) End = FMath::Min(End, At);
            }
            Host.LeftInline(End);
        }
        const FText ActionLabel = bAsset ? LOCTEXT("ShowLinkedAsset", "Show asset") :
            FText::FromString(TEXT("Open ") + Host);
        Rendered.Widget = SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight() [ Rendered.Text.ToSharedRef() ]
            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left).Padding(0.f, 3.f)
            [ SNew(SButton).ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                .ToolTipText_Lambda([Target, bAsset]()
                {
                    if (!bAsset) return FText::FromString(Target);
                    const FAssetData Current = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetByObjectPath(FSoftObjectPath(Target));
                    return FText::FromString(Current.IsValid() ? Target : TEXT("Asset not found in this project's registry:\n") + Target);
                })
                .IsEnabled_Lambda([Target, bAsset]()
                {
                    return !bAsset || FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetByObjectPath(FSoftObjectPath(Target)).IsValid();
                })
                .OnClicked_Lambda([Target, bAsset]()
                {
                    if (bAsset && HaybaChatText::IsSafeAssetReference(Target))
                    {
                        const FAssetData Current = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetByObjectPath(FSoftObjectPath(Target));
                        if (Current.IsValid()) FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).Get().SyncBrowserToAssets(TArray<FAssetData>{Current});
                    }
                    else if (HaybaChatText::IsSafeWebLink(Target)) FPlatformProcess::LaunchURL(*Target, nullptr, nullptr);
                    return FReply::Handled();
                })
                [ SNew(STextBlock).Text(ActionLabel).Font(FHaybaMCPStyle::Font(11))
                    .OverflowPolicy(ETextOverflowPolicy::Ellipsis) ] ];
    }
    return Rendered;
}

void SHaybaChatMessageBody::SetMessageText(const FString& Text)
{
    PendingText = Text;
    if (Text == DisplayedText) { bPendingUpdate = false; bWaitingForSelection = false; return; }
    // A selected block whose grammar changed cannot be replaced yet. Keep the
    // latest source without reparsing it on every subsequent SSE delta.
    if (bWaitingForSelection && Blocks.ContainsByPredicate([](const FRenderedBlock& Block) { return Block.Text->AnyTextSelected(); }))
    { bPendingUpdate = true; return; }
    const double Now = FPlatformTime::Seconds();
    // SSE can deliver hundreds of tiny deltas. Beyond a short message, coalesce
    // appended display updates to about 20 Hz so parsing/layout cannot consume
    // the game thread once per token. PendingText still retains every byte.
    if (!bPlainText && Text.Len() > 4096 && !DisplayedText.IsEmpty() &&
        Text.StartsWith(DisplayedText, ESearchCase::CaseSensitive) &&
        Now - LastRenderedAt < 0.05)
    { bPendingUpdate = true; return; }
    TArray<HaybaChatText::FBlock> Parsed;
    if (bPlainText)
    {
        if (!Text.IsEmpty()) { HaybaChatText::FBlock Block; Block.Text = Text; Parsed.Add(MoveTemp(Block)); }
    }
    else Parsed = HaybaChatText::Parse(Text);
    auto SameShape = [](const HaybaChatText::FBlock& A, const HaybaChatText::FBlock& B)
    { return A.Kind == B.Kind && A.Label == B.Label && A.Target == B.Target; };
    // A partially typed delimiter can change the grammar. Do not discard a
    // user's selection to promote it; retry the display update after selection ends.
    for (int32 I = 0; I < Blocks.Num(); ++I)
    {
        if (Blocks[I].Text->AnyTextSelected() && (!Parsed.IsValidIndex(I) || !SameShape(Blocks[I].Block, Parsed[I]) ||
            !Parsed[I].Text.StartsWith(Blocks[I].Block.Text, ESearchCase::CaseSensitive)))
        { bPendingUpdate = true; bWaitingForSelection = true; return; }
    }
    while (Blocks.Num() > Parsed.Num())
    {
        Stack->RemoveSlot(Blocks.Last().Widget.ToSharedRef());
        Blocks.Pop();
    }
    for (int32 I = 0; I < Parsed.Num(); ++I)
    {
        if (!Blocks.IsValidIndex(I))
        {
            Blocks.Add(BuildBlock(Parsed[I]));
            Stack->AddSlot().AutoHeight().Padding(0.f, I == 0 ? 0.f : 8.f, 0.f, 0.f) [ Blocks[I].Widget.ToSharedRef() ];
        }
        else if (!SameShape(Blocks[I].Block, Parsed[I]))
        {
            Stack->RemoveSlot(Blocks[I].Widget.ToSharedRef());
            Blocks[I] = BuildBlock(Parsed[I]);
            Stack->InsertSlot(I).AutoHeight().Padding(0.f, I == 0 ? 0.f : 8.f, 0.f, 0.f) [ Blocks[I].Widget.ToSharedRef() ];
        }
        else if (Blocks[I].Block.Text != Parsed[I].Text)
        {
            const bool bSelected = Blocks[I].Text->AnyTextSelected();
            const FTextSelection Selection = Blocks[I].Text->GetSelection();
            Blocks[I].Text->SetText(FText::FromString(Parsed[I].Text));
            if (bSelected) Blocks[I].Text->SelectText(Selection.GetBeginning(), Selection.GetEnd());
            Blocks[I].Block = Parsed[I];
        }
    }
    DisplayedText = Text;
    LastRenderedAt = Now;
    bPendingUpdate = false;
    bWaitingForSelection = false;
}

void SHaybaChatMessageBody::Tick(const FGeometry& Geometry, double Time, float Delta)
{
    SCompoundWidget::Tick(Geometry, Time, Delta);
    if (!bPendingUpdate) return;
    if (bWaitingForSelection)
    {
        if (Blocks.ContainsByPredicate([](const FRenderedBlock& Block) { return Block.Text->AnyTextSelected(); })) return;
    }
    else if (FPlatformTime::Seconds() - LastRenderedAt < 0.05) return;
    SetMessageText(PendingText);
}

// ── Construct ──────────────────────────────────────────────────────────────

void SHaybaMCPChatPanel::Construct(const FArguments&, FHaybaMCPModule* InModule)
{
    Module = InModule;
    ModelDiscoveryClient = MakeShared<FHaybaMCPModelDiscoveryClient>();

    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 6.f)
        [
            SNew(SBorder).BorderImage(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Settings.Section"))).Padding(14.f)
            .Visibility_Lambda([this]() { return Module && !Module->PendingExternalPlan.IsEmpty() ? EVisibility::Visible : EVisibility::Collapsed; })
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight()
                [ SNew(STextBlock).Text(LOCTEXT("ExternalPlanTitle", "Review external plan"))
                    .Font(FHaybaMCPStyle::Font(15, true)) ]
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 10.f, 0.f, 4.f)
                [ SNew(SBox).MaxDesiredHeight(230.f)
                    [ SNew(SScrollBox) + SScrollBox::Slot()
                        [ SAssignNew(ExternalPlanStepsBox, SVerticalBox) ] ] ]
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 0.f)
                [ SNew(STextBlock).Text_Lambda([]()
                    {
                        return FHaybaMCPSettings::Get().bPlanApprovalStrictConsume
                            ? LOCTEXT("ExternalPlanScopeOnce", "Allows one destructive command from this client.")
                            : LOCTEXT("ExternalPlanScopePlan", "Allows this client's destructive commands until a new plan replaces it.");
                    })
                    .Font(FHaybaMCPStyle::Font(11)).AutoWrapText(true)
                    .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"))) ]
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 12.f, 0.f, 0.f)
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth()
                    [ SNew(SButton)
                        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Review.Primary"))
                        .ContentPadding(FMargin(14.f, 7.f))
                        .OnClicked_Lambda([this]() { if (Module) Module->ResolveExternalPlan(true); return FReply::Handled(); })
                        [ SNew(STextBlock).Text(LOCTEXT("ExternalApprove", "Approve plan"))
                            .Font(FHaybaMCPStyle::Font(12, true))
                            .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Surface.Canvas"))) ] ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f)
                    [ SNew(SButton)
                        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                        .ContentPadding(FMargin(14.f, 7.f))
                        .OnClicked_Lambda([this]() { if (Module) Module->ResolveExternalPlan(false); return FReply::Handled(); })
                        [ SNew(STextBlock).Text(LOCTEXT("ExternalReject", "Reject"))
                            .Font(FHaybaMCPStyle::Font(12)) ] ]
                ]
            ]
        ]

        // The conversation is one uninterrupted surface; the new-message
        // control floats above it only when the user has scrolled away.
        + SVerticalBox::Slot().FillHeight(1.f).Padding(0.f)
        [
            SNew(SOverlay)
            + SOverlay::Slot() [ BuildChatArea() ]
            + SOverlay::Slot()
            .HAlign(HAlign_Right).VAlign(VAlign_Bottom)
            .Padding(FMargin(0.f, 0.f, 18.f, 18.f))
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                .ContentPadding(FMargin(10.f, 4.f))
                .Visibility(this, &SHaybaMCPChatPanel::GetNewMessagesChipVisibility)
                .OnClicked_Lambda([this]()
                {
                    UnseenWhileScrolledUp = 0;
                    if (ChatScrollBox.IsValid()) ChatScrollBox->ScrollToEnd();
                    return FReply::Handled();
                })
                [
                    SNew(STextBlock).Text_Lambda([this]()
                    {
                        return FText::Format(LOCTEXT("NewMessages", "{0} new messages"), FText::AsNumber(UnseenWhileScrolledUp));
                    })
                ]
            ]
        ]

        // Keep the composer as the only persistent bottom control.
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 8.f, 12.f, 12.f)
        [ BuildInput() ]
    ];

    RebuildChat();
    RebuildExternalProposal();
    RefreshRecentSessions();
}

void SHaybaMCPChatPanel::Tick(const FGeometry& Geometry, double Time, float Delta)
{
    SCompoundWidget::Tick(Geometry, Time, Delta);
    const FString CurrentId = Module ? Module->PendingExternalPlanId : FString();
    if (CurrentId != DisplayedExternalPlanId) RebuildExternalProposal();
}

void SHaybaMCPChatPanel::RebuildExternalProposal()
{
    if (!ExternalPlanStepsBox.IsValid()) return;
    ExternalPlanStepsBox->ClearChildren();
    DisplayedExternalPlanId = Module ? Module->PendingExternalPlanId : FString();
    if (!Module || Module->PendingExternalPlan.IsEmpty()) return;
    if (Module->PendingExternalSteps.IsEmpty())
    {
        ExternalPlanStepsBox->AddSlot().AutoHeight()
        [ SNew(STextBlock).Text(FText::FromString(Module->PendingExternalPlan))
            .Font(FHaybaMCPStyle::Font(12)).AutoWrapText(true) ];
        return;
    }
    for (int32 Index = 0; Index < Module->PendingExternalSteps.Num(); ++Index)
    {
        const FHaybaExternalPlanStep& Step = Module->PendingExternalSteps[Index];
        TSharedRef<SVerticalBox> Content = SNew(SVerticalBox);
        Content->AddSlot().AutoHeight()
        [ SNew(STextBlock).Text(FText::FromString(Step.Title))
            .Font(FHaybaMCPStyle::Font(12, true)).AutoWrapText(true) ];
        if (!Step.Description.IsEmpty())
            Content->AddSlot().AutoHeight().Padding(0.f, 3.f, 0.f, 0.f)
            [ SNew(STextBlock).Text(FText::FromString(Step.Description))
                .Font(FHaybaMCPStyle::Font(11)).AutoWrapText(true)
                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"))) ];
        if (!Step.Tool.IsEmpty())
            Content->AddSlot().AutoHeight().Padding(0.f, 3.f, 0.f, 0.f)
            [ SNew(STextBlock).Text(FText::FromString(Step.Tool))
                .Font(FHaybaMCPStyle::Font(10))
                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Muted"))) ];
        ExternalPlanStepsBox->AddSlot().AutoHeight().Padding(0.f, 3.f, 0.f, 7.f)
        [ SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 1.f, 12.f, 0.f)
            [ SNew(STextBlock).Text(FText::AsNumber(Index + 1))
                .Font(FHaybaMCPStyle::Font(11))
                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Muted"))) ]
            + SHorizontalBox::Slot().FillWidth(1.f) [ Content ] ];
    }
}

SHaybaMCPChatPanel::~SHaybaMCPChatPanel()
{
    InspectGeneration.Invalidate();
    if (ModelDiscoveryClient.IsValid()) ModelDiscoveryClient->Cancel();
    // Tear down the streaming client: clear our delegate bindings so a late HTTP
    // tick can't fan out into this destroyed panel, then cancel the stream. The
    // client itself captures a weak ptr, so the ordering is belt-and-braces.
    if (AgentClient.IsValid())
    {
        AgentClient->OnTextDelta.RemoveAll(this);
        AgentClient->OnActivityEvent.RemoveAll(this);
        AgentClient->OnDone.RemoveAll(this);
        AgentClient->OnError.RemoveAll(this);
        AgentClient->Cancel();
        AgentClient.Reset();
    }
}

// ── Task switcher hosted in the shared dock header ────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildTaskSwitcher()
{
    return SAssignNew(TaskSwitcherButton, SComboButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
        .HasDownArrow(false)
        .ContentPadding(FMargin(9.f, 5.f))
        .ToolTipText(LOCTEXT("RecentTT", "Current conversation and recent conversations"))
        .ButtonContent()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [
                SNew(STextBlock).Text_Lambda([this]()
                {
                    if (Session.Goal.IsEmpty()) return LOCTEXT("ConvUntitled", "New conversation");
                    return FText::FromString(Session.Goal.Len() > 60
                        ? Session.Goal.Left(60) + TEXT("…") : Session.Goal);
                })
                .Font(FHaybaMCPStyle::Font(13, true))
                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Primary")))
                .OverflowPolicy(ETextOverflowPolicy::Ellipsis)
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
            [ SNew(SImage)
                .Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Chevron.Down")))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary")))) ]
        ]
        .OnGetMenuContent(this, &SHaybaMCPChatPanel::BuildRecentSessionsMenu);
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildRecentSessionsMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    if (!RecentSessionsStatus.IsEmpty())
    {
        Items->AddSlot().AutoHeight().Padding(10.f, 6.f)
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
            .AutoWrapText(true)
            .Text(FText::FromString(RecentSessionsStatus))
        ];
    }
    if (RecentSessions.IsEmpty())
    {
        Items->AddSlot().AutoHeight().Padding(10.f, 8.f)
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
            .Text(LOCTEXT("RecentEmpty", "No saved conversations"))
        ];
    }
    for (const FRecentSession& Recent : RecentSessions)
    {
        const FString Id = Recent.Id;
        Items->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(FText::FromString(Recent.Title), FOnClicked::CreateLambda([this, Id]()
            {
                if (TaskSwitcherButton.IsValid()) TaskSwitcherButton->SetIsOpen(false);
                OpenSavedSession(Id);
                return FReply::Handled();
            }), Id == Session.SessionId, FText::GetEmpty(),
                !bIsStreaming && !bAwaitingPlanApproval && !bLoadingSession)
        ];
    }
    Items->AddSlot().AutoHeight().Padding(0.f, 7.f, 0.f, 0.f)
    [
        FHaybaMCPStyle::PopupRow(LOCTEXT("RefreshRecent", "Refresh conversations"),
            FOnClicked::CreateLambda([this]()
            {
                if (TaskSwitcherButton.IsValid()) TaskSwitcherButton->SetIsOpen(false);
                RefreshRecentSessions();
                return FReply::Handled();
            }))
    ];
    return FHaybaMCPStyle::PopupSurface(Items, 230.f);
}

void SHaybaMCPChatPanel::RefreshRecentSessions()
{
    RecentSessionsStatus = TEXT("Refreshing conversations…");
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(FHaybaMCPSettings::Get().SidecarURL / TEXT("chat/sessions"));
    Request->SetVerb(TEXT("GET"));
    TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakSelf](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
    {
        TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin();
        if (!Self.IsValid()) return;
        if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200)
        {
            Self->RecentSessionsStatus = TEXT("Could not refresh conversations.");
            return;
        }
        TSharedPtr<FJsonObject> Root;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Root) || !Root.IsValid())
        {
            Self->RecentSessionsStatus = TEXT("Could not read conversations.");
            return;
        }
        const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
        if (!Root->TryGetArrayField(TEXT("sessions"), Items))
        {
            Self->RecentSessionsStatus = TEXT("Could not read conversations.");
            return;
        }
        TArray<FRecentSession> Loaded;
        for (const TSharedPtr<FJsonValue>& Item : *Items)
        {
            const TSharedPtr<FJsonObject> Object = Item.IsValid() ? Item->AsObject() : nullptr;
            if (!Object.IsValid()) continue;
            FRecentSession Recent;
            if (!Object->TryGetStringField(TEXT("id"), Recent.Id) || Recent.Id.IsEmpty()) continue;
            Object->TryGetStringField(TEXT("title"), Recent.Title);
            Object->TryGetStringField(TEXT("updatedAt"), Recent.UpdatedAt);
            if (Recent.Title.IsEmpty()) Recent.Title = TEXT("New conversation");
            Loaded.Add(MoveTemp(Recent));
        }
        Self->RecentSessions = MoveTemp(Loaded);
        Self->RecentSessionsStatus.Empty();
    });
    if (!Request->ProcessRequest()) RecentSessionsStatus = TEXT("Could not start conversation refresh.");
}

void SHaybaMCPChatPanel::OpenSavedSession(const FString& SavedId)
{
    if (bIsStreaming || bAwaitingPlanApproval || bLoadingSession) return;
    bLoadingSession = true;
    PendingSessionId = SavedId;
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(FHaybaMCPSettings::Get().SidecarURL / TEXT("chat/sessions") / SavedId);
    Request->SetVerb(TEXT("GET"));
    TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
    Request->OnProcessRequestComplete().BindLambda([WeakSelf, SavedId](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
    {
        TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin();
        if (!Self.IsValid() || Self->PendingSessionId != SavedId) return;
        Self->PendingSessionId.Empty();
        Self->bLoadingSession = false;
        TSharedPtr<FJsonObject> Root;
        if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200 ||
            !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Root) || !Root.IsValid())
        {
            Self->AddSystemError(TEXT("Could not load the saved conversation."), TEXT(""));
            return;
        }
        FString ReturnedId;
        const TArray<TSharedPtr<FJsonValue>>* Messages = nullptr;
        if (!Root->TryGetStringField(TEXT("id"), ReturnedId) || ReturnedId != SavedId ||
            !Root->TryGetArrayField(TEXT("messages"), Messages)) return;
        Self->OnNewConversation();
        Self->EnsureAgentClient();
        if (!Self->AgentClient->AdoptSavedSession(SavedId)) return;
        const TSharedPtr<FJsonObject>* TurnSettings = nullptr;
        if (Root->TryGetObjectField(TEXT("turnSettings"), TurnSettings) && TurnSettings && TurnSettings->IsValid())
        {
            FString Value;
            if ((*TurnSettings)->TryGetStringField(TEXT("provider"), Value))
                Self->RestoredProviderId = Value;
            if ((*TurnSettings)->TryGetStringField(TEXT("loop"), Value) &&
                (Value == TEXT("community") || Value == TEXT("pro")))
                Self->RestoredLoop = Value;
            if ((*TurnSettings)->TryGetStringField(TEXT("mode"), Value) &&
                (Value == TEXT("explore") || Value == TEXT("draft") || Value == TEXT("production")))
                Self->WorkMode = Value;
            if ((*TurnSettings)->TryGetStringField(TEXT("model"), Value) && ValidModelId(Value))
            {
                Self->TaskModelId = Value;
                Self->TaskModelProviderId = Self->RestoredProviderId.IsEmpty()
                    ? FHaybaMCPSettings::Get().SelectedProviderId : Self->RestoredProviderId;
            }
            if ((*TurnSettings)->TryGetStringField(TEXT("reasoningEffort"), Value) &&
                Value.Len() <= 32 && !Value.IsEmpty() && SupportsReasoningEffort(Self->RestoredProviderId, Value))
                Self->ReasoningEffort = Value;
        }
        for (const TSharedPtr<FJsonValue>& Value : *Messages)
        {
            const TSharedPtr<FJsonObject> Message = Value.IsValid() ? Value->AsObject() : nullptr;
            if (!Message.IsValid()) continue;
            FString Role, Content;
            if (!Message->TryGetStringField(TEXT("role"), Role) || !Message->TryGetStringField(TEXT("content"), Content)) continue;
            if (Role != TEXT("user") && Role != TEXT("assistant")) continue;
            FHaybaMCPChatMessage Row{};
            Row.bFromUser = Role == TEXT("user");
            Row.Text = Content;
            Self->Session.Messages.Add(MoveTemp(Row));
            if (Self->Session.Goal.IsEmpty() && Role == TEXT("user")) Self->Session.Goal = Content;
        }
        Self->Session.SessionId = SavedId;
        Self->RebuildChat();
        Self->ScrollToBottomIfPinned();
        if (Self->Module)
        {
            if (TSharedPtr<SHaybaMCPMainPanel> Main = Self->Module->MainPanel.Pin())
                Main->ShowPanel(EHaybaPanel::Chat);
        }
    });
    Request->ProcessRequest();
}

// ── Chat scroll ───────────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildChatArea()
{
    SAssignNew(ChatScrollBox, SScrollBox)
        .Orientation(Orient_Vertical)
        .OnUserScrolled_Lambda([this](float /*Offset*/)
        {
            // User actively scrolling — reset the "↓ N new" chip if they
            // scrolled back to the bottom themselves.
            if (IsScrolledNearBottom()) UnseenWhileScrolledUp = 0;
        });
    return SNew(SOverlay)
        + SOverlay::Slot().Padding(FMargin(16.f, 10.f, 16.f, 8.f))
        [ ChatScrollBox.ToSharedRef() ]
        + SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
        [
            SNew(SBox)
            .Visibility_Lambda([this]() { return Session.Messages.IsEmpty() &&
                (!Module || Module->PendingExternalPlan.IsEmpty())
                ? EVisibility::Visible : EVisibility::Collapsed; })
            [ BuildEmptyState() ]
        ];
}

// ── Input area (inline send / stop, Q7-a) ─────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildInput()
{
    return SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Composer")))
        .Padding(FMargin(12.f, 10.f, 10.f, 8.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SBox).MinDesiredHeight(58.f).MaxDesiredHeight(220.f)
                [
                    SAssignNew(InputBox, SMultiLineEditableTextBox)
                    .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Composer"))
                    .AutoWrapText(true)
                    .Padding(FMargin(2.f, 2.f))
                    .Font(FHaybaMCPStyle::Font(13))
                    .HintText_Lambda([this]() { return bAwaitingPlanApproval
                        ? LOCTEXT("InputAwait", "Review the proposed action above to continue.")
                        : bIsStreaming ? LOCTEXT("InputNext", "Draft your next message…")
                        : LOCTEXT("InputPrompt", "Ask Hayba…"); })
                    // Keep the draft editable while a turn runs or approval is
                    // pending. OnSendCurrentInput owns the submission gate and
                    // leaves a blocked draft intact.
                    .OnKeyDownHandler_Lambda([this](const FGeometry&, const FKeyEvent& Key) -> FReply
                    {
                        if (Key.GetKey() == EKeys::Enter && !Key.IsShiftDown())
                        {
                            OnSendCurrentInput();
                            return FReply::Handled();
                        }
                        return FReply::Unhandled();
                    })
                ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 5.f, 0.f, 0.f)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SAssignNew(WorkModeButton, SComboButton)
                    .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
                    .HasDownArrow(false)
                    .ContentPadding(FMargin(4.f, 4.f))
                    .IsEnabled_Lambda([this]() { return !bIsStreaming && !bAwaitingPlanApproval; })
                    .ToolTipText(LOCTEXT("WorkModeTip", "Access for the next run. Inspect reads only; Draft and Production require approval for changes."))
                    .ButtonContent()
                    [
                        SNew(SHorizontalBox)
                        + SHorizontalBox::Slot().AutoWidth()
                        [
                            SNew(STextBlock)
                            .Text_Lambda([this]() { return FText::FromString(WorkMode == TEXT("explore")
                                ? TEXT("Inspect") : WorkMode == TEXT("draft") ? TEXT("Draft") : TEXT("Production")); })
                            .Font(FHaybaMCPStyle::Font(11, true))
                            .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary")))
                        ]
                        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(7.f, 0.f, 0.f, 0.f)
                        [ SNew(SImage)
                            .Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Chevron.Down")))
                            .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"))) ]
                    ]
                    .OnGetMenuContent(this, &SHaybaMCPChatPanel::BuildWorkModeMenu)
                ]
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(7.f, 0.f, 4.f, 0.f)
                [ SNew(SBox).MaxDesiredWidth(230.f)
                    [ SAssignNew(ModelButton, SComboButton)
                        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
                        .HasDownArrow(false).ContentPadding(FMargin(4.f, 4.f))
                        .IsEnabled_Lambda([this]() { return !bIsStreaming && !bAwaitingPlanApproval && !IsSubscriptionModel(); })
                        .ToolTipText_Lambda([this]()
                        {
                            if (IsSubscriptionModel()) return LOCTEXT("SubscriptionModelTip", "Hayba Pro selects a subscription model for this run.");
                            const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
                            const FHaybaProviderInfo* Provider = FHaybaMCPSettings::FindProvider(Settings.SelectedProviderId);
                            return FText::FromString(FString(Provider ? Provider->Label : *Settings.SelectedProviderId)
                                + TEXT(" · ") + EffectiveModelId());
                        })
                        .ButtonContent()
                        [ SNew(SHorizontalBox)
                            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                            [ SNew(STextBlock)
                                .Text_Lambda([this]() { return FText::FromString(IsSubscriptionModel()
                                    ? TEXT("Hayba Pro") : EffectiveModelId().IsEmpty()
                                        ? TEXT("Choose model") : EffectiveModelId()); })
                                .Font(FHaybaMCPStyle::Font(11))
                                .OverflowPolicy(ETextOverflowPolicy::Ellipsis)
                                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"))) ]
                            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4.f, 0.f, 0.f, 0.f)
                            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Chevron.Down")))
                                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"))) ] ]
                        .OnGetMenuContent(this, &SHaybaMCPChatPanel::BuildModelMenu) ] ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 4.f, 0.f)
                [ SAssignNew(EffortButton, SComboButton)
                    .Visibility_Lambda([this]() { return HasEffortChoices() ? EVisibility::Visible : EVisibility::Collapsed; })
                    .IsEnabled_Lambda([this]() { return !bIsStreaming && !bAwaitingPlanApproval; })
                    .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
                    .HasDownArrow(false).ContentPadding(FMargin(4.f, 4.f))
                    .ToolTipText(LOCTEXT("ReasoningEffortTip", "Reasoning effort for the next run"))
                    .ButtonContent()
                    [ SNew(STextBlock)
                        .Text_Lambda([this]()
                        {
                            const FHaybaMCPDiscoveredModel* Model = SelectedDiscoveredModel();
                            return FText::FromString(ReasoningEffort.IsEmpty() ||
                                (Model && !Model->ReasoningEfforts.Contains(ReasoningEffort))
                                ? TEXT("Default") : ReasoningEffort);
                        })
                        .Font(FHaybaMCPStyle::Font(11))
                        .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary"))) ]
                    .OnGetMenuContent(this, &SHaybaMCPChatPanel::BuildEffortMenu) ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(SButton)
                    .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Send"))
                    .ContentPadding(FMargin(11.f, 8.f))
                    .IsEnabled_Lambda([this]() { return bIsStreaming || (CanSend() && InputBox.IsValid() && !InputBox->GetText().IsEmpty()); })
                    .OnClicked(this, &SHaybaMCPChatPanel::OnSendOrStop)
                    .ToolTipText_Lambda([this]() { return bIsStreaming ? LOCTEXT("StopTT", "Stop generation") : LOCTEXT("SendTT", "Send message (Enter)"); })
                    [ SNew(SImage).Image_Lambda([this]() { return FHaybaMCPStyle::GetBrush(
                        bIsStreaming ? TEXT("Hayba.Icon.Stop") : TEXT("Hayba.Icon.Send")); }) ]
                ]
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildWorkModeMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    auto AddMode = [this, &Items](const FString& Id, const FText& Label, const FText& Detail)
    {
        Items->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(Label, FOnClicked::CreateLambda([this, Id]()
            {
                if (WorkModeButton.IsValid()) WorkModeButton->SetIsOpen(false);
                return OnSetWorkMode(Id);
            }), WorkMode == Id, Detail)
        ];
    };
    AddMode(TEXT("explore"), LOCTEXT("InspectMode", "Inspect"),
        LOCTEXT("InspectModeTip", "Read and explain. No project changes."));
    AddMode(TEXT("draft"), LOCTEXT("DraftMode", "Draft"),
        LOCTEXT("DraftModeTip", "Propose changes for review."));
    AddMode(TEXT("production"), LOCTEXT("ProductionMode", "Production"),
        LOCTEXT("ProductionModeTip", "Propose and verify reviewed changes."));
    return FHaybaMCPStyle::PopupSurface(Items, 230.f);
}

FString SHaybaMCPChatPanel::EffectiveModelId() const
{
    const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    if (!TaskModelId.IsEmpty() && (TaskModelProviderId.IsEmpty() ||
        TaskModelProviderId == Settings.SelectedProviderId)) return TaskModelId;
    if (!Settings.Model.IsEmpty()) return Settings.Model;
    const FHaybaProviderInfo* Provider = FHaybaMCPSettings::FindProvider(Settings.SelectedProviderId);
    return Provider && Provider->DefaultModel ? FString(Provider->DefaultModel) : FString();
}

FString SHaybaMCPChatPanel::EffectiveReasoningEffort() const
{
    if (ReasoningEffort.IsEmpty() || IsProLoopActive() ||
        !SupportsReasoningEffort(FHaybaMCPSettings::Get().SelectedProviderId, ReasoningEffort)) return FString();
    const FHaybaMCPDiscoveredModel* Model = SelectedDiscoveredModel();
    return !Model || Model->ReasoningEfforts.Contains(ReasoningEffort) ? ReasoningEffort : FString();
}

const FHaybaMCPDiscoveredModel* SHaybaMCPChatPanel::SelectedDiscoveredModel() const
{
    if (!DiscoveredModels.IsSet() ||
        DiscoveredModels->Provider != FHaybaMCPSettings::Get().SelectedProviderId) return nullptr;
    const FString Id = EffectiveModelId();
    return DiscoveredModels->Models.FindByPredicate([&Id](const FHaybaMCPDiscoveredModel& Model)
    {
        return Model.Id == Id;
    });
}

bool SHaybaMCPChatPanel::IsSubscriptionModel() const
{
    return IsProLoopActive() && FHaybaMCPSettings::Get().BrainLlmMode == TEXT("subscription");
}

bool SHaybaMCPChatPanel::HasEffortChoices() const
{
    // Hayba Pro's current session protocol does not carry per-turn effort.
    if (IsProLoopActive()) return false;
    const FHaybaMCPDiscoveredModel* Model = SelectedDiscoveredModel();
    if (!Model) return !ReasoningEffort.IsEmpty() &&
        SupportsReasoningEffort(FHaybaMCPSettings::Get().SelectedProviderId, ReasoningEffort);
    const FString& Provider = FHaybaMCPSettings::Get().SelectedProviderId;
    return Model->ReasoningEfforts.ContainsByPredicate([&Provider](const FString& Effort)
    {
        return SupportsReasoningEffort(Provider, Effort);
    });
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildModelMenu()
{
    ModelSearch.Empty();
    PendingUnverifiedModelId.Empty();
    DiscoveredModels.Reset();
    ModelMenuMessage = TEXT("Checking available models…");
    bModelDiscoveryLoading = true;
    SAssignNew(ModelMenuItems, SVerticalBox);
    RefreshModelMenuItems();

    if (ModelDiscoveryClient.IsValid())
    {
        TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
        ModelDiscoveryClient->DiscoverSavedSettings(/*bRefresh=*/true,
            [WeakSelf](FHaybaMCPModelDiscoveryResult Result)
            {
                if (const TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin())
                {
                    Self->bModelDiscoveryLoading = false;
                    Self->DiscoveredModels = MoveTemp(Result);
                    Self->ModelMenuMessage.Empty();
                    Self->RefreshModelMenuItems();
                }
            });
    }

    return FHaybaMCPStyle::PopupSurface(
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4.f, 4.f, 4.f, 7.f)
        [ SNew(SEditableTextBox)
            .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
            .HintText(LOCTEXT("ChatModelSearch", "Search models"))
            .OnTextChanged_Lambda([this](const FText& Text)
            {
                ModelSearch = Text.ToString();
                RefreshModelMenuItems();
            }) ]
        + SVerticalBox::Slot().AutoHeight()
        [ SNew(SBox).MaxDesiredHeight(310.f)
            [ SNew(SScrollBox) + SScrollBox::Slot() [ ModelMenuItems.ToSharedRef() ] ] ]
        + SVerticalBox::Slot().AutoHeight().Padding(4.f, 7.f, 4.f, 2.f)
        [ SNew(SEditableTextBox)
            .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
            .HintText(LOCTEXT("ChatExactModel", "Enter exact model ID, then press Enter"))
            .IsEnabled_Lambda([this]() { return !DiscoveredModels.IsSet() || DiscoveredModels->bManualEntryAllowed; })
            .OnTextCommitted(this, &SHaybaMCPChatPanel::OnManualModelCommitted) ], 300.f);
}

void SHaybaMCPChatPanel::RefreshModelMenuItems()
{
    if (!ModelMenuItems.IsValid()) return;
    ModelMenuItems->ClearChildren();
    auto AddNote = [this](const FText& Note)
    {
        ModelMenuItems->AddSlot().AutoHeight().Padding(8.f, 4.f, 8.f, 8.f)
        [ SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
            .AutoWrapText(true).Text(Note) ];
    };
    if (!ModelMenuMessage.IsEmpty()) AddNote(FText::FromString(ModelMenuMessage));
    if (bModelDiscoveryLoading || !DiscoveredModels.IsSet()) return;

    const FHaybaMCPModelDiscoveryResult& Result = DiscoveredModels.GetValue();
    if (!Result.Error.IsEmpty()) { AddNote(FText::FromString(Result.Error)); return; }
    if (Result.Status == EHaybaMCPModelDiscoveryStatus::NoKey)
    {
        AddNote(LOCTEXT("ChatModelsNoKey", "Add an API key in Settings to list available models."));
        return;
    }
    if (Result.Status == EHaybaMCPModelDiscoveryStatus::Manual)
    {
        AddNote(LOCTEXT("ChatModelsManual", "Enter the exact model ID for this endpoint."));
        return;
    }
    if (Result.bStale || Result.Status == EHaybaMCPModelDiscoveryStatus::Unavailable)
        AddNote(LOCTEXT("ChatModelsStale", "Availability could not be verified. This list may be stale."));
    else if (Result.bPartial)
        AddNote(LOCTEXT("ChatModelsPartial", "Only part of this provider's model list was verified."));

    int32 Matches = 0;
    for (const FHaybaMCPDiscoveredModel& Model : Result.Models)
    {
        if (!ModelSearch.IsEmpty() && !Model.Id.Contains(ModelSearch, ESearchCase::IgnoreCase) &&
            !Model.Name.Contains(ModelSearch, ESearchCase::IgnoreCase)) continue;
        if (++Matches > 40) continue;
        const bool bImpossible = Model.ChatCapability == EHaybaMCPModelChatCapability::No ||
            Model.ToolUse == EHaybaMCPModelToolUse::No;
        const bool bVerified = Model.ChatCapability == EHaybaMCPModelChatCapability::Yes &&
            (Model.ToolUse == EHaybaMCPModelToolUse::Yes || Model.ToolUse == EHaybaMCPModelToolUse::Trained);
        FText Detail = Model.Name == Model.Id ? FText::GetEmpty() : FText::FromString(Model.Name);
        if (bImpossible) Detail = LOCTEXT("ChatModelNoTools", "Not suitable for Hayba chat tools");
        else if (!bVerified) Detail = PendingUnverifiedModelId == Model.Id
            ? LOCTEXT("ChatModelConfirm", "Tool support unverified. Select again to use this model.")
            : LOCTEXT("ChatModelUnknown", "Tool support unverified. Confirmation required.");
        ModelMenuItems->AddSlot().AutoHeight()
        [ FHaybaMCPStyle::PopupRow(FText::FromString(Model.Id), FOnClicked::CreateLambda([this, Id = Model.Id, bVerified]()
            {
                if (!bVerified && PendingUnverifiedModelId != Id)
                {
                    PendingUnverifiedModelId = Id;
                    RefreshModelMenuItems();
                    return FReply::Handled();
                }
                return OnSetModel(Id);
            }), EffectiveModelId() == Model.Id, Detail, !bImpossible) ];
    }
    if (Matches == 0) AddNote(LOCTEXT("ChatNoMatchingModels", "No matching models. Enter an exact ID below."));
    else if (Matches > 40) AddNote(LOCTEXT("ChatMoreModels", "More models match. Narrow your search."));
}

FReply SHaybaMCPChatPanel::OnSetModel(const FString& ModelId)
{
    if (bIsStreaming || bAwaitingPlanApproval || !ValidModelId(ModelId)) return FReply::Handled();
    ReasoningEffort.Empty();
    PendingUnverifiedModelId.Empty();
    FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    TaskModelId = ModelId;
    TaskModelProviderId = Settings.SelectedProviderId;
    RestoredProviderId.Empty();
    Settings.Model = ModelId;
    Settings.Save();
    if (ModelButton.IsValid()) ModelButton->SetIsOpen(false);
    return FReply::Handled();
}

void SHaybaMCPChatPanel::OnManualModelCommitted(const FText& Text, ETextCommit::Type CommitType)
{
    if (CommitType != ETextCommit::OnEnter) return;
    const FString Id = Text.ToString();
    if (!ValidModelId(Id))
    {
        ModelMenuMessage = TEXT("Enter a valid exact model ID.");
        RefreshModelMenuItems();
        return;
    }
    if (PendingUnverifiedModelId != Id)
    {
        PendingUnverifiedModelId = Id;
        ModelMenuMessage = TEXT("Model support is unverified. Press Enter again to use this exact ID.");
        RefreshModelMenuItems();
        return;
    }
    OnSetModel(Id);
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildEffortMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    const FHaybaMCPDiscoveredModel* Model = SelectedDiscoveredModel();
    auto AddEffort = [this, &Items](const FString& Effort, const FText& Label)
    {
        Items->AddSlot().AutoHeight()
        [ FHaybaMCPStyle::PopupRow(Label, FOnClicked::CreateLambda([this, Effort]()
            {
                return OnSetEffort(Effort);
            }), ReasoningEffort == Effort) ];
    };
    AddEffort(FString(), LOCTEXT("ChatEffortDefault", "Model default"));
    if (!Model)
    {
        if (!ReasoningEffort.IsEmpty()) AddEffort(ReasoningEffort, FText::FromString(ReasoningEffort));
        return FHaybaMCPStyle::PopupSurface(Items, 160.f);
    }
    for (const FString& Effort : Model->ReasoningEfforts)
        if (SupportsReasoningEffort(FHaybaMCPSettings::Get().SelectedProviderId, Effort))
            AddEffort(Effort, FText::FromString(Effort));
    return FHaybaMCPStyle::PopupSurface(Items, 160.f);
}

FReply SHaybaMCPChatPanel::OnSetEffort(const FString& Effort)
{
    if (bIsStreaming || bAwaitingPlanApproval || !HasEffortChoices()) return FReply::Handled();
    const FHaybaMCPDiscoveredModel* Model = SelectedDiscoveredModel();
    if (Effort.IsEmpty() || (Model && Model->ReasoningEfforts.Contains(Effort) &&
        SupportsReasoningEffort(FHaybaMCPSettings::Get().SelectedProviderId, Effort)))
        ReasoningEffort = Effort;
    if (EffortButton.IsValid()) EffortButton->SetIsOpen(false);
    return FReply::Handled();
}

// ── Empty state (Q11) ─────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildEmptyState()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
        [
            SNew(STextBlock)
            .Text(LOCTEXT("EmptyTitle", "Start with your world"))
            .Font(FHaybaMCPStyle::Font(19, true))
            .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Primary")))
        ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0.f, 13.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
            .ContentPadding(FMargin(12.f, 7.f))
            .Text(LOCTEXT("EmptyInspect", "Inspect loaded world"))
            .OnClicked(this, &SHaybaMCPChatPanel::OnInspectWorld)
        ];
}

void SHaybaMCPChatPanel::DraftPrompt(const FString& Prompt)
{
    AppendToInput(Prompt);
    Toast(LOCTEXT("DraftReady", "Request added to the composer. Review it, choose a work mode, then send."));
}

// ── Drag-and-drop into the input (assets + external files) ────────────────

bool SHaybaMCPChatPanel::AppendToInput(const FString& Addition)
{
    if (!InputBox.IsValid() || Addition.IsEmpty()) return false;

    FString Existing = InputBox->GetText().ToString();
    // Space-separate from prior content; if the box already ends in whitespace
    // (or is empty) don't inject a redundant leading space.
    if (!Existing.IsEmpty() && !FChar::IsWhitespace(Existing[Existing.Len() - 1]))
    {
        Existing += TEXT(" ");
    }
    Existing += Addition;

    InputBox->SetText(FText::FromString(Existing));
    if (FSlateApplication::IsInitialized())
    {
        FSlateApplication::Get().SetKeyboardFocus(InputBox);
    }
    return true;
}

FReply SHaybaMCPChatPanel::OnDragOver(const FGeometry& /*MyGeometry*/, const FDragDropEvent& DragDropEvent)
{
    // Show the droppable cursor for payloads we know how to consume.
    if (DragDropEvent.GetOperationAs<FAssetDragDropOp>().IsValid() ||
        DragDropEvent.GetOperationAs<FExternalDragOperation>().IsValid())
    {
        return FReply::Handled();
    }
    return FReply::Unhandled();
}

FReply SHaybaMCPChatPanel::OnDrop(const FGeometry& /*MyGeometry*/, const FDragDropEvent& DragDropEvent)
{
    TArray<FString> Refs;

    // 1) Content Browser assets — append each asset's object path
    //    (e.g. /Game/Path/Asset.Asset) so the reference is unambiguous.
    if (TSharedPtr<FAssetDragDropOp> AssetOp = DragDropEvent.GetOperationAs<FAssetDragDropOp>())
    {
        for (const FAssetData& Asset : AssetOp->GetAssets())
        {
            const FString ObjectPath = Asset.GetObjectPathString();
            if (!ObjectPath.IsEmpty()) Refs.Add(ObjectPath);
        }
    }
    // 2) External files dragged from the OS file explorer.
    else if (TSharedPtr<FExternalDragOperation> ExtOp = DragDropEvent.GetOperationAs<FExternalDragOperation>())
    {
        if (ExtOp->HasFiles())
        {
            for (const FString& File : ExtOp->GetFiles())
            {
                if (!File.IsEmpty()) Refs.Add(File);
            }
        }
    }

    if (Refs.Num() == 0) return FReply::Unhandled();

    const bool bAppended = AppendToInput(FString::Join(Refs, TEXT(" ")));
    if (bAppended)
    {
        Toast(FText::Format(
            LOCTEXT("DropAppended", "Added {0} reference(s) to the message."),
            FText::AsNumber(Refs.Num())));
    }
    return FReply::Handled();
}

// ── Message row (Q5-a flat + Q12-c copy on hover + right-click) ──────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildMessageRow(const FHaybaMCPChatMessage& Msg, int32 MessageIndex)
{
    FMessageWidgets& Widgets = MessageWidgets[MessageIndex];
    const FText RoleLabel = Msg.bFromUser ? LOCTEXT("RoleYou", "You")
        : Msg.bToolResult ? LOCTEXT("RoleWorldInspect", "World inspect")
        : LOCTEXT("RoleAI", "Hayba");
    TSharedRef<SVerticalBox> Stack = SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [
                SNew(STextBlock)
                .Text(RoleLabel)
                .Font(FHaybaMCPStyle::Font(11, true))
                .ColorAndOpacity(FHaybaMCPStyle::Colour(TEXT("Hayba.Color.Text.Secondary")))
            ]
            // Hover copy icon (Q12-c).
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6.f, 0.f, 0.f, 0.f)
            [
                SNew(SButton)
                .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Icon"))
                .ToolTipText(LOCTEXT("CopyMsgTT", "Copy message"))
                .ContentPadding(FMargin(3.f))
                .OnClicked_Lambda([this, MessageIndex]() { return OnCopyMessage(MessageIndex); })
                [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush(TEXT("Hayba.Icon.Copy"))) ]
            ]
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 5.f, 0.f, 0.f)
        [
            SAssignNew(Widgets.Body, SHaybaChatMessageBody).PlainText(Msg.bFromUser)
        ];
    Widgets.Body->SetMessageText(Msg.Text);
    Stack->AddSlot().AutoHeight()
        [ SAssignNew(Widgets.Activity, SBox) ];

    // Hayba Pro unavailable: offer to finish this chat on the local Community loop.
        Stack->AddSlot().AutoHeight().HAlign(HAlign_Left)
        [
            SNew(SButton)
            .Visibility_Lambda([this, MessageIndex]() { return MessageIndex == CommunityFallbackMessageIndex ? EVisibility::Visible : EVisibility::Collapsed; })
            .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
            .Text(LOCTEXT("UseCommunity", "Use Community for this chat"))
            .ToolTipText(LOCTEXT("UseCommunityTip", "Continue this conversation on the local Community loop. Other chats keep using Hayba Pro."))
            .IsEnabled_Lambda([this]() { return CanSend() && AgentClient.IsValid() && !AgentClient->IsTurnActive(); })
            .OnClicked(this, &SHaybaMCPChatPanel::OnUseCommunityForThisChat)
        ];

        Stack->AddSlot().AutoHeight().HAlign(HAlign_Left)
        [
            SNew(SButton)
            .Visibility_Lambda([this, MessageIndex]() { return MessageIndex == RetryMessageIndex && !RetryPromptText.IsEmpty() ? EVisibility::Visible : EVisibility::Collapsed; })
            .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
            .Text(LOCTEXT("RestorePrompt", "Edit and resend"))
            .ToolTipText(LOCTEXT("RestorePromptTip", "Restore this prompt to the composer so you can review it before sending again."))
            .IsEnabled_Lambda([this]() { return CanSend() && InputBox.IsValid(); })
            .OnClicked(this, &SHaybaMCPChatPanel::RestoreRetryPrompt)
        ];

    return SNew(SBorder)
        .BorderImage(Msg.bToolResult ? FHaybaMCPStyle::GetBrush(TEXT("Hayba.Brush.Settings.Section")) : FAppStyle::GetBrush("NoBrush"))
        .Padding(Msg.bToolResult ? FMargin(12.f) : FMargin(4.f, 11.f, 4.f, 12.f))
        [ Stack ];
}

// ── Message management ────────────────────────────────────────────────────

void SHaybaMCPChatPanel::AddUserMessage(const FString& Text)
{
    FHaybaMCPChatMessage Msg{};
    Msg.bFromUser = true;
    Msg.Text      = Text;
    Session.Messages.Add(Msg);
    RebuildChat();
}

void SHaybaMCPChatPanel::AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph)
{
    FHaybaMCPChatMessage Msg{};
    Msg.bFromUser     = false;
    Msg.Text          = Text;
    Msg.AttachedGraph = Graph;
    Msg.bShowActions  = Graph.IsValid();
    Session.Messages.Add(Msg);

    // Sticky-if-at-bottom (Q13-b).
    const bool bPinned = IsScrolledNearBottom();
    if (!bPinned) ++UnseenWhileScrolledUp;
    RebuildChat();
    if (bPinned) ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::AddInspectResult(const FHaybaWorldInspectSummary& Summary)
{
    FHaybaMCPChatMessage Msg{};
    Msg.bToolResult = true;
    Msg.Text = Summary.ToConversationText();
    const bool bPinned = IsScrolledNearBottom();
    Session.Messages.Add(MoveTemp(Msg));
    if (!bPinned) ++UnseenWhileScrolledUp;
    RebuildChat();
    if (bPinned) ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::AddSystemError(const FString& Reason, const FString& RetryPrompt)
{
    FHaybaMCPChatMessage Msg{};
    Msg.bFromUser    = false;
    Msg.Text         = FString::Printf(TEXT("⚠ %s"), *Reason);
    Msg.bShowActions = false;
    Session.Messages.Add(Msg);
    RetryPromptText = RetryPrompt;
    RetryMessageIndex = RetryPromptText.IsEmpty() ? INDEX_NONE : Session.Messages.Num() - 1;
    RebuildChat();
    ScrollToBottomIfPinned();
    Toast(FText::FromString(FString::Printf(TEXT("Chat: %s"), *Reason)));
}

FReply SHaybaMCPChatPanel::RestoreRetryPrompt()
{
    if (!CanSend() || !InputBox.IsValid() || RetryPromptText.IsEmpty()) return FReply::Handled();
    if (!InputBox->GetText().IsEmpty())
    {
        Toast(LOCTEXT("RetryHasDraft", "Finish or clear your draft before restoring the prompt."));
        return FReply::Handled();
    }
    InputBox->SetText(FText::FromString(RetryPromptText));
    if (FSlateApplication::IsInitialized()) FSlateApplication::Get().SetKeyboardFocus(InputBox);
    RetryPromptText.Empty();
    RetryMessageIndex = INDEX_NONE;
    RebuildChat();
    return FReply::Handled();
}

void SHaybaMCPChatPanel::RebuildChat()
{
    if (!ChatScrollBox.IsValid()) return;
    // Messages append within a session. Only an empty placeholder is removed;
    // a new/restored session clears this cache through OnNewConversation.
    while (MessageWidgets.Num() > Session.Messages.Num())
    {
        ChatScrollBox->RemoveSlot(MessageWidgets.Last().Row.ToSharedRef());
        MessageWidgets.Pop();
    }
    for (int32 i = 0; i < Session.Messages.Num(); ++i)
    {
        if (!MessageWidgets.IsValidIndex(i))
        {
            MessageWidgets.AddDefaulted();
            MessageWidgets[i].Row = BuildMessageRow(Session.Messages[i], i);
            ChatScrollBox->AddSlot().Padding(0.f, 0.f, 0.f, 4.f) [ MessageWidgets[i].Row.ToSharedRef() ];
        }
        FMessageWidgets& Widgets = MessageWidgets[i];
        const FHaybaMCPChatMessage& Msg = Session.Messages[i];
        Widgets.Body->SetMessageText(Msg.Text);
        const uint64 Serial = ActivitySerialById.FindRef(Msg.ActivityId);
        if (Widgets.ActivityId != Msg.ActivityId || Widgets.ActivitySerial != Serial)
        {
            HaybaChatFocus::ReplaceActivityContent(Widgets.Activity.ToSharedRef(),
                Msg.ActivityId.IsEmpty() ? SNullWidget::NullWidget : BuildActivityCard(Msg.ActivityId));
            Widgets.Activity->SetPadding(Msg.ActivityId.IsEmpty() ? FMargin(0.f) : FMargin(0.f, 10.f, 0.f, 1.f));
            Widgets.ActivityId = Msg.ActivityId;
            Widgets.ActivitySerial = Serial;
        }
    }
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildActivityCard(const FString& ActivityId)
{
    if (!Module) return SNullWidget::NullWidget;
    const FHaybaActivityModel& Model = Module->GetActivityModel();
    if (!Model.FindActivity(ActivityId)) return SNullWidget::NullWidget;
    FSimpleDelegate CancelAction;
    if (AgentClient.IsValid() && AgentClient->IsStreaming() &&
        Session.Messages.IsValidIndex(InProgressMessageIndex) &&
        Session.Messages[InProgressMessageIndex].ActivityId == ActivityId)
        CancelAction = FSimpleDelegate::CreateLambda([this]() { StopGeneration(); });
    return SNew(SHaybaActivityCard)
        .ActivityModel(&Model)
        .ActivityId(ActivityId)
        .InitiallyExpanded(ExpandedActivityIds.Contains(ActivityId))
        .OnExpansionChanged(FOnHaybaActivityExpansionChanged::CreateLambda([this](const FString& ChangedId, bool bExpanded)
        {
            if (bExpanded) ExpandedActivityIds.Add(ChangedId);
            else ExpandedActivityIds.Remove(ChangedId);
        }))
        .OnApprove(FSimpleDelegate::CreateLambda([this, ActivityId]() { ApproveActivity(ActivityId); }))
        .OnReject(FSimpleDelegate::CreateLambda([this, ActivityId]() { RejectActivity(ActivityId); }))
        .OnCancel(CancelAction);
}

void SHaybaMCPChatPanel::ScrollToBottomIfPinned()
{
    if (!ChatScrollBox.IsValid()) return;
    TWeakPtr<SScrollBox> Weak = ChatScrollBox;
    if (GEditor)
    {
        GEditor->GetTimerManager()->SetTimerForNextTick([Weak]()
        {
            if (TSharedPtr<SScrollBox> S = Weak.Pin()) S->ScrollToEnd();
        });
    }
}

bool SHaybaMCPChatPanel::IsScrolledNearBottom() const
{
    if (!ChatScrollBox.IsValid()) return true;
    return ChatScrollBox->GetScrollOffsetOfEnd() <= 0.5f;
}

EVisibility SHaybaMCPChatPanel::GetNewMessagesChipVisibility() const
{
    return UnseenWhileScrolledUp > 0 ? EVisibility::Visible : EVisibility::Collapsed;
}

// ── Send / stop ───────────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnSendOrStop()
{
    if (bIsStreaming) { StopGeneration(); return FReply::Handled(); }
    return OnSendCurrentInput();
}

FReply SHaybaMCPChatPanel::OnSendCurrentInput()
{
    if (!CanSend() || !InputBox.IsValid()) return FReply::Handled();
    FString Text = InputBox->GetText().ToString().TrimStartAndEnd();
    if (Text.IsEmpty()) return FReply::Handled();

    RetryPromptText.Empty();
    RetryMessageIndex = INDEX_NONE;
    InputBox->SetText(FText::GetEmpty());
    AddUserMessage(Text);
    // User intent: always scroll to bottom on their own send.
    UnseenWhileScrolledUp = 0;
    ScrollToBottomIfPinned();

    // First user message names the conversation (title dropdown / recents).
    if (Session.Goal.IsEmpty()) Session.Goal = Text;

    // Streaming agent path (Task 8).
    StartAgentTurn(Text);

    return FReply::Handled();
}

void SHaybaMCPChatPanel::StopGeneration()
{
    // Cancel the in-flight stream: aborts the server-side loop, cancels the local
    // HTTP request, and fires OnDone{cancelled} which finalizes the bubble.
    if (AgentClient.IsValid()) AgentClient->Cancel();
    // Defensively disarm the plan gate too, in case Stop is pressed while parked
    // at the approval gate (Cancel() above already notifies the server).
    bAwaitingPlanApproval = false;
    PendingActivityId.Empty();
    // Belt-and-braces if there is no live client (shouldn't happen while
    // bIsStreaming): tag the partial reply and reset local flags.
    if (!AgentClient.IsValid())
    {
        bIsStreaming = false;
        Session.bWaitingForAI = false;
        FinalizeInProgressBubble(TEXT(""));
    }
}

bool SHaybaMCPChatPanel::CanSend() const
{
    // Blocked while the AI is streaming AND while a plan_request is parked at the
    // approval gate. On plan_request the server emits a `done` frame (so
    // bWaitingForAI is false), but sending a fresh prompt here would start a new
    // /chat/stream that server-side replaces session.messages — orphaning the
    // paused plan and losing transcript context. Stay disabled until the user
    // Approves (resume) or Rejects (cancel) the pending plan.
    return !Session.bWaitingForAI && !bAwaitingPlanApproval && !bLoadingSession;
}

// ── New / recent ──────────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnNewConversation()
{
    InspectGeneration.Invalidate();
    bInspectInFlight = false;
    PendingSessionId.Empty();
    bLoadingSession = false;
    // Abort any in-flight stream and drop the client so the next send opens a
    // FRESH server session (new session_id, new transcript).
    if (AgentClient.IsValid())
    {
        AgentClient->OnTextDelta.RemoveAll(this);
        AgentClient->OnActivityEvent.RemoveAll(this);
        AgentClient->OnDone.RemoveAll(this);
        AgentClient->OnError.RemoveAll(this);
        AgentClient->Cancel();
        AgentClient.Reset();
    }
    bAwaitingPlanApproval = false;
    bIsStreaming = false;
    PendingActivityId.Empty();
    InProgressMessageIndex = INDEX_NONE;
    InProgressAssistantText.Reset();
    LastPrompt.Reset();
    RetryPromptText.Reset();
    RetryMessageIndex = INDEX_NONE;
    bTurnErrorShown = false;
    CommunityFallbackMessageIndex = INDEX_NONE;
    TaskModelId.Empty();
    TaskModelProviderId.Empty();
    RestoredProviderId.Empty();
    RestoredLoop.Empty();
    ReasoningEffort.Empty();
    WorkMode = TEXT("explore");

    Session = FHaybaMCPWizardSession{};
    ExpandedActivityIds.Reset();
    ActivitySerialById.Reset();
    if (Module) Module->GetActivityModel().Clear();
    UnseenWhileScrolledUp = 0;
    RebuildChat();
    return FReply::Handled();
}

FReply SHaybaMCPChatPanel::OnInspectWorld()
{
    if (!Module || bInspectInFlight || bIsStreaming || !CanSend()) return FReply::Handled();
    bInspectInFlight = true;
    const uint64 Generation = InspectGeneration.Begin();
    TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("world_inspect"), MakeShared<FJsonObject>(),
        [WeakSelf, Generation](bool bOk, const TSharedPtr<FJsonObject>& Data)
        {
            const TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin();
            if (!Self.IsValid() || !Self->InspectGeneration.IsCurrent(Generation)) return;
            Self->bInspectInFlight = false;
            Self->AddInspectResult(FHaybaWorldInspectSummary::FromResponse(bOk, Data));
        });
    return FReply::Handled();
}

// ── Copy / right-click ────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnCopyMessage(int32 MessageIndex)
{
    if (!Session.Messages.IsValidIndex(MessageIndex)) return FReply::Handled();
    FPlatformApplicationMisc::ClipboardCopy(*Session.Messages[MessageIndex].Text);
    Toast(LOCTEXT("Copied", "Copied message to clipboard"));
    return FReply::Handled();
}

TSharedPtr<SWidget> SHaybaMCPChatPanel::BuildMessageContextMenu(int32 MessageIndex)
{
    FMenuBuilder Menu(true, nullptr);
    Menu.AddMenuEntry(
        LOCTEXT("CopyMsg", "Copy message"),
        FText::GetEmpty(), FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([this, MessageIndex]()
        {
            OnCopyMessage(MessageIndex);
        })));
    // TODO: "Copy as JSON" (extract first {...} block), "Copy as prompt"
    // (only for user rows; re-fills the input), "Redo from here".
    return Menu.MakeWidget();
}

// ── Streaming agent pipeline (Task 8) ─────────────────────────────────────

void SHaybaMCPChatPanel::EnsureAgentClient()
{
    if (AgentClient.IsValid()) return;

    // MUST be MakeShared — the client calls AsShared() internally and asserts if
    // it was ever stack/heap-allocated outside a shared ref.
    AgentClient = MakeShared<FHaybaMCPAgentClient>();

    // Subscribe once; the client persists for the panel's lifetime so a
    // multi-turn conversation reuses one server session. RemoveAll(this) in the
    // destructor drops these. Handlers all fire on the game thread.
    AgentClient->OnTextDelta.AddSP(this, &SHaybaMCPChatPanel::HandleTextDelta);
    AgentClient->OnActivityEvent.AddSP(this, &SHaybaMCPChatPanel::HandleActivityEvent);
    AgentClient->OnDone.AddSP(this, &SHaybaMCPChatPanel::HandleStreamDone);
    AgentClient->OnError.AddSP(this, &SHaybaMCPChatPanel::HandleStreamError);

}

bool SHaybaMCPChatPanel::IsProLoopActive() const
{
    return AgentClient.IsValid() ? AgentClient->IsProLoopActive() : FHaybaMCPSettings::Get().bUseHaybaPro;
}

void SHaybaMCPChatPanel::StartAgentTurn(const FString& Prompt)
{
    LastPrompt = Prompt;
    bTurnErrorShown = false;
    const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    if (!RestoredProviderId.IsEmpty() && RestoredProviderId != Settings.SelectedProviderId &&
        !IsSubscriptionModel())
    {
        AddSystemError(FString::Printf(TEXT("This conversation used %s. Select that provider in Settings or choose a new model for this task."),
            *RestoredProviderId), Prompt);
        return;
    }
    const FString CurrentLoop = IsProLoopActive() ? TEXT("pro") : TEXT("community");
    if (!RestoredLoop.IsEmpty() && RestoredLoop != CurrentLoop)
    {
        AddSystemError(FString::Printf(TEXT("This conversation used %s. Switch Chat mode in Settings before continuing."),
            *RestoredLoop), Prompt);
        return;
    }
    // Hayba Pro on subscription models needs no local provider key.
    const FHaybaProviderInfo* Provider = FHaybaMCPSettings::FindProvider(Settings.SelectedProviderId);
    const bool bNeedsProviderKey = !IsSubscriptionModel() &&
        (IsProLoopActive() || (Provider && Provider->bNeedsKey));
    if (bNeedsProviderKey && !Settings.HasApiKey())
    {
        AddSystemError(TEXT("No API key configured — add one in Settings to chat"), Prompt);
        return;
    }
    if (!IsSubscriptionModel() && EffectiveModelId().IsEmpty())
    {
        AddSystemError(TEXT("Choose a model in Chat or Settings before sending."), Prompt);
        return;
    }

    EnsureAgentClient();

    CommunityFallbackMessageIndex = INDEX_NONE;
    Session.bWaitingForAI = true;
    bIsStreaming = true;
    BeginInProgressBubble();

    // Server owns the system prompt (see HaybaMCPWizardPrompt.h) — send only the
    // user turn. Provider/model/key are resolved by the client from the vault
    // and pushed to the sidecar via /chat/config on the first turn.
    RestoredProviderId.Empty();
    RestoredLoop.Empty();
    AgentClient->SendPrompt(Prompt, WorkMode, EffectiveModelId(), EffectiveReasoningEffort());
}

void SHaybaMCPChatPanel::BeginInProgressBubble()
{
    InProgressAssistantText.Reset();

    FHaybaMCPChatMessage Placeholder{};
    Placeholder.bFromUser = false;
    Placeholder.Text      = TEXT("Responding…");
    Session.Messages.Add(Placeholder);
    InProgressMessageIndex = Session.Messages.Num() - 1;

    RebuildChat();
    ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::RefreshInProgressBubble()
{
    if (!Session.Messages.IsValidIndex(InProgressMessageIndex)) return;

    FString Composed = InProgressAssistantText;
    if (Composed.IsEmpty()) Composed = TEXT("Responding…");

    Session.Messages[InProgressMessageIndex].Text = Composed;
    const bool bPinned = IsScrolledNearBottom();
    if (MessageWidgets.IsValidIndex(InProgressMessageIndex))
        MessageWidgets[InProgressMessageIndex].Body->SetMessageText(Composed);
    else RebuildChat();
    if (bPinned) ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::FinalizeInProgressBubble(const FString& FallbackText)
{
    if (!Session.Messages.IsValidIndex(InProgressMessageIndex))
    {
        InProgressMessageIndex = INDEX_NONE;
        return;
    }
    // If nothing streamed (e.g. immediate error), drop or substitute the
    // placeholder so we don't leave a lone "…" bubble.
    const bool bEmpty = InProgressAssistantText.IsEmpty();
    if (bEmpty)
    {
        if (FallbackText.IsEmpty() && Session.Messages[InProgressMessageIndex].ActivityId.IsEmpty())
        {
            Session.Messages.RemoveAt(InProgressMessageIndex);
        }
        else
        {
            Session.Messages[InProgressMessageIndex].Text = FallbackText;
        }
    }
    else
    {
        RefreshInProgressBubble();
        if (!FallbackText.IsEmpty() && Session.Messages.IsValidIndex(InProgressMessageIndex))
        {
            Session.Messages[InProgressMessageIndex].Text += FString::Printf(TEXT("\n\n%s"), *FallbackText);
        }
    }
    InProgressMessageIndex = INDEX_NONE;
    InProgressAssistantText.Reset();
    RebuildChat();
}

// ── Agent-client delegate handlers ────────────────────────────────────────

void SHaybaMCPChatPanel::HandleTextDelta(const FString& Text)
{
    if (InProgressMessageIndex == INDEX_NONE) BeginInProgressBubble();
    InProgressAssistantText += Text;
    RefreshInProgressBubble();
}

void SHaybaMCPChatPanel::HandleActivityEvent(const FJsonObject& Event)
{
    FString Type;
    Event.TryGetStringField(TEXT("type"), Type);
    FString ActivityId;
    Event.TryGetStringField(TEXT("activityId"), ActivityId);
    if (!ActivityId.IsEmpty()) ++ActivitySerialById.FindOrAdd(ActivityId);
    if (Type == TEXT("activity_started") && !ActivityId.IsEmpty())
    {
        if (InProgressMessageIndex == INDEX_NONE) BeginInProgressBubble();
        if (Session.Messages.IsValidIndex(InProgressMessageIndex))
            Session.Messages[InProgressMessageIndex].ActivityId = ActivityId;
    }
    if (Type == TEXT("approval_requested"))
    {
        bAwaitingPlanApproval = true;
        PendingActivityId = ActivityId;
        Toast(LOCTEXT("AgentApproval", "Review the proposed action in this conversation."));
    }
    const bool bPinned = IsScrolledNearBottom();
    RebuildChat();
    if (bPinned) ScrollToBottomIfPinned();
    else ++UnseenWhileScrolledUp;
}

FReply SHaybaMCPChatPanel::OnSetWorkMode(FString NewMode)
{
    if (NewMode == TEXT("explore") || NewMode == TEXT("draft") || NewMode == TEXT("production"))
        WorkMode = MoveTemp(NewMode);
    return FReply::Handled();
}

void SHaybaMCPChatPanel::ApproveActivity(const FString& ActivityId)
{
    if (!Module || !AgentClient.IsValid() || !bAwaitingPlanApproval || ActivityId != PendingActivityId) return;
    const FHaybaActivity* Activity = Module->GetActivityModel().FindActivity(ActivityId);
    if (!Activity || !Activity->Approval.IsSet() ||
        !Module->GetActivityModel().CanResolveApproval(ActivityId, Activity->Approval->ApprovalId)) return;
    HandlePlanApproved();
}

void SHaybaMCPChatPanel::RejectActivity(const FString& ActivityId)
{
    if (!Module || !bAwaitingPlanApproval || ActivityId != PendingActivityId) return;
    const FHaybaActivity* Activity = Module->GetActivityModel().FindActivity(ActivityId);
    if (!Activity || !Activity->Approval.IsSet() ||
        !Module->GetActivityModel().CanResolveApproval(ActivityId, Activity->Approval->ApprovalId)) return;
    Module->GetActivityModel().MarkDisconnected(ActivityId);
    HandlePlanRejected();
    ++ActivitySerialById.FindOrAdd(ActivityId);
    RebuildChat();
}

void SHaybaMCPChatPanel::HandlePlanApproved()
{
    // Only act if WE are the panel waiting on a plan (avoids resuming on stray
    // approvals). One-shot: clear the flag before resuming.
    if (!bAwaitingPlanApproval) return;
    bAwaitingPlanApproval = false;

    if (!AgentClient.IsValid()) return;

    // Continue in the same transcript row so the activity does not jump to the
    // end or duplicate its approval card after the resume.
    Session.bWaitingForAI = true;
    bIsStreaming = true;
    const FString ApprovedActivityId = MoveTemp(PendingActivityId);
    PendingActivityId.Empty();
    InProgressMessageIndex = Session.Messages.IndexOfByPredicate([&ApprovedActivityId](const FHaybaMCPChatMessage& Message)
    {
        return Message.ActivityId == ApprovedActivityId;
    });
    if (InProgressMessageIndex == INDEX_NONE) BeginInProgressBubble();
    else InProgressAssistantText = Session.Messages[InProgressMessageIndex].Text;
    AgentClient->ApproveAndResume();

}

void SHaybaMCPChatPanel::HandlePlanRejected()
{
    // Only act if WE are the panel waiting on a plan (avoids cancelling on stray
    // rejections from an unrelated Plan-tab action). Disarm before cancelling.
    if (!bAwaitingPlanApproval) return;
    bAwaitingPlanApproval = false;
    PendingActivityId.Empty();

    // Cancel the paused server-side turn so it can never be resumed, and mark the
    // in-progress bubble as aborted. Re-enables the input (CanSend clears once
    // bAwaitingPlanApproval + bWaitingForAI are both false).
    // NOTE: use AbortServerTurn(), not Cancel(): on plan reject the plan_request
    // SSE stream has already closed (bStreaming=false), so Cancel() would hit its
    // early-return and never POST /chat/cancel, leaving the turn parked server-side.
    if (AgentClient.IsValid()) AgentClient->AbortServerTurn();
    Session.bWaitingForAI = false;
    bIsStreaming = false;
    FinalizeInProgressBubble(TEXT("[rejected]"));

    Toast(LOCTEXT("PlanRejected", "Action rejected; the paused turn was cancelled."));
}

void SHaybaMCPChatPanel::HandleStreamDone(const FHaybaChatDone& Done)
{
    Session.bWaitingForAI = false;
    bIsStreaming = false;

    // Prefer streamed text; fall back to the server's assembled assistant_text
    // (e.g. on a clean end with no incremental deltas).
    if (InProgressAssistantText.IsEmpty() && !Done.AssistantText.IsEmpty())
    {
        InProgressAssistantText = Done.AssistantText;
    }
    const bool bHasActivity = Session.Messages.IsValidIndex(InProgressMessageIndex) &&
        !Session.Messages[InProgressMessageIndex].ActivityId.IsEmpty();
    const bool bNoReply = !Done.bCancelled && !bAwaitingPlanApproval && !bTurnErrorShown && !bHasActivity &&
        InProgressAssistantText.TrimStartAndEnd().IsEmpty() && Done.AssistantText.TrimStartAndEnd().IsEmpty();
    const FString DoneTag = Done.bCancelled ? TEXT("[stopped]") : TEXT("");
    FinalizeInProgressBubble(DoneTag);
    if (bNoReply)
        AddSystemError(TEXT("No reply received. Check the connection, then edit and resend your message."), LastPrompt);
    bTurnErrorShown = false;

    // A recorded warning review does not prove that the finding was fixed.
    // Keep the terminal ledger state visible in Chat until revalidation.
    const bool bHasPending = Done.Reason == TEXT("warnings_unreviewed") ||
        !Done.PendingWarningIds.IsEmpty() || Done.PendingWarningReviewCount > 0 || Done.bWarningOverflow;
    const bool bHasDeferred = Done.Reason == TEXT("reviewed_with_deferred") ||
        Done.DeferredWarningReviewCount > 0;
    const bool bHasAcknowledged = Done.AcknowledgedWarningReviewCount > 0;
    if (!Done.bCancelled && (bHasPending || bHasDeferred || bHasAcknowledged))
    {
        FString Notice;
        if (bHasPending)
        {
            Notice = TEXT("Warning review is still required. Inspect each pending finding, record an acknowledged or deferred review with a reason, then revalidate any fix. Review alone does not resolve a finding.");
        }
        else if (bHasDeferred)
        {
            Notice = TEXT("Warnings were deferred with reasons. Their review is recorded, but the findings remain unresolved. Revisit them and revalidate after any fix.");
        }
        else
        {
            Notice = TEXT("Warning reviews were acknowledged, but no fix has been verified. Revalidate the findings before treating them as resolved.");
        }
        TArray<FString> VisibleIds;
        for (int32 Index = 0; Index < FMath::Min(Done.PendingWarningIds.Num(), 6); ++Index)
        {
            VisibleIds.Add(Done.PendingWarningIds[Index]);
        }
        if (!VisibleIds.IsEmpty())
        {
            Notice += FString::Printf(TEXT(" Warning IDs: %s."), *FString::Join(VisibleIds, TEXT(", ")));
        }
        const int32 Remaining = Done.PendingWarningIds.Num() - VisibleIds.Num();
        if (Remaining > 0)
        {
            Notice += FString::Printf(TEXT(" %d more warning IDs are not shown here."), Remaining);
        }
        if (Done.bPendingWarningIdsTruncated)
        {
            Notice += TEXT(" Additional IDs were omitted by the chat client.");
        }
        if (Done.bWarningOverflow)
        {
            Notice += TEXT(" The warning ledger reached its cap; additional findings may exist.");
        }
        if (Done.bWarningReviewsTruncated)
        {
            Notice += TEXT(" Some review records were omitted by the chat client.");
        }
        if (bHasPending && bHasDeferred)
        {
            Notice += TEXT(" Deferred findings also remain unresolved.");
        }
        AddAIMessage(FString::Printf(TEXT("⚠ Warning review: %s"), *Notice));
    }
    // A done frame can arrive from an HTTP progress/completion delegate. Starting
    // the recents GET there mutates FHttpManager's request array during iteration.
    TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
    if (GEditor) GEditor->GetTimerManager()->SetTimerForNextTick([WeakSelf]()
    {
        if (TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin())
            Self->RefreshRecentSessions();
    });
}

void SHaybaMCPChatPanel::HandleStreamError(const FHaybaChatError& Error)
{
    bTurnErrorShown = true;
    Session.bWaitingForAI = false;
    bIsStreaming = false;
    // Keep any partial content, then surface the error inline.
    const bool bCanRestorePrompt = InProgressAssistantText.IsEmpty() &&
        (!Session.Messages.IsValidIndex(InProgressMessageIndex) ||
         Session.Messages[InProgressMessageIndex].ActivityId.IsEmpty()) &&
        Error.Kind != TEXT("brain_unavailable");
    FinalizeInProgressBubble(TEXT(""));
    AddSystemError(Error.Error.IsEmpty() ? TEXT("Chat error") : Error.Error,
        bCanRestorePrompt ? LastPrompt : FString());
    if (Error.Kind == TEXT("brain_unavailable"))
    {
        // Attach "Use Community for this chat" to the error row just added.
        CommunityFallbackMessageIndex = Session.Messages.Num() - 1;
        RebuildChat();
    }
}

FReply SHaybaMCPChatPanel::OnUseCommunityForThisChat()
{
    if (!CanSend() || !AgentClient.IsValid() || AgentClient->IsTurnActive()) return FReply::Handled();
    // Community runs on the local provider key.
    const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    const FHaybaProviderInfo* Provider = FHaybaMCPSettings::FindProvider(Settings.SelectedProviderId);
    if (Provider && Provider->bNeedsKey && !Settings.HasApiKey())
    {
        AddSystemError(TEXT("No API key configured — add one in Settings to chat"), TEXT(""));
        return FReply::Handled();
    }
    AgentClient->ForceCommunityThisChat();
    CommunityFallbackMessageIndex = INDEX_NONE;

    // Same waiting / in-progress bubble setup as StartAgentTurn. The prompt is
    // EMPTY on purpose: the sidecar already saved the user's message before it
    // reported brain_unavailable, so a prompt-less stream on the same session
    // runs a Community turn over the saved transcript (as approval-resume does)
    // instead of duplicating that message.
    Session.bWaitingForAI = true;
    bIsStreaming = true;
    BeginInProgressBubble();
    RestoredLoop.Empty();
    AgentClient->SendPrompt(FString(), WorkMode, EffectiveModelId(), EffectiveReasoningEffort());
    return FReply::Handled();
}

#undef LOCTEXT_NAMESPACE
