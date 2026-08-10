#include "Misc/AutomationTest.h"

#if WITH_EDITOR

#include "Blueprint/UserWidget.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "EditorAssetLibrary.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HaybaMCPCommandHandler.h"
#include "RHIGlobals.h"
#include "UObject/GarbageCollection.h"
#include "UObject/ObjectKey.h"
#include "UObject/UObjectHash.h"
#include "UObject/UObjectIterator.h"
#include "WidgetBlueprint.h"
#include "handlers/HaybaMCPUIHandler.h"
#include "handlers/HaybaMCPUILayout.h"

namespace
{
    struct FScratchPreviewWidget
    {
        FString AssetPath;
        FString ObjectPath;
        bool bValid = false;

        explicit FScratchPreviewWidget(FHaybaMCPUIHandler& Handler)
        {
            const FString Name = FString::Printf(TEXT("WBP_PreviewLifetime_%s"),
                *FGuid::NewGuid().ToString(EGuidFormats::Digits));
            const FString PackagePath = TEXT("/Game/HaybaMCPAutomation");
            AssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *Name);

            TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
            Create->SetStringField(TEXT("path"), PackagePath);
            Create->SetStringField(TEXT("name"), Name);
            Create->SetStringField(TEXT("parent_class"), TEXT("UserWidget"));
            const FHaybaHandlerResult Created = Handler.Handle(TEXT("ui_create_widget"), Create);
            if (!Created.bOk || !Created.Data.IsValid()) return;
            Created.Data->TryGetStringField(TEXT("path"), ObjectPath);
            if (ObjectPath.IsEmpty()) return;

            TSharedPtr<FJsonObject> Add = MakeShared<FJsonObject>();
            Add->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
            Add->SetStringField(TEXT("child_class"), TEXT("Border"));
            Add->SetStringField(TEXT("name"), TEXT("PreviewFill"));
            if (!Handler.Handle(TEXT("ui_add_element"), Add).bOk) return;

            TSharedPtr<FJsonObject> Compile = MakeShared<FJsonObject>();
            Compile->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
            bValid = Handler.Handle(TEXT("ui_compile_widget"), Compile).bOk;
        }

