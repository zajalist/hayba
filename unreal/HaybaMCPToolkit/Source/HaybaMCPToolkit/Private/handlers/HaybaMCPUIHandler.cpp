#include "HaybaMCPUIHandler.h"
#include "Json.h"

#if WITH_EDITOR
#include "WidgetBlueprint.h"
#include "WidgetBlueprintFactory.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Widget.h"
#include "Components/PanelWidget.h"
#include "Components/PanelSlot.h"
#include "Components/CanvasPanel.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/HorizontalBox.h"
#include "Components/VerticalBox.h"
#include "Components/HorizontalBoxSlot.h"
#include "Components/VerticalBoxSlot.h"
#include "Components/Button.h"
#include "Components/TextBlock.h"
#include "Components/Image.h"
#include "Components/Overlay.h"
#include "Components/ScrollBox.h"
#include "Components/Border.h"
#include "Components/GridPanel.h"
#include "Components/UniformGridPanel.h"
#include "Components/SizeBox.h"
#include "Components/Spacer.h"
#include "Components/CheckBox.h"
#include "Components/EditableTextBox.h"
#include "Components/ProgressBar.h"
#include "Components/Slider.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "UObject/Package.h"
#include "Misc/PackageName.h"
#include "Layout/Margin.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPUI, Log, All);

TArray<FString> FHaybaMCPUIHandler::GetCommands() const
{
    return {
        TEXT("ui_create_widget"),
        TEXT("ui_add_element"),
        TEXT("ui_query")
    };
}

#if WITH_EDITOR

namespace
{
    UClass* ResolveWidgetClass(const FString& Name)
    {
        // Try common UMG widget classes by short name first.
        static const TMap<FString, UClass*> Known = []
        {
            TMap<FString, UClass*> M;
            M.Add(TEXT("Button"),           UButton::StaticClass());
            M.Add(TEXT("TextBlock"),        UTextBlock::StaticClass());
            M.Add(TEXT("Image"),            UImage::StaticClass());
            M.Add(TEXT("CanvasPanel"),      UCanvasPanel::StaticClass());
            M.Add(TEXT("HorizontalBox"),    UHorizontalBox::StaticClass());
            M.Add(TEXT("VerticalBox"),      UVerticalBox::StaticClass());
            M.Add(TEXT("Overlay"),          UOverlay::StaticClass());
            M.Add(TEXT("ScrollBox"),        UScrollBox::StaticClass());
            M.Add(TEXT("Border"),           UBorder::StaticClass());
            M.Add(TEXT("GridPanel"),        UGridPanel::StaticClass());
            M.Add(TEXT("UniformGridPanel"), UUniformGridPanel::StaticClass());
            M.Add(TEXT("SizeBox"),          USizeBox::StaticClass());
            M.Add(TEXT("Spacer"),           USpacer::StaticClass());
            M.Add(TEXT("CheckBox"),         UCheckBox::StaticClass());
            M.Add(TEXT("EditableTextBox"),  UEditableTextBox::StaticClass());
            M.Add(TEXT("ProgressBar"),      UProgressBar::StaticClass());
            M.Add(TEXT("Slider"),           USlider::StaticClass());
            return M;
        }();
        if (UClass* const* Found = Known.Find(Name)) return *Found;

        // Allow full class paths / "UMyWidget" / "MyWidget" lookups.
        if (UClass* C = LoadClass<UWidget>(nullptr, *Name)) return C;
        if (UClass* C = FindFirstObjectSafe<UClass>(*Name)) return C;
        if (!Name.StartsWith(TEXT("U")))
        {
            if (UClass* C = FindFirstObjectSafe<UClass>(*(TEXT("U") + Name))) return C;
        }
        return nullptr;
    }

    UWidget* FindWidgetByName(UWidgetTree* Tree, const FString& Name)
    {
        if (!Tree) return nullptr;
        UWidget* Hit = nullptr;
        Tree->ForEachWidget([&](UWidget* W)
        {
            if (Hit) return;
            if (W && W->GetName() == Name) Hit = W;
        });
        return Hit;
    }

