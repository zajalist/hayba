// HaybaMCPMetaSound — satellite plugin for the MetaSound (metasound_*) commands.
// See HaybaMCPGAS for the pattern.

#include "Modules/ModuleManager.h"
#include "Modules/ModuleInterface.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPMetaSoundHandler.h"

class FHaybaMCPMetaSoundModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        Handler = MakeShared<FHaybaMCPMetaSoundHandler>();
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
    TSharedPtr<FHaybaMCPMetaSoundHandler> Handler;
};

IMPLEMENT_MODULE(FHaybaMCPMetaSoundModule, HaybaMCPMetaSound)
