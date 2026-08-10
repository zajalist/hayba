#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "EditorAssetLibrary.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "WidgetBlueprint.h"
#include "handlers/HaybaMCPUIHandler.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "RHIGlobals.h"

namespace
{
    /** A compiled Widget Blueprint with one coloured Border filling the canvas,
     *  so a render of it is guaranteed to produce non-blank pixels. */
    struct FScratchWidget
    {
        FString AssetPath;
        FString ObjectPath;
        bool bValid = false;

        explicit FScratchWidget(FHaybaMCPUIHandler& Handler, const TCHAR* Tag)
        {
            const FString Name = FString::Printf(TEXT("WBP_%s_%s"), Tag,
                *FGuid::NewGuid().ToString(EGuidFormats::Digits));
            const FString PackagePath = TEXT("/Game/HaybaMCPAutomation");
            AssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *Name);

            TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
            P->SetStringField(TEXT("path"), PackagePath);
            P->SetStringField(TEXT("name"), Name);
            P->SetStringField(TEXT("parent_class"), TEXT("UserWidget"));
            const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_create_widget"), P);
            if (!R.bOk || !R.Data.IsValid()) return;
            R.Data->TryGetStringField(TEXT("path"), ObjectPath);
            bValid = !ObjectPath.IsEmpty();
        }