    void TrySetByReflection(UObject* Obj, const FString& PropName, const TSharedPtr<FJsonValue>& Val)
    {
        if (!Obj || !Val.IsValid()) return;
        FProperty* Prop = Obj->GetClass()->FindPropertyByName(FName(*PropName));
        if (!Prop) return;
        FString Text;
        switch (Val->Type)
        {
        case EJson::Number:  Text = FString::SanitizeFloat(Val->AsNumber()); break;
        case EJson::Boolean: Text = Val->AsBool() ? TEXT("True") : TEXT("False"); break;
        case EJson::String:  Val->TryGetString(Text); break;
        default: return;
        }
        Prop->ImportText_Direct(*Text, Prop->ContainerPtrToValuePtr<void>(Obj), Obj, PPF_None);
    }

    void ApplySlotProps(UPanelSlot* Slot, const TSharedPtr<FJsonObject>& Props)
    {
        if (!Slot || !Props.IsValid()) return;

        // CanvasPanelSlot — x/y/w/h → Offsets, anchors defaulted to top-left.
        if (UCanvasPanelSlot* CSlot = Cast<UCanvasPanelSlot>(Slot))
        {
            FAnchors Anchors(0.f, 0.f, 0.f, 0.f);
            CSlot->SetAnchors(Anchors);
            FMargin Offsets = CSlot->GetOffsets();
            double X, Y, W, H;
            if (Props->TryGetNumberField(TEXT("x"), X)) Offsets.Left = X;
            if (Props->TryGetNumberField(TEXT("y"), Y)) Offsets.Top  = Y;
            if (Props->TryGetNumberField(TEXT("w"), W)) Offsets.Right  = W;
            if (Props->TryGetNumberField(TEXT("h"), H)) Offsets.Bottom = H;
            CSlot->SetOffsets(Offsets);
            CSlot->SetAutoSize(false);
        }

        // HorizontalBoxSlot / VerticalBoxSlot — fill + padding.
        double Fill = 0.0;
        const bool bHaveFill = Props->TryGetNumberField(TEXT("fill"), Fill);
        double Pad = 0.0;
        const bool bHavePad = Props->TryGetNumberField(TEXT("padding"), Pad);

        if (UHorizontalBoxSlot* HSlot = Cast<UHorizontalBoxSlot>(Slot))
        {
            if (bHaveFill)
            {
                FSlateChildSize Sz;
                Sz.Value = Fill;
                Sz.SizeRule = Fill > 0.0 ? ESlateSizeRule::Fill : ESlateSizeRule::Automatic;
                HSlot->SetSize(Sz);
            }
            if (bHavePad) HSlot->SetPadding(FMargin(Pad));
        }
        else if (UVerticalBoxSlot* VSlot = Cast<UVerticalBoxSlot>(Slot))
        {
            if (bHaveFill)
            {
                FSlateChildSize Sz;
                Sz.Value = Fill;
                Sz.SizeRule = Fill > 0.0 ? ESlateSizeRule::Fill : ESlateSizeRule::Automatic;
                VSlot->SetSize(Sz);
            }
            if (bHavePad) VSlot->SetPadding(FMargin(Pad));
        }

        // Generic reflection fall-through for any other documented slot prop.
        for (const auto& Pair : Props->Values)
        {
            const FString& Key = Pair.Key;
            if (Key == TEXT("x") || Key == TEXT("y") || Key == TEXT("w") || Key == TEXT("h")
                || Key == TEXT("fill") || Key == TEXT("padding")) continue;
            TrySetByReflection(Slot, Key, Pair.Value);
        }
    }

    TSharedPtr<FJsonObject> WidgetToJson(UWidget* W)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        if (!W) return Out;
        Out->SetStringField(TEXT("name"), W->GetName());
        Out->SetStringField(TEXT("class"), W->GetClass()->GetName());

