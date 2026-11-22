// Test-project plugin, never included in the Hayba installer.
#include "Modules/ModuleManager.h"
#include "Editor.h"
#include "Engine/PointLight.h"
#include "Components/LightComponent.h"
#include "Containers/Ticker.h"
#include "Framework/Application/SlateApplication.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/SWindow.h"
#include "Widgets/Text/STextBlock.h"

class FLightingFixture : public IModuleInterface {
    FTSTicker::FDelegateHandle Tick;
    TWeakObjectPtr<APointLight> Key, Fill;
    FString Last;
    static void FindReview(const TSharedRef<SWidget>& W, TSharedPtr<SButton>& Button, bool& ExpectedValues, const FString& Expected) {
        if (!W->GetVisibility().IsVisible()) return;
        if (W->GetTypeAsString() == TEXT("STextBlock")) {
            const FString Text = StaticCastSharedRef<STextBlock>(W)->GetText().ToString();
            if (Text.Contains(Expected)) ExpectedValues = true;
            if (Text == TEXT("Approve operation")) {
                TSharedPtr<SWidget> Parent = W->GetParentWidget();
                while (Parent && Parent->GetTypeAsString() != TEXT("SButton")) Parent = Parent->GetParentWidget();
                if (Parent && Parent->IsEnabled()) Button = StaticCastSharedPtr<SButton>(Parent);
            }
        }
        FChildren* Children = W->GetChildren();
        for (int32 I = 0; I < Children->Num(); ++I) FindReview(Children->GetChildAt(I), Button, ExpectedValues, Expected);
    }
public:
    void StartupModule() override {
        if (FString(FApp::GetProjectName()) != TEXT("LightingAcceptance") ||
            !FParse::Param(FCommandLine::Get(), TEXT("HaybaLightingFixture"))) return;
        Tick = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([this](float) {
            UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
            if (!World || !World->PersistentLevel || World->WorldType != EWorldType::Editor || !FSlateApplication::IsInitialized()) return true;
            const FString Dir = FPaths::ProjectSavedDir();
            if (!Key.IsValid() || Key->GetWorld() != World) {
                Key = World->SpawnActor<APointLight>();
                Fill = World->SpawnActor<APointLight>();
                if (!Key.IsValid() || !Fill.IsValid()) return false;
                Key->SetActorLabel(TEXT("Entrance Key")); Fill->SetActorLabel(TEXT("Entrance Fill"));
                Key->GetLightComponent()->Intensity = 1200; Fill->GetLightComponent()->Intensity = 400;
            }
            const FString Observed = FString::Printf(TEXT("%.9g,%.9g"), Key->GetLightComponent()->Intensity, Fill->GetLightComponent()->Intensity);
            if (Last != Observed) {
                Last = Observed;
                FFileHelper::SaveStringToFile(Observed, *(Dir / TEXT("lighting-values.txt")));
            }
            // The normal Slate control must be visible, enabled and displaying this fixture's exact change.
            const FString Request = Dir / TEXT("lighting-test-click.txt");
            FString Which;
            if (FFileHelper::LoadFileToString(Which, *Request) && (Which == TEXT("apply") || Which == TEXT("undo"))) {
                const FString Expected = Which == TEXT("apply") ? TEXT("Intensity: 1200 to 1800.") : TEXT("Intensity: 1800 to 1200.");
                for (const TSharedRef<SWindow>& Window : FSlateApplication::Get().GetTopLevelWindows()) {
                    TSharedPtr<SButton> Button; bool Matches = false;
                    FindReview(Window, Button, Matches, Expected);
                    if (Matches && Button) {
                        IFileManager::Get().Delete(*Request);
                        Button->SimulateClick();
                        break;
                    }
                }
            }
            return true;
        }), 0.25f);
    }
    void ShutdownModule() override { FTSTicker::GetCoreTicker().RemoveTicker(Tick); }
};
IMPLEMENT_MODULE(FLightingFixture, LightingFixture)
