#pragma once

// Saving, reported honestly.
//
// "Did my change reach disk?" is the question a caller most needs answered
// before restarting the editor, and it was the one thing our save tools could
// not answer clearly. The old ui_save_widget derived its `success` field from
// `UPackage::IsDirty()` AFTER the save — which is a different question. A
// package can be written to disk correctly and still report dirty, so a caller
// who had just saved successfully was told `success: false` and had to guess.
//
// The fix is to stop inferring from flags and check the artefact. This helper
// stats the target file before and after the save, so the answer comes from the
// file system rather than from engine bookkeeping:
//
//   saved            the save call itself reported success
//   file_written     the file exists AND its timestamp advanced — ground truth
//   still_dirty      informational only; NEVER the success signal
//
// If those three ever disagree, the response says so in words instead of
// leaving the caller to reconcile them.

#include "CoreMinimal.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "Dom/JsonObject.h"

namespace HaybaSaveVerify
{
    struct FResult
    {
        /** UPackage::SavePackage's own return value. */
        bool bSaveCallSucceeded = false;
        /** The file exists on disk after the call. */
        bool bFileExists = false;
        /** Its timestamp advanced, i.e. this call actually rewrote it. */
        bool bFileWritten = false;
        /** Package still flagged dirty. Informational — a saved package can
         *  legitimately remain dirty, so this must not gate success. */
        bool bStillDirty = false;
        int64 FileSize = 0;
        FString FilePath;
        /** Plain-language note when the signals disagree; empty when they don't. */
        FString Note;

        /** The honest answer to "did my change reach disk". */
        bool DidReachDisk() const { return bFileExists && (bFileWritten || bSaveCallSucceeded); }
    };

    /** Save `Asset`'s package and verify the result against the file system. */
    inline FResult SaveAndVerify(UObject* Asset)
    {
        FResult R;
        if (!Asset) { R.Note = TEXT("no asset supplied"); return R; }

        UPackage* Pkg = Asset->GetOutermost();
        if (!Pkg) { R.Note = TEXT("asset has no package"); return R; }

        R.FilePath = FPackageName::LongPackageNameToFilename(
            Pkg->GetName(), FPackageName::GetAssetPackageExtension());

        IFileManager& FM = IFileManager::Get();
        const FDateTime Before = FM.GetTimeStamp(*R.FilePath);   // min value when absent

        FSavePackageArgs Args;
        Args.TopLevelFlags = RF_Public | RF_Standalone;
        Args.SaveFlags = SAVE_NoError;
        R.bSaveCallSucceeded = UPackage::SavePackage(Pkg, Asset, *R.FilePath, Args);

        const FDateTime After = FM.GetTimeStamp(*R.FilePath);
        R.bFileExists = FM.FileExists(*R.FilePath);
        R.bFileWritten = R.bFileExists && After > Before;
        R.FileSize = R.bFileExists ? FM.FileSize(*R.FilePath) : 0;
        R.bStillDirty = Pkg->IsDirty();

        // Reconcile the signals in words, so a caller never has to.
        if (!R.bFileExists)
        {
            R.Note = TEXT("No file on disk after the save. The change is NOT persisted.");
        }
        else if (!R.bSaveCallSucceeded && R.bFileWritten)
        {
            R.Note = TEXT("SavePackage reported failure but the file was rewritten. Treat as saved; ")
                     TEXT("check the editor log for what it objected to.");
        }
        else if (R.bSaveCallSucceeded && !R.bFileWritten)
        {
            R.Note = TEXT("Save reported success and the file exists, but its timestamp did not advance — ")
                     TEXT("usually means the contents were already identical. Nothing was lost.");
        }
        else if (R.bStillDirty)
        {
            R.Note = TEXT("Written to disk, but the package still reads dirty. That is normal after some ")
                     TEXT("edits and does NOT mean the save failed — file_written is the signal that matters.");
        }
        return R;
    }

    /** Write the result into a response object under stable field names. */
    inline void Describe(const FResult& R, const TSharedPtr<FJsonObject>& Out)
    {
        if (!Out.IsValid()) return;
        Out->SetBoolField(TEXT("saved"), R.DidReachDisk());
        Out->SetBoolField(TEXT("file_written"), R.bFileWritten);
        Out->SetBoolField(TEXT("save_call_succeeded"), R.bSaveCallSucceeded);
        Out->SetBoolField(TEXT("still_dirty"), R.bStillDirty);
        Out->SetStringField(TEXT("file_path"), R.FilePath);
        Out->SetNumberField(TEXT("file_size"), static_cast<double>(R.FileSize));
        if (!R.Note.IsEmpty()) Out->SetStringField(TEXT("note"), R.Note);
    }
}