        void Cleanup() const
        {
            if (!AssetPath.IsEmpty()) UEditorAssetLibrary::DeleteAsset(AssetPath);
        }
    };

    FHaybaHandlerResult AddBorder(FHaybaMCPUIHandler& Handler, const FString& ObjectPath, const TCHAR* Name)
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
        P->SetStringField(TEXT("child_class"), TEXT("Border"));
        P->SetStringField(TEXT("name"), Name);
        return Handler.Handle(TEXT("ui_add_element"), P);
    }

    void Compile(const FString& ObjectPath)
    {
        if (UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath))
        {
            FKismetEditorUtilities::CompileBlueprint(WBP);
        }
    }

    /** True when the file starts with the PNG magic number. Checked because
     *  UE's other compress helpers emit JPEG bytes behind a .png extension. */
    bool IsRealPng(const FString& Path)
    {
        TArray<uint8> Bytes;
        if (!FFileHelper::LoadFileToArray(Bytes, *Path) || Bytes.Num() < 8) return false;
        return Bytes[0] == 0x89 && Bytes[1] == 0x50 && Bytes[2] == 0x4E && Bytes[3] == 0x47;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPRenderWidgetToPngTest,
    "Hayba.MCP.UI.RenderWidgetToPng",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPRenderWidgetToPngTest::RunTest(const FString& Parameters)
{
    FHaybaMCPUIHandler Handler;

    // A missing blueprint must be refused, not rendered as an empty image.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), TEXT("/Game/DoesNotExist.DoesNotExist"));
        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_render_widget_to_png"), P);
        TestFalse(TEXT("missing blueprint is refused"), R.bOk);
    }

    // A missing path parameter is refused.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_render_widget_to_png"), P);
        TestFalse(TEXT("missing widget_blueprint_path is refused"), R.bOk);
    }

    // NullRHI cannot render and therefore cannot prove this behavior. The old
    // test continued into FWidgetRenderer and failed in engine code, leaving
    // the suite permanently 14/15. Clean refusal is the only valid NullRHI
    // assertion; the real-RHI run below remains release evidence.
    if (GUsingNullRHI)
    {
        AddInfo(TEXT("ui_render_widget_to_png requires a real RHI; clean NullRHI refusal is covered by Hayba.MCP.RenderSafety.Policy"));
        return true;
    }

    FScratchWidget W(Handler, TEXT("Render"));
    if (!TestTrue(TEXT("scratch widget blueprint was created"), W.bValid)) return true;

    const FHaybaHandlerResult Added = AddBorder(Handler, W.ObjectPath, TEXT("Fill"));
    TestTrue(TEXT("border added"), Added.bOk);
    Compile(W.ObjectPath);

    FString OutPath;
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        P->SetNumberField(TEXT("width"), 320);
        P->SetNumberField(TEXT("height"), 240);
        // Skip the base64 so the test does not carry a megabyte of string it
        // never looks at; the file on disk is what is being verified.
        P->SetBoolField(TEXT("inline_image"), false);

        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_render_widget_to_png"), P);
        if (!TestTrue(TEXT("render succeeds"), R.bOk))
        {
            AddError(FString::Printf(TEXT("render failed: %s"), *R.ErrorMessage));
            W.Cleanup();
            return true;
        }

        TestTrue(TEXT("returns out_path"), R.Data->TryGetStringField(TEXT("out_path"), OutPath));

        double Width = 0, Height = 0;
        R.Data->TryGetNumberField(TEXT("width"), Width);
        R.Data->TryGetNumberField(TEXT("height"), Height);
        TestEqual(TEXT("honours requested width"), (int32)Width, 320);
        TestEqual(TEXT("honours requested height"), (int32)Height, 240);

        double Bytes = 0;
        R.Data->TryGetNumberField(TEXT("bytes"), Bytes);
        TestTrue(TEXT("reports a non-zero byte count"), Bytes > 0);

        // The evidence field: a widget that drew nothing still produces a valid,
        // correctly-sized, entirely blank PNG. coverage_percent is what tells
        // the caller which of those happened.
        double Coverage = -1;
        TestTrue(TEXT("reports coverage_percent"), R.Data->TryGetNumberField(TEXT("coverage_percent"), Coverage));
        TestTrue(TEXT("a filled border covers pixels"), Coverage > 0.0);
        TestFalse(TEXT("no blank-render warning for a widget that drew"), R.Data->HasField(TEXT("warning")));

        TestFalse(TEXT("inline_image:false omits the base64"), R.Data->HasField(TEXT("image_base64")));
    }

    // The file must exist, be non-empty, and be an actual PNG — not JPEG bytes
    // behind a .png extension, which is a trap this codebase has hit before.
    TestTrue(TEXT("the PNG exists on disk"), FPaths::FileExists(OutPath));
    TestTrue(TEXT("the file is a real PNG (magic bytes)"), IsRealPng(OutPath));
    TestTrue(TEXT("the PNG is not empty"), IFileManager::Get().FileSize(*OutPath) > 0);

    // scale multiplies the output size.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        P->SetNumberField(TEXT("width"), 200);
        P->SetNumberField(TEXT("height"), 100);
        P->SetNumberField(TEXT("scale"), 2.0);
        P->SetBoolField(TEXT("inline_image"), false);
        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_render_widget_to_png"), P);
        if (R.bOk)
        {
            double Width = 0, Height = 0;
            R.Data->TryGetNumberField(TEXT("width"), Width);
            R.Data->TryGetNumberField(TEXT("height"), Height);
            TestEqual(TEXT("scale doubles width"), (int32)Width, 400);
            TestEqual(TEXT("scale doubles height"), (int32)Height, 200);
            FString P2; R.Data->TryGetStringField(TEXT("out_path"), P2);
            IFileManager::Get().Delete(*P2);
        }
    }

    // Requesting the image inline returns base64 that decodes to the same PNG.
    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        P->SetNumberField(TEXT("width"), 64);
        P->SetNumberField(TEXT("height"), 64);
        P->SetBoolField(TEXT("inline_image"), true);
        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_render_widget_to_png"), P);
        if (R.bOk)
        {
            FString B64;
            if (TestTrue(TEXT("inline_image:true returns base64"), R.Data->TryGetStringField(TEXT("image_base64"), B64)))
            {
                TArray<uint8> Decoded;
                TestTrue(TEXT("base64 decodes"), FBase64::Decode(B64, Decoded));
                TestTrue(TEXT("decoded bytes are a PNG"),
                    Decoded.Num() > 8 && Decoded[0] == 0x89 && Decoded[1] == 0x50 &&
                    Decoded[2] == 0x4E && Decoded[3] == 0x47);
            }
            FString P3; R.Data->TryGetStringField(TEXT("out_path"), P3);
            IFileManager::Get().Delete(*P3);
        }
    }

    IFileManager::Get().Delete(*OutPath);
    W.Cleanup();
    return true;
}

