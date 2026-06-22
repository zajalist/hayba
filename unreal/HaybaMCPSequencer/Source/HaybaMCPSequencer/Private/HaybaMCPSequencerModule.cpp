// HaybaMCPSequencer — satellite plugin for the Sequencer (seq_*) commands.
// See HaybaMCPGAS for the pattern.

#include "Modules/ModuleManager.h"
#include "Modules/ModuleInterface.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSequencerHandler.h"

class FHaybaMCPSequencerModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        Handler = MakeShared<FHaybaMCPSequencerHandler>();
        FHaybaMCPModule& Core = FModuleManager::LoadModuleChecked<FHaybaMCPModule>("HaybaMCPToolkit");
        Core.RegisterExternalHandler(Handler.ToSharedRef());
    }

    virtual void ShutdownModule() override
    {
        if (Handler.IsValid())
        {
            if (FHaybaMCPModule* Core = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
            {
                Core->UnregisterExternalHandler(Handler.ToSharedRef());
            }
            Handler.Reset();
        }
    }

private:
    TSharedPtr<FHaybaMCPSequencerHandler> Handler;
};

IMPLEMENT_MODULE(FHaybaMCPSequencerModule, HaybaMCPSequencer)
