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
//
// Read-only packages (spec T5). A package whose file carries the read-only
// attribute is refused BEFORE anything changes, with code package_read_only
// and a hint naming the file and how to take its lock. Hayba never clears
// read-only flags. Detail::SavePackageNoError is the only raw
// UPackage::SavePackage in Hayba, and it always passes SAVE_NoError: a save
// that fails anyway (a lock taken between preflight and save, an ACL) returns
// false instead of calling appError through GError, which is how a read-only
// file used to crash the editor. Tests: Hayba.MCP.Save.ReadOnly.*; contract:
// mcp-tools/hayba-mcp/src/tools/save-site-contract.test.ts.

#include "CoreMinimal.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "IHaybaMCPHandler.h"

namespace HaybaSaveVerify
{
    /** Wire contract: the data.code (promoted to the envelope code) of a save
     *  refused because a package file is read-only. Never renamed. */
    inline const TCHAR* const PackageReadOnlyCode = TEXT("package_read_only");

    /** Longest make_writable_hint: the router trims strings at 512 characters. */
    inline constexpr int32 MaxHintChars = 480;

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
        /** A package file was read-only, so the save was not attempted. */
        bool bRefusedReadOnly = false;
        TArray<FString> ReadOnlyFiles;
        /** "package_read_only" or "save_failed"; empty when the save reached disk. */
        FString SaveErrorCode;
        int64 FileSize = 0;
        FString FilePath;
        /** Plain-language note when the signals disagree; empty when they don't. */
        FString Note;

