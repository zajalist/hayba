#include "HaybaMCPUIHandler.h"
#include "Json.h"
#include "Editor.h"

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
#include "Components/Overlay.h"
#include "Components/OverlaySlot.h"
#include "Components/ScrollBox.h"
#include "Components/ScrollBoxSlot.h"
#include "Components/Border.h"
#include "Components/BorderSlot.h"
#include "Components/GridPanel.h"
#include "Components/GridSlot.h"
#include "Components/UniformGridPanel.h"
#include "Components/UniformGridSlot.h"
#include "Components/SizeBox.h"
#include "Components/SizeBoxSlot.h"
#include "Components/Button.h"
#include "Components/TextBlock.h"
#include "Components/Image.h"
#include "Components/Spacer.h"
#include "Components/CheckBox.h"
#include "Components/EditableTextBox.h"
#include "Components/ProgressBar.h"
#include "Components/Slider.h"
#include "Components/MultiLineEditableTextBox.h"
#include "Components/Throbber.h"
#include "Components/SpinBox.h"
#include "Components/ComboBoxString.h"
#include "Components/ListView.h"
#include "Components/TreeView.h"
#include "Components/TileView.h"
#include "Components/MenuAnchor.h"
#include "Components/NativeWidgetHost.h"
#include "Components/RetainerBox.h"
#include "Components/ScaleBox.h"
#include "Components/WidgetSwitcher.h"
#include "Components/WidgetSwitcherSlot.h"
#include "Components/WrapBox.h"
#include "Components/WrapBoxSlot.h"
#include "Components/NamedSlot.h"
#include "Components/BackgroundBlur.h"
#include "Components/ExpandableArea.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Logging/TokenizedMessage.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "Misc/PackageName.h"
#include "Layout/Margin.h"
#include "HaybaMCPReflection.h"
#include "HaybaMCPParams.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPUI, Log, All);

TArray<FString> FHaybaMCPUIHandler::GetCommands() const
{
    return {
        TEXT("ui_create_widget"),
        TEXT("ui_add_element"),
        TEXT("ui_set_widget_properties"),
        TEXT("ui_query"),
        TEXT("ui_mutate_tree"),
        TEXT("ui_compile_widget"),
        TEXT("ui_save_widget"),
        TEXT("ui_list_widget_types"),
    };
}

#if WITH_EDITOR

namespace
{
    void RegisterWidgetVariable(UWidgetBlueprint* WidgetBlueprint, UWidget* Widget)
    {
        if (!WidgetBlueprint || !Widget)
        {
            return;
        }

        const FName WidgetName = Widget->GetFName();
        if (!WidgetBlueprint->WidgetVariableNameToGuidMap.Contains(WidgetName))
        {
            WidgetBlueprint->OnVariableAdded(WidgetName);
        }
    }

