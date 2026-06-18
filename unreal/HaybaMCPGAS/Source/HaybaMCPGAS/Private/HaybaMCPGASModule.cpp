// HaybaMCPGAS — satellite module for the GameplayAbilities (gas_*) commands.
//
// This module exists as its OWN plugin (HaybaMCPGAS.uplugin) which declares a
// hard dependency on the GameplayAbilities plugin. When the user disables
// GameplayAbilities, UE disables this plugin and the core HaybaMCPToolkit keeps
// loading — the gas_* commands simply aren't registered, and the router returns
// a clean "unknown command" instead of the whole toolkit failing to load.
//
// At startup we register our handler into the core router; at shutdown we detach.

#include "Modules/ModuleManager.h"
#include "Modules/ModuleInterface.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPGASHandler.h"

class FHaybaMCPGASModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        Handler = MakeShared<FHaybaMCPGASHandler>();
        // LoadModuleChecked (not GetModulePtr) guarantees the core module's
        // StartupModule has fully run — i.e. its command router exists — before
        // we register, regardless of PostEngineInit module load order.
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
    TSharedPtr<FHaybaMCPGASHandler> Handler;
};

IMPLEMENT_MODULE(FHaybaMCPGASModule, HaybaMCPGAS)