// ── Brush facts ─────────────────────────────────────────────────────────────

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPBrushInfoTest,
    "Hayba.MCP.UI.BrushInfoCompleteness",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBrushInfoTest::RunTest(const FString& Parameters)
{
    FHaybaMCPUIHandler Handler;

    FScratchWidget W(Handler, TEXT("Brush"));
    if (!TestTrue(TEXT("scratch widget blueprint was created"), W.bValid)) return true;

    TestTrue(TEXT("border added"), AddBorder(Handler, W.ObjectPath, TEXT("Frame")).bOk);

    // Set the brush the way a 9-slice frame actually needs: Box draw type with
    // a fractional margin. Reproducing this was impossible through ui_set_brush
    // before Box was added to the enum, and discovering it was impossible
    // before brush_info reported draw_as and margin.
    {
        TSharedPtr<FJsonObject> Brush = MakeShared<FJsonObject>();
        Brush->SetStringField(TEXT("DrawAs"), TEXT("Box"));
        TSharedPtr<FJsonObject> Margin = MakeShared<FJsonObject>();
        Margin->SetNumberField(TEXT("Left"), 0.25);
        Margin->SetNumberField(TEXT("Top"), 0.25);
        Margin->SetNumberField(TEXT("Right"), 0.25);
        Margin->SetNumberField(TEXT("Bottom"), 0.25);
        Brush->SetObjectField(TEXT("Margin"), Margin);

        TSharedPtr<FJsonObject> Props = MakeShared<FJsonObject>();
        Props->SetObjectField(TEXT("Background"), Brush);

        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        P->SetStringField(TEXT("widget_name"), TEXT("Frame"));
        P->SetObjectField(TEXT("properties"), Props);
        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_set_widget_properties"), P);
        TestTrue(TEXT("brush properties applied"), R.bOk);
    }

    Compile(W.ObjectPath);

    {
        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_layout_snapshot"), P);
        if (!TestTrue(TEXT("layout snapshot succeeds"), R.bOk)) { W.Cleanup(); return true; }

        const TArray<TSharedPtr<FJsonValue>>* Widgets = nullptr;
        if (!TestTrue(TEXT("snapshot returns widgets"), R.Data->TryGetArrayField(TEXT("widgets"), Widgets)))
        {
            W.Cleanup();
            return true;
        }

        const TSharedPtr<FJsonObject>* Brush = nullptr;
        for (const TSharedPtr<FJsonValue>& V : *Widgets)
        {
            const TSharedPtr<FJsonObject> Obj = V->AsObject();
            FString Name;
            if (Obj.IsValid() && Obj->TryGetStringField(TEXT("name"), Name) && Name == TEXT("Frame"))
            {
                Obj->TryGetObjectField(TEXT("brush_info"), Brush);
                break;
            }
        }

        if (TestTrue(TEXT("the Border reports brush_info"), Brush != nullptr && Brush->IsValid()))
        {
            // These are the fields whose absence forced the drop to
            // object_get_property and raw ExportText.
            FString DrawAs;
            TestTrue(TEXT("reports draw_as"), (*Brush)->TryGetStringField(TEXT("draw_as"), DrawAs));
            TestEqual(TEXT("draw_as round-trips as Box"), DrawAs, FString(TEXT("Box")));

            const TArray<TSharedPtr<FJsonValue>>* MarginArr = nullptr;
            if (TestTrue(TEXT("reports margin"), (*Brush)->TryGetArrayField(TEXT("margin"), MarginArr)))
            {
                TestEqual(TEXT("margin has four sides"), MarginArr->Num(), 4);
                TestTrue(TEXT("margin round-trips the value that was set"),
                    FMath::IsNearlyEqual((*MarginArr)[0]->AsNumber(), 0.25, 0.001));
            }

            TestTrue(TEXT("reports has_resource"), (*Brush)->HasField(TEXT("has_resource")));
            TestTrue(TEXT("reports tiling"), (*Brush)->HasField(TEXT("tiling")));
            TestTrue(TEXT("reports the tint"), (*Brush)->HasField(TEXT("tint")));
            // Which property the brush lives on, so ui_copy_style can write to
            // the right one on the target.
            FString BrushProp;
            TestTrue(TEXT("reports brush_property"), (*Brush)->TryGetStringField(TEXT("brush_property"), BrushProp));
            TestEqual(TEXT("a Border's brush is Background"), BrushProp, FString(TEXT("Background")));
        }

        // Production HUDs routinely exceed the transport's 50-item response limit. Targeted
        // reads are what make ui_copy_style reliable for a widget appended near the end.
        TSharedPtr<FJsonObject> FilteredP = MakeShared<FJsonObject>();
        FilteredP->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        TArray<TSharedPtr<FJsonValue>> Names;
        Names.Add(MakeShared<FJsonValueString>(TEXT("Frame")));
        FilteredP->SetArrayField(TEXT("widget_names"), Names);
        const FHaybaHandlerResult Filtered = Handler.Handle(TEXT("ui_layout_snapshot"), FilteredP);
        if (TestTrue(TEXT("targeted layout snapshot succeeds"), Filtered.bOk))
        {
            const TArray<TSharedPtr<FJsonValue>>* FilteredWidgets = nullptr;
            if (TestTrue(TEXT("targeted snapshot returns widgets"),
                Filtered.Data->TryGetArrayField(TEXT("widgets"), FilteredWidgets)))
            {
                TestEqual(TEXT("targeted snapshot returns only the exact widget"), FilteredWidgets->Num(), 1);
                TestEqual(TEXT("targeted widget is Frame"),
                    (*FilteredWidgets)[0]->AsObject()->GetStringField(TEXT("name")), FString(TEXT("Frame")));
            }
            TestTrue(TEXT("targeted response preserves the full-tree count"),
                Filtered.Data->GetIntegerField(TEXT("total_widget_count")) >= 2);
        }

        TSharedPtr<FJsonObject> PageOneP = MakeShared<FJsonObject>();
        PageOneP->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
        PageOneP->SetNumberField(TEXT("offset"), 0);
        PageOneP->SetNumberField(TEXT("limit"), 1);
        const FHaybaHandlerResult PageOne = Handler.Handle(TEXT("ui_layout_snapshot"), PageOneP);
        if (TestTrue(TEXT("first layout page succeeds"), PageOne.bOk))
        {
            const TArray<TSharedPtr<FJsonValue>>& FirstWidgets = PageOne.Data->GetArrayField(TEXT("widgets"));
            TestEqual(TEXT("first layout page obeys its limit"), FirstWidgets.Num(), 1);
            TestTrue(TEXT("first layout page reports remaining widgets"),
                PageOne.Data->GetBoolField(TEXT("has_more")));

            TSharedPtr<FJsonObject> PageTwoP = MakeShared<FJsonObject>();
            PageTwoP->SetStringField(TEXT("widget_blueprint_path"), W.ObjectPath);
            PageTwoP->SetNumberField(TEXT("offset"), PageOne.Data->GetIntegerField(TEXT("next_offset")));
            PageTwoP->SetNumberField(TEXT("limit"), 1);
            const FHaybaHandlerResult PageTwo = Handler.Handle(TEXT("ui_layout_snapshot"), PageTwoP);
            if (TestTrue(TEXT("second layout page succeeds"), PageTwo.bOk))
            {
                const TArray<TSharedPtr<FJsonValue>>& SecondWidgets = PageTwo.Data->GetArrayField(TEXT("widgets"));
                TestEqual(TEXT("second layout page obeys its limit"), SecondWidgets.Num(), 1);
                if (FirstWidgets.Num() == 1 && SecondWidgets.Num() == 1)
                {
                    TestNotEqual(TEXT("pagination advances to a different widget"),
                        FirstWidgets[0]->AsObject()->GetStringField(TEXT("name")),
                        SecondWidgets[0]->AsObject()->GetStringField(TEXT("name")));
                }
            }
        }
    }

    W.Cleanup();
    return true;
}

#endif // WITH_EDITOR
