#include "HaybaUIOps.h"

namespace HaybaUIOps
{
    FSlotPropsPayload ResolveSlotProps(const TSharedPtr<FJsonObject>& Params)
    {
        FSlotPropsPayload Out;
        if (!Params.IsValid()) return Out;

        // Public schema first, so a caller sending both gets the documented one.
        static const TPair<const TCHAR*, ESlotPropsSpelling> Candidates[] = {
            { TEXT("slot_props"),      ESlotPropsSpelling::SlotProps },
            { TEXT("slot_properties"), ESlotPropsSpelling::SlotProperties },
            { TEXT("slot_layout"),     ESlotPropsSpelling::SlotLayout },
        };

        for (const auto& C : Candidates)
        {
            const TSharedPtr<FJsonObject>* Found = nullptr;
            if (Params->TryGetObjectField(C.Key, Found) && Found && Found->IsValid())
            {
                Out.Object = *Found;
                Out.Spelling = C.Value;
                return Out;
            }
        }
        return Out;
    }

    const TCHAR* SpellingName(ESlotPropsSpelling Spelling)
    {
        switch (Spelling)
        {
        case ESlotPropsSpelling::SlotProps:      return TEXT("slot_props");
        case ESlotPropsSpelling::SlotProperties: return TEXT("slot_properties");
        case ESlotPropsSpelling::SlotLayout:     return TEXT("slot_layout");
        default:                                 return TEXT("");
        }
    }
}
