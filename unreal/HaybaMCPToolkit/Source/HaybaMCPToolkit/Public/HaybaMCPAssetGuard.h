#pragma once

// Guards against handlers raising modal dialogs.
//
// This exists because of a failure that is disproportionately expensive to
// diagnose. Handlers run on the editor's game thread. A modal dialog blocks that
// thread, which is the same thread that would send the reply — so the command
// never completes, the caller times out, and every subsequent request queues
// behind it until a human notices the box and clicks it. Nothing is written to
// the log. From the agent's side the whole editor has simply stopped answering.
//
// IAssetTools::CreateAsset is the common way to trip it: on a name collision it
// asks "Overwrite Existing Object?" rather than failing. Nothing about that
// question needs a human — the caller supplied the name and can supply another —
// so it is answered here, before the dialog can appear.
//
// Any handler calling an editor API that can prompt should check first. If you
// add a call to CreateAsset, DeleteAssets, RenameAssets or friends, assume it
// prompts until you have checked the engine source.

#include "CoreMinimal.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "UObject/SoftObjectPath.h"

namespace HaybaAssetGuard
{
    /** Object path UE will use for an asset at `PackagePath`/`AssetName`. */
    inline FString MakeObjectPath(const FString& PackagePath, const FString& AssetName)
    {
        FString Dir = PackagePath;
        Dir.RemoveFromEnd(TEXT("/"));
        return FString::Printf(TEXT("%s/%s.%s"), *Dir, *AssetName, *AssetName);
    }

    /** True when something already occupies that asset path.
     *
     *  Checks the asset registry AND live memory: an asset created earlier in
     *  the same session and not yet saved is absent from the registry but still
     *  collides, and that is exactly the case an agent hits when it retries a
     *  call it thinks failed. */
    inline bool AssetNameTaken(const FString& PackagePath, const FString& AssetName)
    {
        const FString ObjectPath = MakeObjectPath(PackagePath, AssetName);

        const FAssetRegistryModule& RegistryModule =
            FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
        if (RegistryModule.Get().GetAssetByObjectPath(FSoftObjectPath(ObjectPath)).IsValid())
        {
            return true;
        }

        return FindObject<UObject>(nullptr, *ObjectPath) != nullptr;
    }

    /** Error text for a taken name. Says why it refuses rather than prompting,
     *  because the alternative failure mode is invisible and the reader deserves
     *  to know the tool chose this deliberately. */
    inline FString NameTakenError(const FString& Command, const FString& PackagePath, const FString& AssetName)
    {
        return FString::Printf(
            TEXT("%s: '%s' already exists at %s. Choose another name, or edit the existing asset. ")
            TEXT("This is refused rather than prompting to overwrite, because a modal dialog would block ")
            TEXT("the editor's game thread and hang every MCP request behind it."),
            *Command, *AssetName, *PackagePath);
    }
}