        /** The honest answer to "did my change reach disk". */
        bool DidReachDisk() const { return bFileExists && (bFileWritten || bSaveCallSucceeded); }
    };

    /** The file a package saves to: .umap for a world package, .uasset otherwise.
     *  Absolute; empty when the name has no mounted file location. */
    inline FString PackageFilename(const FString& LongPackageName, bool bIsMap)
    {
        FString Filename;
        if (!FPackageName::TryConvertLongPackageNameToFilename(LongPackageName, Filename,
                bIsMap ? FPackageName::GetMapPackageExtension() : FPackageName::GetAssetPackageExtension()))
        {
            return FString();
        }
        return FPaths::ConvertRelativePathToFull(Filename);
    }

    inline FString PackageFilename(const UPackage* Package)
    {
        return Package ? PackageFilename(Package->GetName(), Package->ContainsMap()) : FString();
    }

    /** Every file of the package that exists and is read-only: the header
     *  (.umap or .uasset) and its .uexp, .ubulk, .uptnl and .m.ubulk siblings.
     *  A missing file is never read-only (a new asset). Absolute paths. */
    inline TArray<FString> FindReadOnlyPackageFiles(const FString& LongPackageName)
    {
        TArray<FString> ReadOnly;
        FString Base;
        if (!FPackageName::TryConvertLongPackageNameToFilename(LongPackageName, Base))
        {
            return ReadOnly;
        }
        Base = FPaths::ConvertRelativePathToFull(Base);
        IFileManager& FM = IFileManager::Get();
        static const TCHAR* const Extensions[] = {
            TEXT(".umap"), TEXT(".uasset"), TEXT(".uexp"), TEXT(".ubulk"), TEXT(".uptnl"), TEXT(".m.ubulk") };
        for (const TCHAR* Extension : Extensions)
        {
            const FString File = Base + Extension;
            if (FM.IsReadOnly(*File))
            {
                ReadOnly.Add(File);
            }
        }
        return ReadOnly;
    }

    inline TArray<FString> FindReadOnlyPackageFiles(const UPackage* Package)
    {
        return Package ? FindReadOnlyPackageFiles(Package->GetName()) : TArray<FString>();
    }

    /** The path a person types: relative to the project when it is inside it. */
    inline FString ProjectRelativePath(const FString& AbsoluteFile)
    {
        FString Relative = AbsoluteFile;
        const FString ProjectDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
        if (FPaths::MakePathRelativeTo(Relative, *ProjectDir) && !Relative.StartsWith(TEXT("..")))
        {
            return Relative;
        }
        return AbsoluteFile;
    }

    /** How to make the file writable. At most MaxHintChars, alternative included. */
    inline FString MakeWritableHint(const TArray<FString>& ReadOnlyFiles, const FString& NoSaveAlternative)
    {
        FString First = ReadOnlyFiles.Num() > 0 ? ProjectRelativePath(ReadOnlyFiles[0]) : FString(TEXT("the package file"));
        if (First.Len() > 200)
        {
            First = TEXT("...") + First.Right(197);
        }
        const FString More = ReadOnlyFiles.Num() > 1
            ? FString::Printf(TEXT(" (and %d more file(s) of the package)"), ReadOnlyFiles.Num() - 1)
            : FString();
        FString Hint = FString::Printf(
            TEXT("Take its source-control lock and retry: git lfs lock \"%s\"%s (or check it out in Perforce), or clear the read-only flag yourself. Hayba never clears read-only flags."),
            *First, *More);
        if (!NoSaveAlternative.IsEmpty())
        {
            Hint += TEXT(" ");
            Hint += NoSaveAlternative;
        }
        return Hint.Left(MaxHintChars);
    }

    /** The structured refusal (R3 data channel; the router promotes data.code). */
    inline FHaybaHandlerResult ReadOnlyRefusal(
        const FString& Cmd, const FString& Package, const TArray<FString>& Files, const FString& NoSaveAlternative)
    {
        const FString Hint = MakeWritableHint(Files, NoSaveAlternative);
        const FString FirstFile = Files.Num() > 0 ? ProjectRelativePath(Files[0]) : Package;
        TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
        Data->SetBoolField(TEXT("ok"), false);
        Data->SetStringField(TEXT("code"), PackageReadOnlyCode);
        Data->SetStringField(TEXT("error"), FString::Printf(
            TEXT("%s [package_read_only]: %s cannot be saved: %s is read-only on disk. Nothing was changed. %s"),
            *Cmd, *Package, *FirstFile, *Hint));
        Data->SetStringField(TEXT("phase"), TEXT("preflight"));
        Data->SetStringField(TEXT("mutation_status"), TEXT("not_started"));
        Data->SetStringField(TEXT("failure_kind"), TEXT("policy_blocked"));
        Data->SetStringField(TEXT("package"), Package);
        TArray<TSharedPtr<FJsonValue>> FileValues;
        for (const FString& File : Files)
        {
            FileValues.Add(MakeShared<FJsonValueString>(File));
        }
        Data->SetArrayField(TEXT("read_only_files"), FileValues);
        Data->SetStringField(TEXT("make_writable_hint"), Hint);
        Data->SetBoolField(TEXT("save_attempted"), false);
        Data->SetBoolField(TEXT("saved"), false);
        return FHaybaHandlerResult::Ok(Data);
    }

    /** True (and OutRefusal set) when any file of `Package` is read-only. Call it
     *  as RefuseIfReadOnly(TEXT("<cmd>"), …) strictly before the command's first
     *  mutation: the save-site contract matches that literal. */
    inline bool RefuseIfReadOnly(
        const FString& Cmd, const FString& Package, FHaybaHandlerResult& OutRefusal,
        const FString& NoSaveAlternative = FString())
    {
        const TArray<FString> Files = FindReadOnlyPackageFiles(Package);
        if (Files.Num() == 0)
        {
            return false;
        }
        OutRefusal = ReadOnlyRefusal(Cmd, Package, Files, NoSaveAlternative);
        return true;
    }

    namespace Detail
    {
        /** THE only raw UPackage::SavePackage in Hayba. SAVE_NoError: a failed
         *  save returns false instead of calling appError through GError. */
        inline bool SavePackageNoError(UPackage* Pkg, UObject* Asset, const FString& Filename)
        {
            FSavePackageArgs Args;
            Args.TopLevelFlags = RF_Public | RF_Standalone;
            Args.SaveFlags = SAVE_NoError;
            return UPackage::SavePackage(Pkg, Asset, *Filename, Args);
        }
    }

    /** Save `Asset`'s package and verify the result against the file system.
     *  A read-only package file is refused before SavePackage is reached. */
    inline FResult SaveAndVerify(UObject* Asset)
    {
        FResult R;
        if (!Asset) { R.Note = TEXT("no asset supplied"); return R; }

        UPackage* Pkg = Asset->GetOutermost();
        if (!Pkg) { R.Note = TEXT("asset has no package"); return R; }

        R.FilePath = PackageFilename(Pkg);   // .umap for a map (C12)
        if (R.FilePath.IsEmpty())
        {
            R.Note = TEXT("The package has no file location on disk. NOT persisted.");
            R.SaveErrorCode = TEXT("save_failed");
            return R;
        }

        IFileManager& FM = IFileManager::Get();
        R.ReadOnlyFiles = FindReadOnlyPackageFiles(Pkg);
        if (R.ReadOnlyFiles.Num() > 0)
        {
            R.bRefusedReadOnly = true;
            R.SaveErrorCode = PackageReadOnlyCode;
            R.bFileExists = FM.FileExists(*R.FilePath);
            R.FileSize = R.bFileExists ? FM.FileSize(*R.FilePath) : 0;
            R.bStillDirty = Pkg->IsDirty();
            R.Note = FString::Printf(
                TEXT("%s is read-only on disk; the save was not attempted and the file was not changed. NOT persisted. %s"),
                *ProjectRelativePath(R.ReadOnlyFiles[0]), *MakeWritableHint(R.ReadOnlyFiles, FString()));
            return R;
        }

        const FDateTime Before = FM.GetTimeStamp(*R.FilePath);   // min value when absent
        R.bSaveCallSucceeded = Detail::SavePackageNoError(Pkg, Asset, R.FilePath);

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
        else if (!R.bSaveCallSucceeded && !R.bFileWritten)
        {
            R.Note = TEXT("SavePackage failed and the file on disk was not changed. NOT persisted; see LogSavePackage.");
        }
        else if (R.bStillDirty)
        {
            R.Note = TEXT("Written to disk, but the package still reads dirty. That is normal after some ")
                     TEXT("edits and does NOT mean the save failed — file_written is the signal that matters.");
        }
        if (!R.DidReachDisk())
        {
            R.SaveErrorCode = TEXT("save_failed");
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
        if (!R.SaveErrorCode.IsEmpty()) Out->SetStringField(TEXT("save_error_code"), R.SaveErrorCode);
        if (R.bRefusedReadOnly)
        {
            TArray<TSharedPtr<FJsonValue>> Files;
            for (const FString& File : R.ReadOnlyFiles)
            {
                Files.Add(MakeShared<FJsonValueString>(File));
            }
            Out->SetArrayField(TEXT("read_only_files"), Files);
            Out->SetStringField(TEXT("make_writable_hint"), MakeWritableHint(R.ReadOnlyFiles, FString()));
        }
    }
}