    UClass* ResolveWidgetClass(const FString& Name)
    {
        static const TMap<FString, UClass*> Known = []
        {
            TMap<FString, UClass*> M;
            M.Add(TEXT("Button"),             UButton::StaticClass());
            M.Add(TEXT("TextBlock"),          UTextBlock::StaticClass());
            M.Add(TEXT("Image"),              UImage::StaticClass());
            M.Add(TEXT("CanvasPanel"),        UCanvasPanel::StaticClass());
            M.Add(TEXT("HorizontalBox"),      UHorizontalBox::StaticClass());
            M.Add(TEXT("VerticalBox"),        UVerticalBox::StaticClass());
            M.Add(TEXT("Overlay"),            UOverlay::StaticClass());
            M.Add(TEXT("ScrollBox"),          UScrollBox::StaticClass());
            M.Add(TEXT("Border"),             UBorder::StaticClass());
            M.Add(TEXT("GridPanel"),          UGridPanel::StaticClass());
            M.Add(TEXT("UniformGridPanel"),   UUniformGridPanel::StaticClass());
            M.Add(TEXT("SizeBox"),            USizeBox::StaticClass());
            M.Add(TEXT("Spacer"),             USpacer::StaticClass());
            M.Add(TEXT("CheckBox"),           UCheckBox::StaticClass());
            M.Add(TEXT("EditableTextBox"),    UEditableTextBox::StaticClass());
            M.Add(TEXT("MultiLineEditableTextBox"), UMultiLineEditableTextBox::StaticClass());
            M.Add(TEXT("ProgressBar"),        UProgressBar::StaticClass());
            M.Add(TEXT("Slider"),             USlider::StaticClass());
            M.Add(TEXT("SpinBox"),            USpinBox::StaticClass());
            M.Add(TEXT("ComboBoxString"),     UComboBoxString::StaticClass());
            M.Add(TEXT("Throbber"),           UThrobber::StaticClass());
            M.Add(TEXT("ListView"),           UListView::StaticClass());
            M.Add(TEXT("TreeView"),           UTreeView::StaticClass());
            M.Add(TEXT("TileView"),           UTileView::StaticClass());
            M.Add(TEXT("WidgetSwitcher"),     UWidgetSwitcher::StaticClass());
            M.Add(TEXT("WrapBox"),            UWrapBox::StaticClass());
            M.Add(TEXT("ScaleBox"),           UScaleBox::StaticClass());
            M.Add(TEXT("RetainerBox"),        URetainerBox::StaticClass());
            M.Add(TEXT("BackgroundBlur"),     UBackgroundBlur::StaticClass());
            M.Add(TEXT("ExpandableArea"),     UExpandableArea::StaticClass());
            M.Add(TEXT("MenuAnchor"),         UMenuAnchor::StaticClass());
            return M;
        }();
        if (UClass* const* Found = Known.Find(Name)) return *Found;

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

    FString ResolveSlotType(UWidget* W)
    {
        if (!W || !W->Slot) return TEXT("None");
        UPanelSlot* S = W->Slot;
        if (Cast<UCanvasPanelSlot>(S))      return TEXT("CanvasPanelSlot");
        if (Cast<UHorizontalBoxSlot>(S))    return TEXT("HorizontalBoxSlot");
        if (Cast<UVerticalBoxSlot>(S))      return TEXT("VerticalBoxSlot");
        if (Cast<UOverlaySlot>(S))          return TEXT("OverlaySlot");
        if (Cast<UGridSlot>(S))             return TEXT("GridSlot");
        if (Cast<UUniformGridSlot>(S))      return TEXT("UniformGridSlot");
        if (Cast<UScrollBoxSlot>(S))        return TEXT("ScrollBoxSlot");
        if (Cast<UBorderSlot>(S))           return TEXT("BorderSlot");
        if (Cast<USizeBoxSlot>(S))          return TEXT("SizeBoxSlot");
        if (Cast<UWidgetSwitcherSlot>(S))   return TEXT("WidgetSwitcherSlot");
        if (Cast<UWrapBoxSlot>(S))          return TEXT("WrapBoxSlot");
        return S->GetClass()->GetName();
    }

    bool ValidateWidgetName(UWidgetTree* Tree, const FString& Name)
    {
        if (!Tree || Name.IsEmpty()) return false;
        UWidget* Existing = nullptr;
        Tree->ForEachWidget([&](UWidget* W)
        {
            if (Existing) return;
            if (W && W->GetName() == Name) Existing = W;
        });
        return Existing == nullptr;
    }

    static EHorizontalAlignment ParseHAlign(const FString& S)
    {
        const FString Low = S.ToLower();
        if (Low == TEXT("fill"))   return HAlign_Fill;
        if (Low == TEXT("left"))   return HAlign_Left;
        if (Low == TEXT("center")) return HAlign_Center;
        if (Low == TEXT("right"))  return HAlign_Right;
        return HAlign_Fill;
    }

    static EVerticalAlignment ParseVAlign(const FString& S)
    {
        const FString Low = S.ToLower();
        if (Low == TEXT("fill"))   return VAlign_Fill;
        if (Low == TEXT("top"))    return VAlign_Top;
        if (Low == TEXT("center")) return VAlign_Center;
        if (Low == TEXT("bottom")) return VAlign_Bottom;
        return VAlign_Fill;
    }

    static FMargin ParseMargin(const TSharedPtr<FJsonObject>& Props, const FString& Key)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (Props->TryGetArrayField(Key, Arr) && Arr && Arr->Num() >= 4)
        {
            return FMargin(
                (float)(*Arr)[0]->AsNumber(),
                (float)(*Arr)[1]->AsNumber(),
                (float)(*Arr)[2]->AsNumber(),
                (float)(*Arr)[3]->AsNumber()
            );
        }
        double Single = 0.0;
        if (Props->TryGetNumberField(Key, Single))
        {
            return FMargin((float)Single);
        }
        // MCP callers naturally send named edges ({left, top, right, bottom});
        // support that form alongside the original positional array.
        const TSharedPtr<FJsonObject>* Obj = nullptr;
        if (Props->TryGetObjectField(Key, Obj) && Obj && Obj->IsValid())
        {
            double Left = 0.0, Top = 0.0, Right = 0.0, Bottom = 0.0;
            (*Obj)->TryGetNumberField(TEXT("left"), Left);
            (*Obj)->TryGetNumberField(TEXT("top"), Top);
            (*Obj)->TryGetNumberField(TEXT("right"), Right);
            (*Obj)->TryGetNumberField(TEXT("bottom"), Bottom);
            return FMargin((float)Left, (float)Top, (float)Right, (float)Bottom);
        }
        return FMargin(0.0f);
    }

