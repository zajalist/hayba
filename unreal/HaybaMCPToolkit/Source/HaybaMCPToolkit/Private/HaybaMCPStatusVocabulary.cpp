#include "HaybaMCPStatusVocabulary.h"

#include "HaybaMCPStyle.h"

#define LOCTEXT_NAMESPACE "HaybaStatus"

namespace HaybaStatus
{

FText Label(EHaybaStatus Status)
{
    switch (Status)
    {
        case EHaybaStatus::Running:        return LOCTEXT("Running",        "running");
        case EHaybaStatus::NeedsApproval:  return LOCTEXT("NeedsApproval",  "needs approval");
        case EHaybaStatus::Done:           return LOCTEXT("Done",           "done");
        case EHaybaStatus::NeedsAttention: return LOCTEXT("NeedsAttention", "needs attention");
        case EHaybaStatus::Error:          return LOCTEXT("Error",          "error");
        case EHaybaStatus::NotStarted:     return LOCTEXT("NotStarted",     "not started");
    }
    // No default above, so adding a state is a compile error here rather than
    // a silently blank chip at runtime.
    return FText::GetEmpty();
}

FSlateColor Colour(EHaybaStatus Status)
{
    // Every colour comes from a token. The Plan panel used to define its own
    // literals, including an "accent" that was a different colour from the
    // product's ochre -- which is exactly the drift a shared vocabulary is for.
    switch (Status)
    {
        // "blue-neutral status"
        case EHaybaStatus::Running:
            return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Info"));

        // "Plan Mode pause; semantic ochre" and "a rule has a negative margin;
        // semantic ochre plus Fix" -- the IA gives both the same colour on
        // purpose: both mean the work is waiting on the user.
        case EHaybaStatus::NeedsApproval:
        case EHaybaStatus::NeedsAttention:
            return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre"));

        // "completed; restrained green"
        case EHaybaStatus::Done:
            return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Pass"));

        // "tool or connection failure; restrained red"
        case EHaybaStatus::Error:
            return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Fail"));

        // Not one of the five. Muted, so a step that has not run reads as
        // absent rather than as a state.
        case EHaybaStatus::NotStarted:
            return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted"));
    }
    return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted"));
}

const TCHAR* Glyph(EHaybaStatus Status)
{
    switch (Status)
    {
        case EHaybaStatus::Running:        return TEXT("●");
        case EHaybaStatus::NeedsApproval:  return TEXT("?");
        case EHaybaStatus::Done:           return TEXT("✓");
        // Not a red X. The IA is explicit that a violation must carry the
        // amount, the direction and a next action -- the arrow points at the
        // fix rather than just marking failure.
        case EHaybaStatus::NeedsAttention: return TEXT("↗");
        case EHaybaStatus::Error:          return TEXT("✕");
        case EHaybaStatus::NotStarted:     return TEXT("○");
    }
    return TEXT("○");
}

bool WantsFixAffordance(EHaybaStatus Status)
{
    return Status == EHaybaStatus::NeedsAttention;
}

} // namespace HaybaStatus

#undef LOCTEXT_NAMESPACE