        void Cleanup() const
        {
            if (!AssetPath.IsEmpty()) UEditorAssetLibrary::DeleteAsset(AssetPath);
        }
    };

    /**
     * Test against a private transaction buffer so a failure cannot consume,
     * reset, or append to the developer's real Undo History.
     */
    struct FScopedIsolatedUndoBuffer
    {
        UTransactor* Original = nullptr;
        UTransBuffer* Isolated = nullptr;

        FScopedIsolatedUndoBuffer()
        {
            if (!GEditor) return;
            Original = GEditor->Trans;
            Isolated = NewObject<UTransBuffer>(GetTransientPackage());
            Isolated->AddToRoot();
            Isolated->Initialize(8 * 1024 * 1024);
            GEditor->Trans = Isolated;
        }

        ~FScopedIsolatedUndoBuffer()
        {
            if (!GEditor || !Isolated) return;
            if (Isolated->IsActive()) Isolated->Cancel(0);
            Isolated->Reset(FText::FromString(TEXT("Hayba preview-lifetime test teardown")));
            GEditor->Trans = Original;
            Isolated->RemoveFromRoot();
            Isolated->MarkAsGarbage();
        }

        bool IsValid() const { return Original != nullptr && Isolated != nullptr; }
    };

    TSet<FObjectKey> SnapshotTransientWorlds()
    {
        TSet<FObjectKey> Result;
        for (TObjectIterator<UWorld> It; It; ++It)
        {
            if (It->GetOutermost() == GetTransientPackage()) Result.Add(FObjectKey(*It));
        }
        return Result;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPUIPreviewLifetimeTest,
    "Hayba.MCP.UI.PreviewLifetimePreservesUndoAndGCs",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPUIPreviewLifetimeTest::RunTest(const FString& Parameters)
{
    if (!GEditor || !GEditor->Trans)
    {
        AddWarning(TEXT("A live editor transaction system is required for the preview lifetime regression"));
        return true;
    }
    if (!FSlateApplication::IsInitialized())
    {
        AddWarning(TEXT("Slate is not initialized; preview lifetime cannot be exercised in this process"));
        return true;
    }

    // Plan Mode and Undo History have different safety boundaries. Compilation
    // remains destructive/gated, but must not wrap UE's transient validation
    // worlds in a global transaction.
    TestFalse(TEXT("UMG compile does not create a global editor transaction"),
        FHaybaMCPCommandHandler::ShouldCreateEditorTransaction(TEXT("ui_compile_widget")));
    TestFalse(TEXT("render is read-only and creates no editor transaction"),
        FHaybaMCPCommandHandler::ShouldCreateEditorTransaction(TEXT("ui_render_widget_to_png")));
    TestTrue(TEXT("ordinary UMG mutation still receives undo support"),
        FHaybaMCPCommandHandler::ShouldCreateEditorTransaction(TEXT("ui_set_widget_properties")));

    FHaybaMCPUIHandler Handler;
    FScratchPreviewWidget Scratch(Handler);
    if (!TestTrue(TEXT("representative WBP was created and compiled"), Scratch.bValid))
    {
        Scratch.Cleanup();
        return true;
    }

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *Scratch.ObjectPath);
    if (!TestNotNull(TEXT("representative WBP remains loadable"), WBP))
    {
        Scratch.Cleanup();
        return true;
    }
    WBP->AddToRoot();

    UTransactor* const UserUndoBuffer = GEditor->Trans;
    const int32 UserUndoCount = UserUndoBuffer->GetQueueLength();

    {
        FScopedIsolatedUndoBuffer UndoScope;
        if (!TestTrue(TEXT("isolated undo buffer was installed"), UndoScope.IsValid()))
        {
            WBP->RemoveFromRoot();
            Scratch.Cleanup();
            return true;
        }

        // Seed one unrelated undo record. Every preview and GC below must leave
        // this record present and still undoable.
        GEditor->BeginTransaction(FText::FromString(TEXT("Existing user edit")));
        WBP->Modify();
        GEditor->EndTransaction();
        const int32 SeededQueueLength = UndoScope.Isolated->GetQueueLength();
        FText UndoBefore;
        TestTrue(TEXT("seeded history can be undone"), UndoScope.Isolated->CanUndo(&UndoBefore));
        TestTrue(TEXT("seed transaction contains a record"), SeededQueueLength > 0);

        // Compiling outside a global transaction is the production command
        // policy. UWidgetBlueprint validation may create dummy transient worlds;
        // none may survive the forced collection that follows.
        const TSet<FObjectKey> WorldsBeforeCompile = SnapshotTransientWorlds();
        TSharedPtr<FJsonObject> Compile = MakeShared<FJsonObject>();
        Compile->SetStringField(TEXT("widget_blueprint_path"), Scratch.ObjectPath);
        GEditor->BeginTransaction(FText::FromString(TEXT("Concurrent compile gesture")));
        const FHaybaHandlerResult Compiled = Handler.Handle(TEXT("ui_compile_widget"), Compile);
        GEditor->EndTransaction();
        TestTrue(TEXT("representative WBP recompiles"), Compiled.bOk);
        if (Compiled.Data.IsValid())
        {
            TestTrue(TEXT("widget compile reports effective success"), Compiled.Data->GetBoolField(TEXT("ok")));
            TestTrue(TEXT("widget compile reports a clean compile"), Compiled.Data->GetBoolField(TEXT("compiled_clean")));
        }

        TArray<TWeakObjectPtr<UWorld>> CompilePreviewWorlds;
        for (TObjectIterator<UWorld> It; It; ++It)
        {
            if (It->GetOutermost() == GetTransientPackage() &&
                !WorldsBeforeCompile.Contains(FObjectKey(*It)))
            {
                CompilePreviewWorlds.Add(*It);
            }
        }

        // Exercise the renderer's exact preview object. Generated UMG trees and
        // slots are transactional by default; Hayba must scrub the whole graph,
        // even if a user/editor transaction happens to be active concurrently.
        TArray<TWeakObjectPtr<UUserWidget>> PreviewInstances;
        for (int32 Iteration = 0; Iteration < 8; ++Iteration)
        {
            HaybaUILayout::FPreviewInstance Preview;
            FString Error;
            if (!TestTrue(*FString::Printf(TEXT("preview %d is created"), Iteration),
                HaybaUILayout::MakePreviewInstance(WBP, Preview, Error)))
            {
                AddError(Error);
                break;
            }

            TestTrue(*FString::Printf(TEXT("preview %d is transient"), Iteration),
                Preview.Instance->HasAnyFlags(RF_Transient));
            TestFalse(*FString::Printf(TEXT("preview %d is non-transactional"), Iteration),
                Preview.Instance->HasAnyFlags(RF_Transactional));

            bool bTransactionalDescendant = false;
            ForEachObjectWithOuter(Preview.Instance, [&bTransactionalDescendant](UObject* Object)
            {
                bTransactionalDescendant |= Object && Object->HasAnyFlags(RF_Transactional);
            }, EGetObjectsFlags::IncludeNestedObjects);
            TestFalse(*FString::Printf(TEXT("preview %d has no transactional descendants"), Iteration),
                bTransactionalDescendant);
            TestFalse(*FString::Printf(TEXT("preview %d is absent from undo history"), Iteration),
                UndoScope.Isolated->IsObjectInTransactionBuffer(Preview.Instance));
            PreviewInstances.Add(Preview.Instance);
        }

        // Render the representative WBP through the public command while an
        // unrelated transaction is open. Empty transactions are discarded; if
        // the preview leaks into UTransBuffer this creates a second undo entry.
        if (!GUsingNullRHI)
        {
            GEditor->BeginTransaction(FText::FromString(TEXT("Concurrent editor gesture")));
            for (int32 Iteration = 0; Iteration < 3; ++Iteration)
            {
                TSharedPtr<FJsonObject> Render = MakeShared<FJsonObject>();
                Render->SetStringField(TEXT("widget_blueprint_path"), Scratch.ObjectPath);
                Render->SetNumberField(TEXT("width"), 96);
                Render->SetNumberField(TEXT("height"), 64);
                Render->SetBoolField(TEXT("inline_image"), false);
                const FHaybaHandlerResult Rendered = Handler.Handle(TEXT("ui_render_widget_to_png"), Render);
                if (TestTrue(*FString::Printf(TEXT("render %d succeeds"), Iteration), Rendered.bOk))
                {
                    FString Path;
                    if (Rendered.Data->TryGetStringField(TEXT("out_path"), Path))
                    {
                        IFileManager::Get().Delete(*Path);
                    }
                }
            }
            GEditor->EndTransaction();
        }
        else
        {
            AddInfo(TEXT("NullRHI: lifecycle/transaction checks ran; PNG draw is covered in the real-RHI editor gauntlet"));
        }

        CollectGarbage(RF_NoFlags);

        for (int32 Index = 0; Index < PreviewInstances.Num(); ++Index)
        {
            TestNull(*FString::Printf(TEXT("preview %d is released by GC"), Index),
                PreviewInstances[Index].Get(/*bEvenIfPendingKill=*/true));
        }
        for (int32 Index = 0; Index < CompilePreviewWorlds.Num(); ++Index)
        {
            TestNull(*FString::Printf(TEXT("compile preview world %d is released by GC"), Index),
                CompilePreviewWorlds[Index].Get(/*bEvenIfPendingKill=*/true));
        }

        FText UndoAfter;
        TestEqual(TEXT("preview/compile/GC preserve the existing queue length"),
            UndoScope.Isolated->GetQueueLength(), SeededQueueLength);
        TestTrue(TEXT("existing history remains undoable after preview/GC"),
            UndoScope.Isolated->CanUndo(&UndoAfter));
        TestEqual(TEXT("existing undo title is unchanged"), UndoAfter.ToString(), UndoBefore.ToString());
    }

    // The private-buffer gauntlet must not have replaced or mutated the user's
    // actual global undo history.
    TestTrue(TEXT("real undo buffer pointer is restored"), GEditor->Trans == UserUndoBuffer);
    TestEqual(TEXT("real undo queue is untouched"),
        UserUndoBuffer->GetQueueLength(), UserUndoCount);

    WBP->RemoveFromRoot();
    Scratch.Cleanup();
    return true;
}

#endif // WITH_EDITOR