    static FVector2D ParseVec2(const TSharedPtr<FJsonObject>& Props, const FString& Key)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (Props->TryGetArrayField(Key, Arr) && Arr && Arr->Num() >= 2)
        {
            return FVector2D(
                (float)(*Arr)[0]->AsNumber(),
                (float)(*Arr)[1]->AsNumber()
            );
        }
        const TSharedPtr<FJsonObject>* Obj = nullptr;
        if (Props->TryGetObjectField(Key, Obj) && Obj && Obj->IsValid())
        {
            double X = 0.0, Y = 0.0;
            (*Obj)->TryGetNumberField(TEXT("x"), X);
            (*Obj)->TryGetNumberField(TEXT("y"), Y);
            return FVector2D((float)X, (float)Y);
        }
        return FVector2D::ZeroVector;
    }

    void ApplySlotProps(UPanelSlot* Slot, const TSharedPtr<FJsonObject>& Props)
    {
        if (!Slot || !Props.IsValid()) return;

        // CanvasPanelSlot
        if (UCanvasPanelSlot* CSlot = Cast<UCanvasPanelSlot>(Slot))
        {
            double AnchorMinX, AnchorMinY, AnchorMaxX, AnchorMaxY;
            if (Props->TryGetNumberField(TEXT("anchor_min_x"), AnchorMinX) ||
                Props->TryGetNumberField(TEXT("anchor_min_y"), AnchorMinY) ||
                Props->TryGetNumberField(TEXT("anchor_max_x"), AnchorMaxX) ||
                Props->TryGetNumberField(TEXT("anchor_max_y"), AnchorMaxY))
            {
                FAnchors Anchors = CSlot->GetAnchors();
                if (Props->TryGetNumberField(TEXT("anchor_min_x"), AnchorMinX)) Anchors.Minimum.X = AnchorMinX;
                if (Props->TryGetNumberField(TEXT("anchor_min_y"), AnchorMinY)) Anchors.Minimum.Y = AnchorMinY;
                if (Props->TryGetNumberField(TEXT("anchor_max_x"), AnchorMaxX)) Anchors.Maximum.X = AnchorMaxX;
                if (Props->TryGetNumberField(TEXT("anchor_max_y"), AnchorMaxY)) Anchors.Maximum.Y = AnchorMaxY;
                CSlot->SetAnchors(Anchors);
            }
            const TSharedPtr<FJsonObject>* AnchorsObj = nullptr;
            if (Props->TryGetObjectField(TEXT("anchors"), AnchorsObj) && AnchorsObj && AnchorsObj->IsValid())
            {
                FAnchors A;
                double MinX = 0.0, MinY = 0.0, MaxX = 0.0, MaxY = 0.0;
                (*AnchorsObj)->TryGetNumberField(TEXT("min_x"), MinX);
                (*AnchorsObj)->TryGetNumberField(TEXT("min_y"), MinY);
                (*AnchorsObj)->TryGetNumberField(TEXT("max_x"), MaxX);
                (*AnchorsObj)->TryGetNumberField(TEXT("max_y"), MaxY);
                A.Minimum = FVector2D(MinX, MinY);
                A.Maximum = FVector2D(MaxX, MaxY);
                CSlot->SetAnchors(A);
            }

            double OffX, OffY, OffW, OffH;
            const bool bHasOffX = Props->TryGetNumberField(TEXT("x"), OffX);
            const bool bHasOffY = Props->TryGetNumberField(TEXT("y"), OffY);
            const bool bHasOffW = Props->TryGetNumberField(TEXT("w"), OffW);
            const bool bHasOffH = Props->TryGetNumberField(TEXT("h"), OffH);
            if (bHasOffX || bHasOffY || bHasOffW || bHasOffH)
            {
                FMargin Offsets = CSlot->GetOffsets();
                if (bHasOffX) Offsets.Left   = OffX;
                if (bHasOffY) Offsets.Top    = OffY;
                if (bHasOffW) Offsets.Right  = OffW;
                if (bHasOffH) Offsets.Bottom = OffH;
                CSlot->SetOffsets(Offsets);
            }

            FVector2D Position = ParseVec2(Props, TEXT("position"));
            if (!Position.IsZero() || Props->HasField(TEXT("position")))
                CSlot->SetPosition(Position);

            FVector2D Size = ParseVec2(Props, TEXT("size"));
            if (!Size.IsZero() || Props->HasField(TEXT("size")))
                CSlot->SetSize(Size);

            FVector2D Alignment = ParseVec2(Props, TEXT("alignment"));
            if (!Alignment.IsZero() || Props->HasField(TEXT("alignment")))
                CSlot->SetAlignment(Alignment);

            bool bAutoSize = false;
            if (Props->TryGetBoolField(TEXT("auto_size"), bAutoSize))
                CSlot->SetAutoSize(bAutoSize);

            int32 ZOrder = 0;
            if (Props->TryGetNumberField(TEXT("z_order"), ZOrder))
                CSlot->SetZOrder(ZOrder);
        }

        // HorizontalBoxSlot
        if (UHorizontalBoxSlot* HSlot = Cast<UHorizontalBoxSlot>(Slot))
        {
            double Fill = 0.0;
            if (Props->TryGetNumberField(TEXT("fill"), Fill))
            {
                FSlateChildSize Sz;
                Sz.Value = (float)Fill;
                Sz.SizeRule = Fill > 0.0 ? ESlateSizeRule::Fill : ESlateSizeRule::Automatic;
                HSlot->SetSize(Sz);
            }
            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                HSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                HSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                HSlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }

        // VerticalBoxSlot
        if (UVerticalBoxSlot* VSlot = Cast<UVerticalBoxSlot>(Slot))
        {
            double Fill = 0.0;
            if (Props->TryGetNumberField(TEXT("fill"), Fill))
            {
                FSlateChildSize Sz;
                Sz.Value = (float)Fill;
                Sz.SizeRule = Fill > 0.0 ? ESlateSizeRule::Fill : ESlateSizeRule::Automatic;
                VSlot->SetSize(Sz);
            }
            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                VSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                VSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                VSlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }

        // OverlaySlot
        if (UOverlaySlot* OSlot = Cast<UOverlaySlot>(Slot))
        {
            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                OSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                OSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                OSlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }

        // GridSlot
        if (UGridSlot* GSlot = Cast<UGridSlot>(Slot))
        {
            int32 Row, Column, RowSpan, ColSpan, Layer;
            if (Props->TryGetNumberField(TEXT("row"), Row))      GSlot->SetRow(Row);
            if (Props->TryGetNumberField(TEXT("column"), Column)) GSlot->SetColumn(Column);
            if (Props->TryGetNumberField(TEXT("row_span"), RowSpan))  GSlot->SetRowSpan(RowSpan);
            if (Props->TryGetNumberField(TEXT("column_span"), ColSpan)) GSlot->SetColumnSpan(ColSpan);
            if (Props->TryGetNumberField(TEXT("layer"), Layer))   GSlot->SetLayer(Layer);

            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                GSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                GSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                GSlot->SetVerticalAlignment(ParseVAlign(VAlign));

            FVector2D Nudge = ParseVec2(Props, TEXT("nudge"));
            if (!Nudge.IsZero() || Props->HasField(TEXT("nudge")))
                GSlot->SetNudge(Nudge);
        }

        // UniformGridSlot
        if (UUniformGridSlot* USlot = Cast<UUniformGridSlot>(Slot))
        {
            int32 Row, Column;
            if (Props->TryGetNumberField(TEXT("row"), Row))      USlot->SetRow(Row);
            if (Props->TryGetNumberField(TEXT("column"), Column)) USlot->SetColumn(Column);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                USlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                USlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }

        // ScrollBoxSlot
        if (UScrollBoxSlot* ScSlot = Cast<UScrollBoxSlot>(Slot))
        {
            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                ScSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                ScSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                ScSlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }

        // BorderSlot
        if (UBorderSlot* BSlot = Cast<UBorderSlot>(Slot))
        {
            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                BSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                BSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                BSlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }

        // SizeBoxSlot
        if (USizeBoxSlot* SbSlot = Cast<USizeBoxSlot>(Slot))
        {
            const FMargin Pad = ParseMargin(Props, TEXT("padding"));
            if (Pad.Left != 0.0 || Pad.Top != 0.0 || Pad.Right != 0.0 || Pad.Bottom != 0.0)
                SbSlot->SetPadding(Pad);

            FString HAlign, VAlign;
            if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
                SbSlot->SetHorizontalAlignment(ParseHAlign(HAlign));
            if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
                SbSlot->SetVerticalAlignment(ParseVAlign(VAlign));
        }
    }

    TSharedPtr<FJsonObject> ExtractWidgetProperties(UWidget* W)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        if (!W) return Out;

        // Visibility
        Out->SetStringField(TEXT("visibility"), UEnum::GetValueAsString(W->GetVisibility()));
        Out->SetNumberField(TEXT("render_opacity"), W->GetRenderOpacity());
        Out->SetBoolField(TEXT("is_enabled"), W->GetIsEnabled());
        Out->SetStringField(TEXT("tool_tip_text"), W->GetToolTipText().ToString());

        // TextBlock
        if (UTextBlock* TB = Cast<UTextBlock>(W))
        {
            Out->SetStringField(TEXT("text"), TB->GetText().ToString());
            const FSlateFontInfo& Font = TB->GetFont();
            TSharedPtr<FJsonObject> FontObj = MakeShared<FJsonObject>();
            FontObj->SetNumberField(TEXT("size"), Font.Size);
            FontObj->SetStringField(TEXT("typeface_font_name"), Font.TypefaceFontName.ToString());
            if (Font.FontObject)
                FontObj->SetStringField(TEXT("font_object"), Font.FontObject->GetPathName());
            Out->SetObjectField(TEXT("font"), FontObj);

            if (FByteProperty* JustificationProperty = CastField<FByteProperty>(TB->GetClass()->FindPropertyByName(TEXT("Justification"))))
            {
                if (JustificationProperty->Enum)
                {
                    const uint8 Value = JustificationProperty->GetPropertyValue_InContainer(TB);
                    Out->SetStringField(TEXT("justification"), JustificationProperty->Enum->GetNameStringByValue(Value));
                }
            }
        }

        // EditableTextBox
        if (UEditableTextBox* ETB = Cast<UEditableTextBox>(W))
        {
            Out->SetStringField(TEXT("text"), ETB->GetText().ToString());
            Out->SetStringField(TEXT("hint_text"), ETB->GetHintText().ToString());
        }

        // MultiLineEditableTextBox
        if (UMultiLineEditableTextBox* MLTB = Cast<UMultiLineEditableTextBox>(W))
        {
            Out->SetStringField(TEXT("text"), MLTB->GetText().ToString());
        }

        // Button
        if (UButton* Btn = Cast<UButton>(W))
        {
            if (Btn->GetChildrenCount() > 0)
            {
                if (UTextBlock* ChildText = Cast<UTextBlock>(Btn->GetChildAt(0)))
                    Out->SetStringField(TEXT("text"), ChildText->GetText().ToString());
            }
        }

        // Image
        if (UImage* Img = Cast<UImage>(W))
        {
            const FLinearColor Color = Img->GetColorAndOpacity();
            TArray<TSharedPtr<FJsonValue>> ColorArr;
            ColorArr.Add(MakeShared<FJsonValueNumber>(Color.R));
            ColorArr.Add(MakeShared<FJsonValueNumber>(Color.G));
            ColorArr.Add(MakeShared<FJsonValueNumber>(Color.B));
            ColorArr.Add(MakeShared<FJsonValueNumber>(Color.A));
            Out->SetArrayField(TEXT("color_and_opacity"), ColorArr);
        }

        // ProgressBar
        if (UProgressBar* PB = Cast<UProgressBar>(W))
        {
            Out->SetNumberField(TEXT("percent"), PB->GetPercent());
        }

        // Slider
        if (USlider* Sld = Cast<USlider>(W))
        {
            Out->SetNumberField(TEXT("value"), Sld->GetValue());
            Out->SetNumberField(TEXT("min_value"), Sld->GetMinValue());
            Out->SetNumberField(TEXT("max_value"), Sld->GetMaxValue());
        }

        // CheckBox
        if (UCheckBox* CB = Cast<UCheckBox>(W))
        {
            Out->SetBoolField(TEXT("is_checked"), CB->IsChecked());
        }

        // SpinBox
        if (USpinBox* SB = Cast<USpinBox>(W))
        {
            Out->SetNumberField(TEXT("value"), SB->GetValue());
            Out->SetNumberField(TEXT("min_value"), SB->GetMinValue());
            Out->SetNumberField(TEXT("max_value"), SB->GetMaxValue());
            Out->SetNumberField(TEXT("delta"), SB->GetDelta());
        }

        return Out;
    }

    void WidgetToJsonRecursive(UWidget* W, UWidgetBlueprint* WBP, TSharedPtr<FJsonObject>& Out,
        bool bIncludeSlot, bool bIncludeGuid, bool bIncludeProperties)
    {
        if (!W) return;
        Out->SetStringField(TEXT("name"), W->GetName());
        Out->SetStringField(TEXT("class"), W->GetClass()->GetName());

        if (bIncludeGuid && WBP)
        {
            const FGuid* Found = WBP->WidgetVariableNameToGuidMap.Find(W->GetFName());
            if (Found && Found->IsValid())
            {
                Out->SetStringField(TEXT("guid"), Found->ToString());
            }
        }

        if (bIncludeSlot && W->Slot)
        {
            TSharedPtr<FJsonObject> SlotObj = MakeShared<FJsonObject>();
            SlotObj->SetStringField(TEXT("class"), ResolveSlotType(W));
            UCanvasPanelSlot* CSlot = Cast<UCanvasPanelSlot>(W->Slot);
            if (CSlot)
            {
                const FMargin Off = CSlot->GetOffsets();
                SlotObj->SetNumberField(TEXT("x"), Off.Left);
                SlotObj->SetNumberField(TEXT("y"), Off.Top);
                SlotObj->SetNumberField(TEXT("w"), Off.Right);
                SlotObj->SetNumberField(TEXT("h"), Off.Bottom);
                const FAnchors Anch = CSlot->GetAnchors();
                TSharedPtr<FJsonObject> AnchObj = MakeShared<FJsonObject>();
                AnchObj->SetNumberField(TEXT("min_x"), Anch.Minimum.X);
                AnchObj->SetNumberField(TEXT("min_y"), Anch.Minimum.Y);
                AnchObj->SetNumberField(TEXT("max_x"), Anch.Maximum.X);
                AnchObj->SetNumberField(TEXT("max_y"), Anch.Maximum.Y);
                SlotObj->SetObjectField(TEXT("anchors"), AnchObj);
                const FVector2D Pos = CSlot->GetPosition();
                SlotObj->SetNumberField(TEXT("position_x"), Pos.X);
                SlotObj->SetNumberField(TEXT("position_y"), Pos.Y);
                const FVector2D Sz = CSlot->GetSize();
                SlotObj->SetNumberField(TEXT("size_width"), Sz.X);
                SlotObj->SetNumberField(TEXT("size_height"), Sz.Y);
                const FVector2D Align = CSlot->GetAlignment();
                SlotObj->SetNumberField(TEXT("alignment_x"), Align.X);
                SlotObj->SetNumberField(TEXT("alignment_y"), Align.Y);
                SlotObj->SetNumberField(TEXT("z_order"), CSlot->GetZOrder());
            }
            else if (UHorizontalBoxSlot* HSlot = Cast<UHorizontalBoxSlot>(W->Slot))
            {
                SlotObj->SetNumberField(TEXT("fill"), HSlot->GetSize().Value);
                const FMargin P = HSlot->GetPadding();
                SlotObj->SetNumberField(TEXT("padding_left"), P.Left);
                SlotObj->SetNumberField(TEXT("padding_top"), P.Top);
                SlotObj->SetNumberField(TEXT("padding_right"), P.Right);
                SlotObj->SetNumberField(TEXT("padding_bottom"), P.Bottom);
            }
            else if (UVerticalBoxSlot* VSlot = Cast<UVerticalBoxSlot>(W->Slot))
            {
                SlotObj->SetNumberField(TEXT("fill"), VSlot->GetSize().Value);
                const FMargin P = VSlot->GetPadding();
                SlotObj->SetNumberField(TEXT("padding_left"), P.Left);
                SlotObj->SetNumberField(TEXT("padding_top"), P.Top);
                SlotObj->SetNumberField(TEXT("padding_right"), P.Right);
                SlotObj->SetNumberField(TEXT("padding_bottom"), P.Bottom);
            }
            else if (UScrollBoxSlot* ScSlot = Cast<UScrollBoxSlot>(W->Slot))
            {
                const FMargin P = ScSlot->GetPadding();
                SlotObj->SetNumberField(TEXT("padding_left"), P.Left);
                SlotObj->SetNumberField(TEXT("padding_top"), P.Top);
                SlotObj->SetNumberField(TEXT("padding_right"), P.Right);
                SlotObj->SetNumberField(TEXT("padding_bottom"), P.Bottom);
            }
            else if (UGridSlot* GSlot = Cast<UGridSlot>(W->Slot))
            {
                SlotObj->SetNumberField(TEXT("row"), GSlot->GetRow());
                SlotObj->SetNumberField(TEXT("column"), GSlot->GetColumn());
                SlotObj->SetNumberField(TEXT("row_span"), GSlot->GetRowSpan());
                SlotObj->SetNumberField(TEXT("column_span"), GSlot->GetColumnSpan());
            }
            Out->SetObjectField(TEXT("slot"), SlotObj);
        }

        if (bIncludeProperties)
        {
            Out->SetObjectField(TEXT("properties"), ExtractWidgetProperties(W));
        }

        if (UPanelWidget* Panel = Cast<UPanelWidget>(W))
        {
            TArray<TSharedPtr<FJsonValue>> Children;
            for (int32 i = 0; i < Panel->GetChildrenCount(); ++i)
            {
                UWidget* Child = Panel->GetChildAt(i);
                if (!Child) continue;
                TSharedPtr<FJsonObject> ChildObj = MakeShared<FJsonObject>();
                WidgetToJsonRecursive(Child, WBP, ChildObj, bIncludeSlot, bIncludeGuid, bIncludeProperties);
                Children.Add(MakeShared<FJsonValueObject>(ChildObj.ToSharedRef()));
            }
            Out->SetArrayField(TEXT("children"), Children);
        }
    }

    struct FCompileResult
    {
        bool bSuccess = false;
        FString Status;
        TArray<FString> Warnings;
        TArray<FString> Errors;
    };

    FCompileResult CompileWidgetBlueprint(UWidgetBlueprint* WBP)
    {
        FCompileResult R;
        if (!WBP) { R.Status = TEXT("NoBP"); return R; }

        FCompilerResultsLog ResultsLog;
        ResultsLog.SetSourcePath(WBP->GetPathName());
        ResultsLog.BeginEvent(TEXT("Compile"));
        FKismetEditorUtilities::CompileBlueprint(WBP, EBlueprintCompileOptions::None, &ResultsLog);
        ResultsLog.EndEvent();

        for (const TSharedRef<FTokenizedMessage>& Msg : ResultsLog.Messages)
        {
            const EMessageSeverity::Type Sev = Msg->GetSeverity();
            const FString Text = Msg->ToText().ToString();
            if (Sev == EMessageSeverity::Error)
                R.Errors.Add(Text);
            else if (Sev == EMessageSeverity::Warning)
                R.Warnings.Add(Text);
        }

        R.bSuccess = (WBP->Status == BS_UpToDate || WBP->Status == BS_UpToDateWithWarnings);

        if (WBP->Status == BS_UpToDate)               R.Status = TEXT("UpToDate");
        else if (WBP->Status == BS_UpToDateWithWarnings) R.Status = TEXT("UpToDateWithWarnings");
        else if (WBP->Status == BS_Error)              R.Status = TEXT("Error");
        else if (WBP->Status == BS_Dirty)              R.Status = TEXT("Dirty");
        else                                           R.Status = TEXT("Unknown");

        return R;
    }

    bool SaveWidgetPackage(UWidgetBlueprint* WBP)
    {
        if (!WBP) return false;
        WBP->MarkPackageDirty();
        UPackage* Pkg = WBP->GetOutermost();
        if (!Pkg) return false;

        const FString FileName = FPackageName::LongPackageNameToFilename(
            Pkg->GetName(), FPackageName::GetAssetPackageExtension());

        FSavePackageArgs Args;
        Args.TopLevelFlags = RF_Public | RF_Standalone;
        Args.SaveFlags = SAVE_NoError;
        return UPackage::SavePackage(Pkg, WBP, *FileName, Args);
    }
}

