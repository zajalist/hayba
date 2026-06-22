// HaybaMCPNiagara — satellite plugin for the Niagara (niagara_*) commands.
// See HaybaMCPGAS for the pattern: own plugin with a hard Niagara dependency,
// self-registers its handler into the core router at StartupModule.

#include "Modules/ModuleManager.h"
#include "Modules/ModuleInterface.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPNiagaraHandler.h"

class FHaybaMCPNiagaraModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        Handler = MakeShared<FHaybaMCPNiagaraHandler>();
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
    TSharedPtr<FHaybaMCPNiagaraHandler> Handler;
};

IMPLEMENT_MODULE(FHaybaMCPNiagaraModule, HaybaMCPNiagara)