        TSharedPtr<FJsonObject> SlotObj = MakeShared<FJsonObject>();
        if (UPanelSlot* PS = W->Slot)
        {
            SlotObj->SetStringField(TEXT("class"), PS->GetClass()->GetName());
            if (UCanvasPanelSlot* CSlot = Cast<UCanvasPanelSlot>(PS))
            {
                const FMargin Off = CSlot->GetOffsets();
                SlotObj->SetNumberField(TEXT("x"), Off.Left);
                SlotObj->SetNumberField(TEXT("y"), Off.Top);
                SlotObj->SetNumberField(TEXT("w"), Off.Right);
                SlotObj->SetNumberField(TEXT("h"), Off.Bottom);
            }
            else if (UHorizontalBoxSlot* HSlot = Cast<UHorizontalBoxSlot>(PS))
            {
                SlotObj->SetNumberField(TEXT("fill"), HSlot->GetSize().Value);
                SlotObj->SetNumberField(TEXT("padding"), HSlot->GetPadding().Left);
            }
            else if (UVerticalBoxSlot* VSlot = Cast<UVerticalBoxSlot>(PS))
            {
                SlotObj->SetNumberField(TEXT("fill"), VSlot->GetSize().Value);
                SlotObj->SetNumberField(TEXT("padding"), VSlot->GetPadding().Left);
            }
        }
        Out->SetObjectField(TEXT("slot"), SlotObj);

        TArray<TSharedPtr<FJsonValue>> Children;
        if (UPanelWidget* Panel = Cast<UPanelWidget>(W))
        {
            for (int32 i = 0; i < Panel->GetChildrenCount(); ++i)
            {
                UWidget* Child = Panel->GetChildAt(i);
                if (!Child) continue;
                TSharedPtr<FJsonObject> ChildObj = WidgetToJson(Child);
                Children.Add(MakeShared<FJsonValueObject>(ChildObj.ToSharedRef()));
            }
        }
        Out->SetArrayField(TEXT("children"), Children);
        return Out;
    }
}

#endif // WITH_EDITOR

FHaybaHandlerResult FHaybaMCPUIHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
#if !WITH_EDITOR
    return FHaybaHandlerResult::Err(TEXT("UIHandler: editor-only"));