#endif // WITH_EDITOR

FHaybaHandlerResult FHaybaMCPUIHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
#if !WITH_EDITOR
    return FHaybaHandlerResult::Err(TEXT("UIHandler: editor-only"));
#else
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("UIHandler: missing params"));

    if (Cmd == TEXT("ui_create_widget"))       return HandleCreateWidget(P);
    if (Cmd == TEXT("ui_add_element"))         return HandleAddElement(P);
    if (Cmd == TEXT("ui_set_widget_properties")) return HandleSetProperties(P);
    if (Cmd == TEXT("ui_query"))               return HandleQuery(P);
    if (Cmd == TEXT("ui_mutate_tree"))         return HandleMutateTree(P);
    if (Cmd == TEXT("ui_compile_widget"))      return HandleCompile(P);
    if (Cmd == TEXT("ui_save_widget"))         return HandleSave(P);
    if (Cmd == TEXT("ui_list_widget_types"))   return HandleListTypes(P);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("UIHandler: unknown command %s"), *Cmd));
#endif
}

#if WITH_EDITOR

FHaybaHandlerResult FHaybaMCPUIHandler::HandleCreateWidget(const TSharedPtr<FJsonObject>& P)
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

    if (WBP->WidgetTree && !WBP->WidgetTree->RootWidget)
    {
        UCanvasPanel* Root = WBP->WidgetTree->ConstructWidget<UCanvasPanel>(UCanvasPanel::StaticClass(), TEXT("RootCanvas"));
        WBP->WidgetTree->RootWidget = Root;
        RegisterWidgetVariable(WBP, Root);
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

FHaybaHandlerResult FHaybaMCPUIHandler::HandleAddElement(const TSharedPtr<FJsonObject>& P)
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

    RegisterWidgetVariable(WBP, NewChild);

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

FHaybaHandlerResult FHaybaMCPUIHandler::HandleSetProperties(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath, WidgetName;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: missing widget_blueprint_path"));
    if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: missing widget_name"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: widget blueprint not found"));

    UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
    if (!Widget)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_set_widget_properties: widget '%s' not found"), *WidgetName));

    const TSharedPtr<FJsonObject>* Props = nullptr;
    const TSharedPtr<FJsonObject>* SlotProps = nullptr;
    P->TryGetObjectField(TEXT("properties"), Props);
    // Public MCP schema has always documented `slot_props`, while an earlier
    // handler revision only read `slot_properties`.  Accept both spellings so
    // typed UMG calls actually persist margins/layout rather than silently
    // reporting success for unrelated widget properties.
    if (!(P->TryGetObjectField(TEXT("slot_props"), SlotProps) && SlotProps && SlotProps->IsValid()))
    {
        P->TryGetObjectField(TEXT("slot_properties"), SlotProps);
    }

    if ((!Props || !Props->IsValid()) && (!SlotProps || !SlotProps->IsValid()))
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: no properties or slot_props provided"));

    int32 Succeeded = 0;
    int32 Failed = 0;
    TArray<FString> FailedProps;
    {
        FScopedTransaction Transaction(NSLOCTEXT("HaybaMCPUI", "SetWidgetProperties", "Set Widget Properties"));

        WBP->Modify();
        Widget->Modify();

        if (Props && Props->IsValid())
        {
            for (const auto& Pair : (*Props)->Values)
            {
                const FString PropertyName(Pair.Key);
                if (HaybaReflection::SetProp(Widget, PropertyName, Pair.Value))
                    ++Succeeded;
                else
                {
                    ++Failed;
                    FailedProps.Add(PropertyName);
                }
            }
        }

        if (SlotProps && SlotProps->IsValid() && Widget->Slot)
        {
            // Slots are distinct UObject instances in a WidgetTree.  Marking
            // only the child widget dirty made horizontal/vertical padding look
            // successful in the response but vanish on the next query/reopen.
            Widget->Slot->Modify();
            ApplySlotProps(Widget->Slot, *SlotProps);
            Widget->Slot->PostEditChange();
            for (const auto& Pair : (*SlotProps)->Values)
            {
                ++Succeeded;
            }
        }

        Widget->PostEditChange();
        // Designer-slot layout is serialized as part of the WidgetTree, so use
        // a structural notification rather than a mere generated-class refresh.
        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("succeeded"), Succeeded);
    Out->SetNumberField(TEXT("failed"), Failed);
    if (FailedProps.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> FArr;
        for (const FString& F : FailedProps)
            FArr.Add(MakeShared<FJsonValueString>(F));
        Out->SetArrayField(TEXT("failed_properties"), FArr);
    }

    if (Succeeded == 0)
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: all properties failed"));

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleQuery(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath;
    if (!P->TryGetStringField(TEXT("path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_query: missing path"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_query: widget blueprint not found"));

    bool bIncludeSlot = true;
    bool bIncludeGuid = false;
    bool bIncludeProperties = false;
    P->TryGetBoolField(TEXT("include_slot"), bIncludeSlot);
    P->TryGetBoolField(TEXT("include_guid"), bIncludeGuid);
    P->TryGetBoolField(TEXT("include_properties"), bIncludeProperties);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), WBP->GetPathName());
    Out->SetStringField(TEXT("parent_class"), WBP->ParentClass ? WBP->ParentClass->GetPathName() : TEXT(""));

    if (UWidget* Root = WBP->WidgetTree->RootWidget)
    {
        TSharedPtr<FJsonObject> RootObj = MakeShared<FJsonObject>();
        WidgetToJsonRecursive(Root, WBP, RootObj, bIncludeSlot, bIncludeGuid, bIncludeProperties);
        Out->SetObjectField(TEXT("root"), RootObj);
    }
    else
    {
        Out->SetObjectField(TEXT("root"), MakeShared<FJsonObject>());
    }

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleMutateTree(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath, Operation;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree: missing widget_blueprint_path"));
    if (!P->TryGetStringField(TEXT("operation"), Operation) || Operation.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree: missing operation"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree: widget blueprint not found"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_blueprint_path"), WBP->GetPathName());
    Out->SetStringField(TEXT("operation"), Operation);

    if (Operation == TEXT("remove"))
    {
        FString WidgetName, ReplacementRoot;
        if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree remove: missing widget_name"));

        UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Widget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree remove: widget '%s' not found"), *WidgetName));

        P->TryGetStringField(TEXT("replacement_root"), ReplacementRoot);

        FString OldParentName;
        int32 OldChildIndex = -1;

        {
            FScopedTransaction Transaction(NSLOCTEXT("HaybaMCPUI", "MutateTreeRemove", "Remove Widget"));
            WBP->Modify();
            Widget->Modify();

            if (Widget == WBP->WidgetTree->RootWidget)
            {
                OldParentName = TEXT("(root)");

                if (!ReplacementRoot.IsEmpty())
                {
                    UClass* NewRootClass = ResolveWidgetClass(ReplacementRoot);
                    if (!NewRootClass || !NewRootClass->IsChildOf(UWidget::StaticClass()))
                        return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree remove: invalid replacement_root class"));

                    UWidget* NewRoot = WBP->WidgetTree->ConstructWidget<UWidget>(NewRootClass);
                    WBP->WidgetTree->RootWidget = NewRoot;
                    RegisterWidgetVariable(WBP, NewRoot);
                }
                else
                {
                    WBP->WidgetTree->RootWidget = nullptr;
                }
            }
            else
            {
                UPanelWidget* Parent = Widget->GetParent();
                if (Parent)
                {
                    OldParentName = Parent->GetName();
                    OldChildIndex = Parent->GetChildIndex(Widget);
                    Parent->RemoveChild(Widget);
                }
            }

            WBP->WidgetVariableNameToGuidMap.Remove(Widget->GetFName());
            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
            WBP->MarkPackageDirty();
        }

        Out->SetStringField(TEXT("widget_name"), WidgetName);
        Out->SetStringField(TEXT("old_parent"), OldParentName);
        if (OldChildIndex >= 0)
            Out->SetNumberField(TEXT("old_child_index"), OldChildIndex);

        return FHaybaHandlerResult::Ok(Out);
    }
    else if (Operation == TEXT("reparent"))
    {
        FString WidgetName, NewParentName;
        if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree reparent: missing widget_name"));
        if (!P->TryGetStringField(TEXT("new_parent_name"), NewParentName) || NewParentName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree reparent: missing new_parent_name"));

        UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Widget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree reparent: widget '%s' not found"), *WidgetName));

        UWidget* NewParentWidget = FindWidgetByName(WBP->WidgetTree, NewParentName);
        if (!NewParentWidget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree reparent: new parent '%s' not found"), *NewParentName));

        UPanelWidget* NewParent = Cast<UPanelWidget>(NewParentWidget);
        if (!NewParent)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree reparent: '%s' is not a panel"), *NewParentName));

        UPanelWidget* OldParent = Widget->GetParent();
        if (!OldParent)
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree reparent: widget has no parent (root)"));

        // Validate no cycles
        UWidget* Ancestor = NewParent;
        while (Ancestor)
        {
            if (Ancestor == Widget)
                return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree reparent: cannot reparent a widget to its own descendant"));
            Ancestor = Ancestor->GetParent();
        }

        int32 OldIndex = OldParent->GetChildIndex(Widget);
        FString OldParentName = OldParent->GetName();

        {
            FScopedTransaction Transaction(NSLOCTEXT("HaybaMCPUI", "MutateTreeReparent", "Reparent Widget"));
            WBP->Modify();
            Widget->Modify();
            OldParent->Modify();
            NewParent->Modify();

            OldParent->RemoveChild(Widget);
            UPanelSlot* NewSlot = NewParent->AddChild(Widget);

            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
            WBP->MarkPackageDirty();
        }

        Out->SetStringField(TEXT("widget_name"), WidgetName);
        Out->SetStringField(TEXT("old_parent"), OldParentName);
        Out->SetNumberField(TEXT("old_child_index"), OldIndex);
        Out->SetStringField(TEXT("new_parent"), NewParentName);

        return FHaybaHandlerResult::Ok(Out);
    }
    else if (Operation == TEXT("replace"))
    {
        FString WidgetName, NewClassName, NewName;
        if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: missing widget_name"));
        if (!P->TryGetStringField(TEXT("new_class"), NewClassName) || NewClassName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: missing new_class"));

        bool bPreserveGuid = true;
        bool bPreserveProperties = false;
        P->TryGetBoolField(TEXT("preserve_guid"), bPreserveGuid);
        P->TryGetBoolField(TEXT("preserve_properties"), bPreserveProperties);
        P->TryGetStringField(TEXT("new_name"), NewName);

        UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Widget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree replace: widget '%s' not found"), *WidgetName));

        UClass* NewClass = ResolveWidgetClass(NewClassName);
        if (!NewClass || !NewClass->IsChildOf(UWidget::StaticClass()))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree replace: unknown class '%s'"), *NewClassName));

        UPanelWidget* Parent = Widget->GetParent();
        if (!Parent)
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: cannot replace root widget"));

        int32 ChildIndex = Parent->GetChildIndex(Widget);
        FString OldClass = Widget->GetClass()->GetName();

        {
            FScopedTransaction Transaction(NSLOCTEXT("HaybaMCPUI", "MutateTreeReplace", "Replace Widget"));
            WBP->Modify();
            Widget->Modify();
            Parent->Modify();

            const FName ConstructName = NewName.IsEmpty() ? Widget->GetFName() : FName(*NewName);
            UWidget* NewWidget = WBP->WidgetTree->ConstructWidget<UWidget>(NewClass, ConstructName);
            if (!NewWidget)
                return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: ConstructWidget failed"));

            UPanelSlot* NewSlot = Parent->InsertChildAt(ChildIndex, NewWidget);
            if (!NewSlot)
                return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: InsertChildAt failed"));

            Parent->RemoveChild(Widget);

            if (bPreserveGuid)
            {
                const FName OldName = Widget->GetFName();
                FGuid OldGuid;
                if (WBP->WidgetVariableNameToGuidMap.RemoveAndCopyValue(OldName, OldGuid))
                {
                    if (!WBP->WidgetVariableNameToGuidMap.Contains(ConstructName))
                        WBP->WidgetVariableNameToGuidMap.Add(ConstructName, OldGuid);
                }
            }
            else
            {
                WBP->WidgetVariableNameToGuidMap.Remove(Widget->GetFName());
                RegisterWidgetVariable(WBP, NewWidget);
            }

            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
            WBP->MarkPackageDirty();
        }

        Out->SetStringField(TEXT("widget_name"), WidgetName);
        Out->SetStringField(TEXT("old_class"), OldClass);
        Out->SetStringField(TEXT("new_class"), NewClassName);
        Out->SetStringField(TEXT("new_name"), NewName.IsEmpty() ? WidgetName : NewName);
        Out->SetNumberField(TEXT("child_index"), ChildIndex);

        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree: unknown operation '%s'"), *Operation));
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleCompile(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_compile_widget: missing widget_blueprint_path"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP)
        return FHaybaHandlerResult::Err(TEXT("ui_compile_widget: widget blueprint not found"));

    FCompileResult CR = CompileWidgetBlueprint(WBP);

    bool bSaveOnSuccess = false;
    P->TryGetBoolField(TEXT("save_on_success"), bSaveOnSuccess);

    if (bSaveOnSuccess && CR.bSuccess)
    {
        if (!SaveWidgetPackage(WBP))
        {
            return FHaybaHandlerResult::Err(TEXT("ui_compile_widget: compile succeeded but save failed"));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("success"), CR.bSuccess);
    Out->SetStringField(TEXT("status"), CR.Status);

    if (CR.Warnings.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> WArr;
        for (const FString& W : CR.Warnings)
            WArr.Add(MakeShared<FJsonValueString>(W));
        Out->SetArrayField(TEXT("warnings"), WArr);
    }
    else
    {
        Out->SetArrayField(TEXT("warnings"), TArray<TSharedPtr<FJsonValue>>());
    }

    if (CR.Errors.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> EArr;
        for (const FString& E : CR.Errors)
            EArr.Add(MakeShared<FJsonValueString>(E));
        Out->SetArrayField(TEXT("errors"), EArr);
    }
    else
    {
        Out->SetArrayField(TEXT("errors"), TArray<TSharedPtr<FJsonValue>>());
    }

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleSave(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_save_widget: missing widget_blueprint_path"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP)
        return FHaybaHandlerResult::Err(TEXT("ui_save_widget: widget blueprint not found"));

    bool bCompileFirst = false;
    P->TryGetBoolField(TEXT("compile_first"), bCompileFirst);

    if (bCompileFirst)
    {
        FCompileResult CR = CompileWidgetBlueprint(WBP);
        if (!CR.bSuccess)
        {
            TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
            Out->SetBoolField(TEXT("success"), false);
            Out->SetStringField(TEXT("saved_path"), WBP->GetPathName());
            Out->SetStringField(TEXT("reason"), TEXT("compile_failed"));
            return FHaybaHandlerResult::Ok(Out);
        }
    }

    if (!SaveWidgetPackage(WBP))
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_save_widget: SavePackage failed for %s"), *WBP->GetPathName()));
    }

    UPackage* Pkg = WBP->GetOutermost();
    const bool bDirtyAfter = Pkg ? Pkg->IsDirty() : true;

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("saved_path"), WBP->GetPathName());
    Out->SetBoolField(TEXT("success"), !bDirtyAfter);
    Out->SetBoolField(TEXT("package_dirty_after_save"), bDirtyAfter);

    if (bDirtyAfter)
    {
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleListTypes(const TSharedPtr<FJsonObject>& P)
{
    FString Filter;
    P->TryGetStringField(TEXT("filter"), Filter);

    TArray<TSharedPtr<FJsonValue>> Results;

    for (TObjectIterator<UClass> It; It; ++It)
    {
        UClass* C = *It;
        if (!C->IsChildOf(UWidget::StaticClass())) continue;
        if (C == UWidget::StaticClass()) continue;
        if (C->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists)) continue;
        if (!C->IsNative()) continue;

        const FString Name = C->GetName();
        if (!Filter.IsEmpty() && !Name.Contains(Filter)) continue;

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Name);
        Entry->SetStringField(TEXT("class_path"), C->GetPathName());
        Entry->SetBoolField(TEXT("is_panel"), C->IsChildOf(UPanelWidget::StaticClass()));

        FString Desc = C->GetMetaData(TEXT("ToolTip"));
        if (Desc.IsEmpty()) Desc = C->GetMetaData(TEXT("Description"));
        if (Desc.IsEmpty()) Desc = C->GetMetaData(TEXT("WidgetCategory"));
        Entry->SetStringField(TEXT("description"), Desc);

        Results.Add(MakeShared<FJsonValueObject>(Entry));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("types"), Results);
    return FHaybaHandlerResult::Ok(Out);
}

#endif // WITH_EDITOR
