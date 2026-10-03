#include "Misc/AutomationTest.h"
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPModule.h"
#include "Editor.h"
#include "Modules/ModuleManager.h"
#include "InputCoreTypes.h"
#include "Input/Events.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Text/SMultiLineEditableText.h"

#if WITH_DEV_AUTOMATION_TESTS
namespace
{
    bool ContainsText(const TSharedRef<SWidget>& Widget, const FString& Needle)
    {
        if (Widget->GetType() == TEXT("SMultiLineEditableText"))
            return StaticCastSharedRef<SMultiLineEditableText>(Widget)->GetText().ToString().Contains(Needle);
        if (Widget->GetType() == TEXT("STextBlock"))
        {
            const TSharedRef<STextBlock> Text = StaticCastSharedRef<STextBlock>(Widget);
            if (Text->GetText().ToString().Contains(Needle)) return true;
        }
        FChildren* Children = Widget->GetChildren();
        for (int32 Index = 0; Children && Index < Children->Num(); ++Index)
        {
            if (ContainsText(Children->GetChildAt(Index), Needle)) return true;
        }
        return false;
    }

    TSharedPtr<SButton> FindButtonWithText(const TSharedRef<SWidget>& Widget, const FString& Needle)
    {
        if (Widget->GetType() == TEXT("SButton"))
        {
            if (ContainsText(Widget, Needle))
                return StaticCastSharedRef<SButton>(Widget);
        }
        FChildren* Children = Widget->GetChildren();
        for (int32 Index = 0; Children && Index < Children->Num(); ++Index)
        {
            if (TSharedPtr<SButton> Found = FindButtonWithText(Children->GetChildAt(Index), Needle)) return Found;
        }
        return nullptr;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAgentInspectDockTest, "Hayba.MCP.Agent.InspectDock",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAgentInspectDockTest::RunTest(const FString&)
{
    FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
    if (!TestNotNull(TEXT("running Hayba module"), Module) || !TestNotNull(TEXT("editor"), GEditor)) return false;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!TestNotNull(TEXT("loaded editor world"), World)) return false;
    const bool bWasDirty = World->GetPackage()->IsDirty();

    const TSharedRef<SHaybaMCPChatPanel> Panel = SNew(SHaybaMCPChatPanel, Module);
    TSharedPtr<SButton> Inspect = FindButtonWithText(Panel, TEXT("Inspect loaded world"));
    if (!TestTrue(TEXT("Agent dock offers a direct Inspect world action"), Inspect.IsValid())) return false;
    TestTrue(TEXT("Inspect is available when idle"), Inspect->IsEnabled());
    const FKeyEvent Accept(EKeys::Enter, FModifierKeysState(), 0, false, 0, 0);
    Inspect->OnKeyDown(FGeometry(), Accept);
    Inspect->OnKeyUp(FGeometry(), Accept);
    TestTrue(TEXT("result appears in the Agent conversation"), ContainsText(Panel, TEXT("Current map:")));
    TestTrue(TEXT("result states loaded-world coverage"), ContainsText(Panel, TEXT("unloaded partition cells not inspected")));
    TestEqual(TEXT("inspection does not dirty the world"), World->GetPackage()->IsDirty(), bWasDirty);
    return true;
}
#endif