#else
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("UIHandler: missing params"));

    // ----- ui_create_widget --------------------------------------------------
    if (Cmd == TEXT("ui_create_widget"))
    {
        FString PkgPath, AssetName, ParentClassName;
        if (!P->TryGetStringField(TEXT("path"), PkgPath) || PkgPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_create_widget: missing path"));
        if (!P->TryGetStringField(TEXT("name"), AssetName) || AssetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_create_widget: missing name"));
        if (!P->TryGetStringField(TEXT("parent_class"), ParentClassName) || ParentClassName.IsEmpty())
            ParentClassName = TEXT("UserWidget");

        UClass* ParentClass = LoadClass<UUserWidget>(nullptr, *ParentClassName);
        if (!ParentClass) ParentClass = FindFirstObjectSafe<UClass>(*ParentClassName);
        if (!ParentClass && !ParentClassName.StartsWith(TEXT("U")))
            ParentClass = FindFirstObjectSafe<UClass>(*(TEXT("U") + ParentClassName));
        if (!ParentClass) ParentClass = UUserWidget::StaticClass();
        if (!ParentClass->IsChildOf(UUserWidget::StaticClass()))
            return FHaybaHandlerResult::Err(TEXT("ui_create_widget: parent_class must derive from UserWidget"));

        FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
        UWidgetBlueprintFactory* Factory = NewObject<UWidgetBlueprintFactory>();
        Factory->ParentClass = ParentClass;

        UObject* Asset = AssetToolsModule.Get().CreateAsset(AssetName, PkgPath, UWidgetBlueprint::StaticClass(), Factory);
        UWidgetBlueprint* WBP = Cast<UWidgetBlueprint>(Asset);
        if (!WBP)
            return FHaybaHandlerResult::Err(TEXT("ui_create_widget: CreateAsset failed"));

        // Make sure there is a root panel (CanvasPanel) for usability.
        if (WBP->WidgetTree && !WBP->WidgetTree->RootWidget)
        {
            UCanvasPanel* Root = WBP->WidgetTree->ConstructWidget<UCanvasPanel>(UCanvasPanel::StaticClass(), TEXT("RootCanvas"));
            WBP->WidgetTree->RootWidget = Root;
            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        }

        FAssetRegistryModule::AssetCreated(WBP);
        WBP->MarkPackageDirty();

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), WBP->GetPathName());
        Out->SetStringField(TEXT("name"), AssetName);
        Out->SetStringField(TEXT("parent_class"), ParentClass->GetPathName());
        if (WBP->WidgetTree && WBP->WidgetTree->RootWidget)
            Out->SetStringField(TEXT("root"), WBP->WidgetTree->RootWidget->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    // ----- ui_add_element ----------------------------------------------------
    if (Cmd == TEXT("ui_add_element"))
    {
        FString BPPath, ParentName, ChildClassName, ChildName;
        if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_add_element: missing widget_blueprint_path"));
        if (!P->TryGetStringField(TEXT("child_class"), ChildClassName) || ChildClassName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_add_element: missing child_class"));
        P->TryGetStringField(TEXT("parent_widget_name"), ParentName);
        P->TryGetStringField(TEXT("name"), ChildName);

        UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
        if (!WBP || !WBP->WidgetTree)
            return FHaybaHandlerResult::Err(TEXT("ui_add_element: widget blueprint not found"));

        UClass* ChildClass = ResolveWidgetClass(ChildClassName);
        if (!ChildClass || !ChildClass->IsChildOf(UWidget::StaticClass()))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_add_element: unknown child_class '%s'"), *ChildClassName));

        UPanelWidget* Parent = nullptr;
        if (ParentName.IsEmpty())
        {
            Parent = Cast<UPanelWidget>(WBP->WidgetTree->RootWidget);
            if (!Parent)
                return FHaybaHandlerResult::Err(TEXT("ui_add_element: root widget is not a panel; specify parent_widget_name"));
        }
        else
        {
            UWidget* Found = FindWidgetByName(WBP->WidgetTree, ParentName);
            Parent = Cast<UPanelWidget>(Found);
            if (!Parent)
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_add_element: parent '%s' not found or not a panel"), *ParentName));
        }

        const FName ConstructName = ChildName.IsEmpty() ? NAME_None : FName(*ChildName);
        UWidget* NewChild = WBP->WidgetTree->ConstructWidget<UWidget>(ChildClass, ConstructName);
        if (!NewChild)
            return FHaybaHandlerResult::Err(TEXT("ui_add_element: ConstructWidget failed"));

        UPanelSlot* NewSlot = Parent->AddChild(NewChild);
        if (!NewSlot)
            return FHaybaHandlerResult::Err(TEXT("ui_add_element: AddChild rejected (panel may be full or incompatible)"));

        const TSharedPtr<FJsonObject>* SlotProps = nullptr;
        if (P->TryGetObjectField(TEXT("slot_props"), SlotProps) && SlotProps && SlotProps->IsValid())
            ApplySlotProps(NewSlot, *SlotProps);

        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("widget_blueprint_path"), WBP->GetPathName());
        Out->SetStringField(TEXT("parent"), Parent->GetName());
        Out->SetStringField(TEXT("name"),   NewChild->GetName());
        Out->SetStringField(TEXT("class"),  ChildClass->GetName());
        Out->SetStringField(TEXT("slot_class"), NewSlot->GetClass()->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    // ----- ui_query ----------------------------------------------------------
    if (Cmd == TEXT("ui_query"))
    {
        FString BPPath;
        if (!P->TryGetStringField(TEXT("path"), BPPath) || BPPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_query: missing path"));
        UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
        if (!WBP || !WBP->WidgetTree)
            return FHaybaHandlerResult::Err(TEXT("ui_query: widget blueprint not found"));

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), WBP->GetPathName());
        Out->SetStringField(TEXT("parent_class"), WBP->ParentClass ? WBP->ParentClass->GetPathName() : TEXT(""));
        if (UWidget* Root = WBP->WidgetTree->RootWidget)
        {
            Out->SetObjectField(TEXT("root"), WidgetToJson(Root));
        }
        else
        {
            Out->SetObjectField(TEXT("root"), MakeShared<FJsonObject>());
        }
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("UIHandler: unknown command %s"), *Cmd));
#endif
}
