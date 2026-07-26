#include "HaybaMCPUIHandler.h"
#include <initializer_list>
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
#include "Components/CircularThrobber.h"
#include "Components/InvalidationBox.h"
#include "Components/SafeZone.h"
#include "Components/InputKeySelector.h"
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
#include "Components/RichTextBlock.h"
#include "Components/EditableText.h"
#include "Engine/Font.h"
#include "Engine/FontFace.h"
#include "Engine/Blueprint.h"
#include "Styling/CoreStyle.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "HaybaMCPReflection.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPUILayout.h"
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
        TEXT("ui_build_tree"),
        TEXT("ui_set_variable"),
        TEXT("ui_list_widget_blueprints"),
        TEXT("ui_layout_snapshot"),
        TEXT("ui_measure_text"),
        TEXT("ui_report_findings"),
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
            // Previously included as headers but never resolvable by short name.
            M.Add(TEXT("NamedSlot"),          UNamedSlot::StaticClass());
            M.Add(TEXT("NativeWidgetHost"),   UNativeWidgetHost::StaticClass());
            M.Add(TEXT("RichTextBlock"),      URichTextBlock::StaticClass());
            M.Add(TEXT("EditableText"),       UEditableText::StaticClass());
            M.Add(TEXT("CircularThrobber"),   UCircularThrobber::StaticClass());
            M.Add(TEXT("InvalidationBox"),    UInvalidationBox::StaticClass());
            M.Add(TEXT("SafeZone"),           USafeZone::StaticClass());
            M.Add(TEXT("InputKeySelector"),   UInputKeySelector::StaticClass());
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

    /** Every widget in the subtree rooted at `W`, including `W` itself. */
    void CollectSubtree(UWidget* W, TArray<UWidget*>& Out)
    {
        if (!W) return;
        Out.Add(W);
        if (UPanelWidget* Panel = Cast<UPanelWidget>(W))
        {
            for (int32 i = 0; i < Panel->GetChildrenCount(); ++i)
            {
                CollectSubtree(Panel->GetChildAt(i), Out);
            }
        }
    }

    /** Drop the whole subtree's variable GUIDs, not just the removed widget's.
     *  Leaving descendants behind orphans entries in
     *  WidgetVariableNameToGuidMap, which later resurfaces as phantom
     *  variables on the compiled blueprint. */
    void PurgeSubtreeGuids(UWidgetBlueprint* WBP, UWidget* Root)
    {
        if (!WBP || !Root) return;
        TArray<UWidget*> Subtree;
        CollectSubtree(Root, Subtree);
        for (UWidget* W : Subtree)
        {
            if (W) WBP->WidgetVariableNameToGuidMap.Remove(W->GetFName());
        }
    }

    /** Copy every property the two widgets share by name and type. Used by
     *  `replace` with preserve_properties — text, colours, padding and so on
     *  survive a Button→CheckBox style swap instead of resetting to defaults. */
    int32 CopyCommonProperties(UObject* From, UObject* To)
    {
        if (!From || !To) return 0;
        int32 Copied = 0;
        for (TFieldIterator<FProperty> It(From->GetClass()); It; ++It)
        {
            FProperty* SrcProp = *It;
            if (!SrcProp) continue;
            // Transient/native-only state is not authoring data; copying it
            // moves runtime junk (cached slate handles, generated names) across.
            if (SrcProp->HasAnyPropertyFlags(CPF_Transient | CPF_DuplicateTransient | CPF_EditorOnly)) continue;

            const FName PropName = SrcProp->GetFName();
            if (PropName == TEXT("Slot")) continue;  // owned by the parent panel

            FProperty* DstProp = To->GetClass()->FindPropertyByName(PropName);
            if (!DstProp) continue;
            if (!DstProp->SameType(SrcProp)) continue;

            DstProp->CopyCompleteValue_InContainer(To, From);
            ++Copied;
        }
        return Copied;
    }

    /** Whether a widget can take keyboard/gamepad focus.
     *  There is no UWidget-level accessor: each focusable widget class declares
     *  its own `IsFocusable` / `bIsFocusable` property, so read it reflectively
     *  rather than casting to a hand-maintained list of classes. Text entry
     *  widgets do not declare the flag at all — they are always focusable. */
    bool ResolveIsFocusable(UWidget* W)
    {
        if (!W) return false;

        static const FName Names[] = { TEXT("IsFocusable"), TEXT("bIsFocusable") };
        for (const FName& PropName : Names)
        {
            if (FBoolProperty* Prop = CastField<FBoolProperty>(W->GetClass()->FindPropertyByName(PropName)))
            {
                return Prop->GetPropertyValue_InContainer(W);
            }
        }

        return W->IsA<UEditableText>() || W->IsA<UEditableTextBox>() ||
               W->IsA<UMultiLineEditableTextBox>() || W->IsA<USpinBox>() || W->IsA<USlider>();
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

    /** Outcome of applying a slot-props object. Callers report these verbatim:
     *  a key that matched nothing is a caller error worth surfacing, not
     *  something to swallow while still reporting success. */
    struct FSlotApplyResult
    {
        TArray<FString> Applied;
        TArray<FString> Unknown;
    };

    /** Keys the explicit branches below actually consume FOR THIS SLOT TYPE.
     *  Type-aware on purpose: `z_order` is real on a canvas slot and meaningless
     *  on a vertical-box slot, and a caller who sends the latter deserves to be
     *  told rather than shown a success count that includes it. */
    static TSet<FString> ApplicableSlotKeys(UPanelSlot* Slot)
    {
        // Accepted and ignored everywhere: callers routinely echo the slot type back.
        TSet<FString> Keys = { TEXT("type") };

        auto AddAll = [&Keys](std::initializer_list<const TCHAR*> Names)
        {
            for (const TCHAR* N : Names) Keys.Add(FString(N));
        };

        const bool bHasAlignment =
            Slot->IsA<UHorizontalBoxSlot>() || Slot->IsA<UVerticalBoxSlot>() || Slot->IsA<UOverlaySlot>() ||
            Slot->IsA<UScrollBoxSlot>()     || Slot->IsA<UBorderSlot>()      || Slot->IsA<USizeBoxSlot>() ||
            Slot->IsA<UWrapBoxSlot>()       || Slot->IsA<UWidgetSwitcherSlot>() ||
            Slot->IsA<UGridSlot>()          || Slot->IsA<UUniformGridSlot>();
        if (bHasAlignment) AddAll({ TEXT("horizontal_alignment"), TEXT("vertical_alignment") });

        const bool bHasPadding =
            Slot->IsA<UHorizontalBoxSlot>() || Slot->IsA<UVerticalBoxSlot>() || Slot->IsA<UOverlaySlot>() ||
            Slot->IsA<UScrollBoxSlot>()     || Slot->IsA<UBorderSlot>()      || Slot->IsA<USizeBoxSlot>() ||
            Slot->IsA<UWrapBoxSlot>()       || Slot->IsA<UWidgetSwitcherSlot>() || Slot->IsA<UGridSlot>();
        if (bHasPadding) Keys.Add(TEXT("padding"));

        if (Slot->IsA<UCanvasPanelSlot>())
        {
            AddAll({ TEXT("anchor_min_x"), TEXT("anchor_min_y"), TEXT("anchor_max_x"), TEXT("anchor_max_y"),
                     TEXT("anchors"), TEXT("anchors_min"), TEXT("anchors_max"),
                     TEXT("x"), TEXT("y"), TEXT("w"), TEXT("h"),
                     TEXT("position"), TEXT("size"), TEXT("alignment"), TEXT("auto_size"), TEXT("z_order") });
        }
        if (Slot->IsA<UHorizontalBoxSlot>() || Slot->IsA<UVerticalBoxSlot>())
        {
            Keys.Add(TEXT("fill"));
        }
        if (Slot->IsA<UGridSlot>())
        {
            AddAll({ TEXT("row"), TEXT("column"), TEXT("row_span"), TEXT("column_span"), TEXT("layer"), TEXT("nudge") });
        }
        if (Slot->IsA<UUniformGridSlot>())
        {
            AddAll({ TEXT("row"), TEXT("column") });
        }
        return Keys;
    }

    /** Padding is set whenever the key is present, including an explicit zero.
     *  The previous "only if non-zero" guard made it impossible to clear
     *  padding — the call reported success and the margin stayed put. */
    static bool TryApplyPadding(const TSharedPtr<FJsonObject>& Props, const FString& Key, FMargin& Out)
    {
        if (!Props->HasField(Key)) return false;
        Out = ParseMargin(Props, Key);
        return true;
    }

    /** Anchors accept every shape a caller might reasonably send:
     *  flat anchor_min_x/…, an {min_x,…} object, or anchors_min/anchors_max
     *  as [x,y] pairs (which is what the typed slot-layout tool sends). */
    static bool TryApplyAnchors(const TSharedPtr<FJsonObject>& Props, UCanvasPanelSlot* CSlot)
    {
        bool bChanged = false;
        FAnchors Anchors = CSlot->GetAnchors();

        double V = 0.0;
        if (Props->TryGetNumberField(TEXT("anchor_min_x"), V)) { Anchors.Minimum.X = V; bChanged = true; }
        if (Props->TryGetNumberField(TEXT("anchor_min_y"), V)) { Anchors.Minimum.Y = V; bChanged = true; }
        if (Props->TryGetNumberField(TEXT("anchor_max_x"), V)) { Anchors.Maximum.X = V; bChanged = true; }
        if (Props->TryGetNumberField(TEXT("anchor_max_y"), V)) { Anchors.Maximum.Y = V; bChanged = true; }

        const TSharedPtr<FJsonObject>* AnchorsObj = nullptr;
        if (Props->TryGetObjectField(TEXT("anchors"), AnchorsObj) && AnchorsObj && AnchorsObj->IsValid())
        {
            double MinX = Anchors.Minimum.X, MinY = Anchors.Minimum.Y;
            double MaxX = Anchors.Maximum.X, MaxY = Anchors.Maximum.Y;
            (*AnchorsObj)->TryGetNumberField(TEXT("min_x"), MinX);
            (*AnchorsObj)->TryGetNumberField(TEXT("min_y"), MinY);
            (*AnchorsObj)->TryGetNumberField(TEXT("max_x"), MaxX);
            (*AnchorsObj)->TryGetNumberField(TEXT("max_y"), MaxY);
            Anchors.Minimum = FVector2D(MinX, MinY);
            Anchors.Maximum = FVector2D(MaxX, MaxY);
            bChanged = true;
        }

        if (Props->HasField(TEXT("anchors_min"))) { Anchors.Minimum = ParseVec2(Props, TEXT("anchors_min")); bChanged = true; }
        if (Props->HasField(TEXT("anchors_max"))) { Anchors.Maximum = ParseVec2(Props, TEXT("anchors_max")); bChanged = true; }

        if (bChanged) CSlot->SetAnchors(Anchors);
        return bChanged;
    }

    /** Alignment shared by every slot type that exposes H/V alignment. */
    template <typename TSlot>
    static void ApplyAlignments(TSlot* S, const TSharedPtr<FJsonObject>& Props)
    {
        FString HAlign, VAlign;
        if (Props->TryGetStringField(TEXT("horizontal_alignment"), HAlign))
            S->SetHorizontalAlignment(ParseHAlign(HAlign));
        if (Props->TryGetStringField(TEXT("vertical_alignment"), VAlign))
            S->SetVerticalAlignment(ParseVAlign(VAlign));
    }

    template <typename TSlot>
    static void ApplyPaddingAndAlignment(TSlot* S, const TSharedPtr<FJsonObject>& Props)
    {
        FMargin Pad;
        if (TryApplyPadding(Props, TEXT("padding"), Pad)) S->SetPadding(Pad);
        ApplyAlignments(S, Props);
    }

    FSlotApplyResult ApplySlotPropsChecked(UPanelSlot* Slot, const TSharedPtr<FJsonObject>& Props);

    void ApplySlotProps(UPanelSlot* Slot, const TSharedPtr<FJsonObject>& Props)
    {
        ApplySlotPropsChecked(Slot, Props);
    }

    FSlotApplyResult ApplySlotPropsChecked(UPanelSlot* Slot, const TSharedPtr<FJsonObject>& Props)
    {
        FSlotApplyResult Result;
        if (!Slot || !Props.IsValid()) return Result;

        // CanvasPanelSlot
        if (UCanvasPanelSlot* CSlot = Cast<UCanvasPanelSlot>(Slot))
        {
            TryApplyAnchors(Props, CSlot);

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

            // HasField (not "is non-zero") so a caller CAN move a widget back to
            // the origin or collapse it to zero size.
            if (Props->HasField(TEXT("position")))  CSlot->SetPosition(ParseVec2(Props, TEXT("position")));
            if (Props->HasField(TEXT("size")))      CSlot->SetSize(ParseVec2(Props, TEXT("size")));
            if (Props->HasField(TEXT("alignment"))) CSlot->SetAlignment(ParseVec2(Props, TEXT("alignment")));

            bool bAutoSize = false;
            if (Props->TryGetBoolField(TEXT("auto_size"), bAutoSize))
                CSlot->SetAutoSize(bAutoSize);

            int32 ZOrder = 0;
            if (Props->TryGetNumberField(TEXT("z_order"), ZOrder))
                CSlot->SetZOrder(ZOrder);
        }

        // HorizontalBoxSlot / VerticalBoxSlot share the fill+padding+alignment shape.
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
            ApplyPaddingAndAlignment(HSlot, Props);
        }

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
            ApplyPaddingAndAlignment(VSlot, Props);
        }

        if (UOverlaySlot* OSlot = Cast<UOverlaySlot>(Slot))       ApplyPaddingAndAlignment(OSlot, Props);
        if (UScrollBoxSlot* ScSlot = Cast<UScrollBoxSlot>(Slot))  ApplyPaddingAndAlignment(ScSlot, Props);
        if (UBorderSlot* BSlot = Cast<UBorderSlot>(Slot))         ApplyPaddingAndAlignment(BSlot, Props);
        if (USizeBoxSlot* SbSlot = Cast<USizeBoxSlot>(Slot))      ApplyPaddingAndAlignment(SbSlot, Props);
        if (UWrapBoxSlot* WSlot = Cast<UWrapBoxSlot>(Slot))       ApplyPaddingAndAlignment(WSlot, Props);
        if (UWidgetSwitcherSlot* WsSlot = Cast<UWidgetSwitcherSlot>(Slot)) ApplyPaddingAndAlignment(WsSlot, Props);

        // GridSlot
        if (UGridSlot* GSlot = Cast<UGridSlot>(Slot))
        {
            int32 Row, Column, RowSpan, ColSpan, Layer;
            if (Props->TryGetNumberField(TEXT("row"), Row))              GSlot->SetRow(Row);
            if (Props->TryGetNumberField(TEXT("column"), Column))        GSlot->SetColumn(Column);
            if (Props->TryGetNumberField(TEXT("row_span"), RowSpan))     GSlot->SetRowSpan(RowSpan);
            if (Props->TryGetNumberField(TEXT("column_span"), ColSpan))  GSlot->SetColumnSpan(ColSpan);
            if (Props->TryGetNumberField(TEXT("layer"), Layer))          GSlot->SetLayer(Layer);

            ApplyPaddingAndAlignment(GSlot, Props);

            if (Props->HasField(TEXT("nudge"))) GSlot->SetNudge(ParseVec2(Props, TEXT("nudge")));
        }

        // UniformGridSlot
        if (UUniformGridSlot* USlot = Cast<UUniformGridSlot>(Slot))
        {
            int32 Row, Column;
            if (Props->TryGetNumberField(TEXT("row"), Row))       USlot->SetRow(Row);
            if (Props->TryGetNumberField(TEXT("column"), Column)) USlot->SetColumn(Column);
            ApplyAlignments(USlot, Props);
        }

        // Anything not handled above gets one reflection attempt against the
        // slot's own UPROPERTYs; only then is it reported unknown. Silently
        // dropping keys is what let ui_set_slot_layout report success while
        // changing nothing.
        const TSet<FString> Applicable = ApplicableSlotKeys(Slot);
        for (const auto& Pair : Props->Values)
        {
            const FString Key(Pair.Key);
            if (Applicable.Contains(Key))
            {
                Result.Applied.Add(Key);
                continue;
            }
            if (HaybaReflection::SetProp(Slot, Key, Pair.Value)) Result.Applied.Add(Key);
            else Result.Unknown.Add(Key);
        }

        return Result;
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
    if (Cmd == TEXT("ui_build_tree"))          return HandleBuildTree(P);
    if (Cmd == TEXT("ui_set_variable"))        return HandleSetVariable(P);
    if (Cmd == TEXT("ui_list_widget_blueprints")) return HandleListWidgetBlueprints(P);
    if (Cmd == TEXT("ui_layout_snapshot"))     return HandleLayoutSnapshot(P);
    if (Cmd == TEXT("ui_measure_text"))        return HandleMeasureText(P);
    if (Cmd == TEXT("ui_report_findings"))     return HandleReportFindings(P);

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
    // Three spellings have shipped in different layers: `slot_props` (public
    // schema), `slot_properties` (an early handler revision) and `slot_layout`
    // (the typed slot tool). Only the first was ever read, so the typed tool's
    // payload fell on the floor and the call failed with "no properties
    // provided" no matter how well-formed it was. Accept all three.
    if (!(P->TryGetObjectField(TEXT("slot_props"), SlotProps) && SlotProps && SlotProps->IsValid()))
    {
        if (!(P->TryGetObjectField(TEXT("slot_properties"), SlotProps) && SlotProps && SlotProps->IsValid()))
        {
            P->TryGetObjectField(TEXT("slot_layout"), SlotProps);
        }
    }

    if ((!Props || !Props->IsValid()) && (!SlotProps || !SlotProps->IsValid()))
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: no properties or slot_props provided"));

    int32 Succeeded = 0;
    int32 Failed = 0;
    TArray<FString> FailedProps;
    TArray<FString> UnknownSlotProps;
    TArray<FString> Warnings;
    {
        // No FScopedTransaction: these are automation-tool edits with no undo/redo
        // requirement, and the global editor transaction buffer (GEditor->Trans) can
        // end up retaining a reference into a PIE session, crashing the editor on PIE
        // stop with "Object 'GameInstance ...' from PIE level still referenced".
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

        if (SlotProps && SlotProps->IsValid())
        {
            if (!Widget->Slot)
            {
                // The root widget has no slot at all. Reporting the keys as
                // applied here would be a flat lie.
                for (const auto& Pair : (*SlotProps)->Values)
                {
                    ++Failed;
                    FailedProps.Add(FString::Printf(TEXT("slot.%s"), *FString(Pair.Key)));
                }
                Warnings.Add(FString::Printf(
                    TEXT("'%s' has no panel slot (it is the root widget, or its parent is not a panel), so slot layout was not applied."),
                    *WidgetName));
            }
            else
            {
                // Slots are distinct UObject instances in a WidgetTree.  Marking
                // only the child widget dirty made horizontal/vertical padding look
                // successful in the response but vanish on the next query/reopen.
                Widget->Slot->Modify();
                const FSlotApplyResult SlotResult = ApplySlotPropsChecked(Widget->Slot, *SlotProps);
                Widget->Slot->PostEditChange();

                // Count what actually landed. The previous code incremented the
                // success counter once per submitted key regardless of whether
                // the slot understood it.
                Succeeded += SlotResult.Applied.Num();
                Failed += SlotResult.Unknown.Num();
                for (const FString& Key : SlotResult.Unknown)
                {
                    UnknownSlotProps.Add(Key);
                    FailedProps.Add(FString::Printf(TEXT("slot.%s"), *Key));
                }
                if (SlotResult.Unknown.Num() > 0)
                {
                    Warnings.Add(FString::Printf(
                        TEXT("Slot is a %s; keys %s are not valid for that slot type. Query the widget to see its real slot class."),
                        *Widget->Slot->GetClass()->GetName(),
                        *FString::Join(SlotResult.Unknown, TEXT(", "))));
                }
            }
        }

        // The single most expensive UMG trap to debug: assigning a UFontFace to
        // a Slate font renders the font's glyph-preview atlas ("BASIC LATIN /
        // A / 0000-007F" tiles) instead of text. Slate needs a composite UFont.
        {
            FSlateFontInfo WidgetFont;
            if (HaybaUILayout::GetWidgetFont(Widget, WidgetFont) && WidgetFont.FontObject)
            {
                if (WidgetFont.FontObject->IsA<UFontFace>())
                {
                    Warnings.Add(FString::Printf(
                        TEXT("Font object '%s' is a UFontFace, not a UFont. Slate renders a UFontFace as its glyph-preview tiles rather than as text. Assign the composite UFont asset instead."),
                        *WidgetFont.FontObject->GetPathName()));
                }
            }
        }

        Widget->PostEditChange();
        // Designer-slot layout is serialized as part of the WidgetTree, so use
        // a structural notification rather than a mere generated-class refresh.
        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();
    }

    auto ToJsonArray = [](const TArray<FString>& In)
    {
        TArray<TSharedPtr<FJsonValue>> Arr;
        for (const FString& S : In) Arr.Add(MakeShared<FJsonValueString>(S));
        return Arr;
    };

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_name"), WidgetName);
    Out->SetNumberField(TEXT("succeeded"), Succeeded);
    Out->SetNumberField(TEXT("failed"), Failed);
    if (FailedProps.Num() > 0)      Out->SetArrayField(TEXT("failed_properties"), ToJsonArray(FailedProps));
    if (UnknownSlotProps.Num() > 0) Out->SetArrayField(TEXT("unknown_slot_props"), ToJsonArray(UnknownSlotProps));
    if (Warnings.Num() > 0)         Out->SetArrayField(TEXT("warnings"), ToJsonArray(Warnings));

    if (Succeeded == 0)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("ui_set_widget_properties: nothing applied to '%s'. Rejected: %s"),
            *WidgetName, *FString::Join(FailedProps, TEXT(", "))));
    }

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

    // Filtered mode: return a flat list of matching widgets rather than the
    // whole tree. Without this a "search" can only be done by shipping the
    // entire tree to the caller and filtering there, which is what made the
    // search tool a full-tree dump wearing a search tool's schema.
    FString NamePattern, ClassFilter;
    const bool bHasNameFilter  = P->TryGetStringField(TEXT("name_pattern"), NamePattern) && !NamePattern.IsEmpty();
    const bool bHasClassFilter = P->TryGetStringField(TEXT("class_filter"), ClassFilter) && !ClassFilter.IsEmpty();
    bool bFlatten = false;
    P->TryGetBoolField(TEXT("flatten"), bFlatten);

    if (bHasNameFilter || bHasClassFilter || bFlatten)
    {
        TArray<TSharedPtr<FJsonValue>> Matches;
        WBP->WidgetTree->ForEachWidget([&](UWidget* Widget)
        {
            if (!Widget) return;
            if (bHasNameFilter && !Widget->GetName().Contains(NamePattern)) return;
            if (bHasClassFilter)
            {
                // Match on the exact class name or anywhere in the inheritance
                // chain, so class_filter:"PanelWidget" finds every panel.
                bool bClassMatch = false;
                for (UClass* C = Widget->GetClass(); C; C = C->GetSuperClass())
                {
                    if (C->GetName() == ClassFilter || C->GetName() == (TEXT("U") + ClassFilter))
                    {
                        bClassMatch = true;
                        break;
                    }
                }
                if (!bClassMatch) return;
            }

            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("name"), Widget->GetName());
            Entry->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
            Entry->SetStringField(TEXT("parent"), Widget->GetParent() ? Widget->GetParent()->GetName() : FString());
            if (bIncludeSlot) Entry->SetStringField(TEXT("slot_class"), ResolveSlotType(Widget));
            if (bIncludeGuid)
            {
                if (const FGuid* Found = WBP->WidgetVariableNameToGuidMap.Find(Widget->GetFName()))
                    Entry->SetStringField(TEXT("guid"), Found->ToString());
            }
            if (bIncludeProperties) Entry->SetObjectField(TEXT("properties"), ExtractWidgetProperties(Widget));
            Matches.Add(MakeShared<FJsonValueObject>(Entry));
        });

        Out->SetArrayField(TEXT("matches"), Matches);
        Out->SetNumberField(TEXT("match_count"), Matches.Num());
        if (bHasNameFilter)  Out->SetStringField(TEXT("name_pattern"), NamePattern);
        if (bHasClassFilter) Out->SetStringField(TEXT("class_filter"), ClassFilter);
        return FHaybaHandlerResult::Ok(Out);
    }

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
            // No FScopedTransaction — see comment in ui_set_widget_properties above:
            // avoids pinning a PIE GameInstance reference in the editor undo buffer.
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

            PurgeSubtreeGuids(WBP, Widget);
            // Detach the widget objects from the tree as well; RemoveChild only
            // unlinks from the panel, leaving the widgets owned by the tree.
            WBP->WidgetTree->RemoveWidget(Widget);
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

        int32 InsertIndex = -1;
        P->TryGetNumberField(TEXT("index"), InsertIndex);

        {
            // No FScopedTransaction — see comment in ui_set_widget_properties above:
            // avoids pinning a PIE GameInstance reference in the editor undo buffer.
            WBP->Modify();
            Widget->Modify();
            OldParent->Modify();
            NewParent->Modify();

            OldParent->RemoveChild(Widget);

            UPanelSlot* NewSlot = (InsertIndex >= 0 && InsertIndex <= NewParent->GetChildrenCount())
                ? NewParent->InsertChildAt(InsertIndex, Widget)
                : NewParent->AddChild(Widget);

            if (!NewSlot)
            {
                // Put it back rather than leaving the widget orphaned: full
                // panels (SizeBox, Border, ScaleBox hold exactly one child)
                // reject the add and the caller's tree would silently lose a
                // whole subtree.
                OldParent->InsertChildAt(FMath::Clamp(OldIndex, 0, OldParent->GetChildrenCount()), Widget);
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("ui_mutate_tree reparent: '%s' refused the child (a %s holds a limited number of children). Widget left under '%s'."),
                    *NewParentName, *NewParent->GetClass()->GetName(), *OldParentName));
            }

            // Slot layout for the NEW parent, since the old slot's type is
            // usually not even the same class.
            const TSharedPtr<FJsonObject>* SlotProps = nullptr;
            if (P->TryGetObjectField(TEXT("slot_props"), SlotProps) && SlotProps && SlotProps->IsValid())
            {
                NewSlot->Modify();
                const FSlotApplyResult SlotResult = ApplySlotPropsChecked(NewSlot, *SlotProps);
                NewSlot->PostEditChange();
                if (SlotResult.Unknown.Num() > 0)
                {
                    TArray<TSharedPtr<FJsonValue>> UArr;
                    for (const FString& K : SlotResult.Unknown) UArr.Add(MakeShared<FJsonValueString>(K));
                    Out->SetArrayField(TEXT("unknown_slot_props"), UArr);
                }
            }

            Out->SetStringField(TEXT("new_slot_class"), NewSlot->GetClass()->GetName());
            Out->SetNumberField(TEXT("new_child_index"), NewParent->GetChildIndex(Widget));

            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
            WBP->MarkPackageDirty();
        }

        Out->SetStringField(TEXT("widget_name"), WidgetName);
        Out->SetStringField(TEXT("old_parent"), OldParentName);
        Out->SetNumberField(TEXT("old_child_index"), OldIndex);
        Out->SetStringField(TEXT("new_parent"), NewParentName);

        return FHaybaHandlerResult::Ok(Out);
    }
    else if (Operation == TEXT("move"))
    {
        // Reorder within the current parent. Draw/tab order in a box panel is
        // child order, so this is the only way to change it without a
        // remove+re-add round trip that loses the slot layout.
        FString WidgetName;
        int32 NewIndex = 0;
        if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree move: missing widget_name"));
        if (!P->TryGetNumberField(TEXT("index"), NewIndex))
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree move: missing index"));

        UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Widget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree move: widget '%s' not found"), *WidgetName));

        UPanelWidget* Parent = Widget->GetParent();
        if (!Parent)
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree move: widget is the root and has no siblings"));

        const int32 OldIndex = Parent->GetChildIndex(Widget);
        const int32 LastIndex = Parent->GetChildrenCount() - 1;
        if (NewIndex < 0 || NewIndex > LastIndex)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("ui_mutate_tree move: index %d out of range (parent '%s' has %d children, valid 0..%d)"),
                NewIndex, *Parent->GetName(), Parent->GetChildrenCount(), LastIndex));
        }

        if (NewIndex != OldIndex)
        {
            WBP->Modify();
            Parent->Modify();
            Widget->Modify();

            // Preserve the slot: shifting order must not reset padding/fill, so
            // copy the old slot's values onto whatever slot the re-insert makes.
            UPanelSlot* const OldSlot = Widget->Slot;
            UObject* SlotSnapshot = nullptr;
            if (OldSlot)
            {
                SlotSnapshot = NewObject<UObject>(GetTransientPackage(), OldSlot->GetClass());
                CopyCommonProperties(OldSlot, SlotSnapshot);
            }

            Parent->RemoveChild(Widget);
            UPanelSlot* NewSlot = Parent->InsertChildAt(NewIndex, Widget);
            if (!NewSlot)
            {
                Parent->InsertChildAt(FMath::Clamp(OldIndex, 0, Parent->GetChildrenCount()), Widget);
                return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree move: re-insert failed; widget restored to its original index"));
            }
            if (SlotSnapshot)
            {
                CopyCommonProperties(SlotSnapshot, NewSlot);
                NewSlot->SynchronizeProperties();
            }

            FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
            WBP->MarkPackageDirty();
        }

        Out->SetStringField(TEXT("widget_name"), WidgetName);
        Out->SetStringField(TEXT("parent"), Parent->GetName());
        Out->SetNumberField(TEXT("old_index"), OldIndex);
        Out->SetNumberField(TEXT("new_index"), NewIndex);
        return FHaybaHandlerResult::Ok(Out);
    }
    else if (Operation == TEXT("rename"))
    {
        FString WidgetName, NewName;
        if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree rename: missing widget_name"));
        if (!P->TryGetStringField(TEXT("new_name"), NewName) || NewName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree rename: missing new_name"));

        UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Widget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree rename: widget '%s' not found"), *WidgetName));
        if (!ValidateWidgetName(WBP->WidgetTree, NewName))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree rename: '%s' is already taken in this widget tree"), *NewName));

        WBP->Modify();
        Widget->Modify();

        // Carry the variable GUID across so existing bindings and any graph
        // references keep resolving to this widget.
        FGuid Guid;
        const bool bHadGuid = WBP->WidgetVariableNameToGuidMap.RemoveAndCopyValue(FName(*WidgetName), Guid);

        Widget->Rename(*NewName, Widget->GetOuter(), REN_DontCreateRedirectors);

        if (bHadGuid) WBP->WidgetVariableNameToGuidMap.Add(FName(*NewName), Guid);
        else RegisterWidgetVariable(WBP, Widget);

        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();

        Out->SetStringField(TEXT("old_name"), WidgetName);
        Out->SetStringField(TEXT("new_name"), Widget->GetName());
        Out->SetBoolField(TEXT("guid_preserved"), bHadGuid);
        return FHaybaHandlerResult::Ok(Out);
    }
    else if (Operation == TEXT("duplicate"))
    {
        FString WidgetName, NewName, TargetParentName;
        if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree duplicate: missing widget_name"));
        P->TryGetStringField(TEXT("new_name"), NewName);
        P->TryGetStringField(TEXT("parent_widget_name"), TargetParentName);

        UWidget* Source = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Source)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree duplicate: widget '%s' not found"), *WidgetName));

        UPanelWidget* TargetParent = TargetParentName.IsEmpty()
            ? Source->GetParent()
            : Cast<UPanelWidget>(FindWidgetByName(WBP->WidgetTree, TargetParentName));
        if (!TargetParent)
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree duplicate: no target panel (source is the root — pass parent_widget_name)"));

        if (!NewName.IsEmpty() && !ValidateWidgetName(WBP->WidgetTree, NewName))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_mutate_tree duplicate: '%s' is already taken"), *NewName));

        WBP->Modify();
        TargetParent->Modify();

        // Duplicating into the widget tree copies the whole subtree, which is
        // the point: duplicating a styled row should bring its children along.
        //
        // But the copy arrives with EVERY descendant still carrying its source
        // name, and UMG requires names to be unique across the whole tree. UE
        // resolves the collision by renaming objects to TRASH_<name>, which
        // leaves the blueprint with a mangled copy and two widgets answering to
        // the same name. So duplicate under a scratch name first, then rename
        // the whole subtree to unique names before anything else sees it.
        const FName ScratchName = MakeUniqueObjectName(
            WBP->WidgetTree, Source->GetClass(), TEXT("HaybaMCP_DuplicateScratch"));

        UWidget* Copy = DuplicateObject<UWidget>(Source, WBP->WidgetTree, ScratchName);
        if (!Copy)
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree duplicate: DuplicateObject failed"));

        // The root of the copy takes the caller's name (or a unique variant of
        // the source's); every descendant takes a unique variant of its own.
        {
            TArray<UWidget*> Copied;
            CollectSubtree(Copy, Copied);
            for (UWidget* W : Copied)
            {
                if (!W) continue;

                const bool bIsRoot = (W == Copy);
                FName Desired;
                if (bIsRoot && !NewName.IsEmpty())
                {
                    Desired = FName(*NewName);
                }
                else
                {
                    // Base the unique name on the SOURCE widget's name, not the
                    // scratch name, so a duplicated "Row" reads "Row_1".
                    const FName Base = bIsRoot ? Source->GetFName() : W->GetFName();
                    Desired = MakeUniqueObjectName(WBP->WidgetTree, W->GetClass(), Base);
                }

                if (W->GetFName() != Desired)
                {
                    W->Rename(*Desired.ToString(), WBP->WidgetTree, REN_DontCreateRedirectors | REN_DoNotDirty);
                }
            }
        }

        UPanelSlot* NewSlot = TargetParent->AddChild(Copy);
        if (!NewSlot)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("ui_mutate_tree duplicate: '%s' refused the child (panel is full)"), *TargetParent->GetName()));

        if (Source->Slot && NewSlot->GetClass() == Source->Slot->GetClass())
        {
            CopyCommonProperties(Source->Slot, NewSlot);
            NewSlot->SynchronizeProperties();
        }

        // Register the copy and every duplicated descendant as variables so
        // they behave like hand-placed widgets in the designer.
        TArray<UWidget*> Subtree;
        CollectSubtree(Copy, Subtree);
        for (UWidget* W : Subtree) RegisterWidgetVariable(WBP, W);

        const TSharedPtr<FJsonObject>* SlotProps = nullptr;
        if (P->TryGetObjectField(TEXT("slot_props"), SlotProps) && SlotProps && SlotProps->IsValid())
        {
            ApplySlotPropsChecked(NewSlot, *SlotProps);
        }

        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();

        Out->SetStringField(TEXT("source"), WidgetName);
        Out->SetStringField(TEXT("name"), Copy->GetName());
        Out->SetStringField(TEXT("parent"), TargetParent->GetName());
        Out->SetNumberField(TEXT("widgets_duplicated"), Subtree.Num());
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
            // No FScopedTransaction — see comment in ui_set_widget_properties above:
            // avoids pinning a PIE GameInstance reference in the editor undo buffer.
            WBP->Modify();
            Widget->Modify();
            Parent->Modify();

            const FName ConstructName = NewName.IsEmpty() ? Widget->GetFName() : FName(*NewName);

            // Free the name before reusing it. Constructing a widget with a name
            // the outgoing widget still holds makes UE silently uniquify the new
            // one ("Title_1"), which then breaks every binding that referenced
            // the original name.
            UPanelSlot* const OldSlot = Widget->Slot;
            if (ConstructName == Widget->GetFName())
            {
                Widget->Rename(*MakeUniqueObjectName(Widget->GetOuter(), Widget->GetClass(), TEXT("HaybaMCP_Replaced")).ToString(),
                    Widget->GetOuter(), REN_DontCreateRedirectors | REN_DoNotDirty);
            }

            UWidget* NewWidget = WBP->WidgetTree->ConstructWidget<UWidget>(NewClass, ConstructName);
            if (!NewWidget)
                return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: ConstructWidget failed"));

            int32 PropertiesCopied = 0;
            if (bPreserveProperties)
            {
                PropertiesCopied = CopyCommonProperties(Widget, NewWidget);
            }

            UPanelSlot* NewSlot = Parent->InsertChildAt(ChildIndex, NewWidget);
            if (!NewSlot)
                return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree replace: InsertChildAt failed"));

            // Slot layout describes the widget's place in its parent, not the
            // widget's own identity, so it survives a class swap whenever the
            // parent hands out the same slot type (it always does — the slot
            // class is a property of the panel).
            if (OldSlot && NewSlot->GetClass() == OldSlot->GetClass())
            {
                CopyCommonProperties(OldSlot, NewSlot);
                NewSlot->SynchronizeProperties();
            }

            Out->SetNumberField(TEXT("properties_copied"), PropertiesCopied);
            Parent->RemoveChild(Widget);

            if (bPreserveGuid)
            {
                // The outgoing widget may have been renamed to a scratch name
                // just above, so key off the name the caller asked for.
                const FName OldName(*WidgetName);
                FGuid OldGuid;
                if (WBP->WidgetVariableNameToGuidMap.RemoveAndCopyValue(OldName, OldGuid))
                {
                    if (!WBP->WidgetVariableNameToGuidMap.Contains(ConstructName))
                        WBP->WidgetVariableNameToGuidMap.Add(ConstructName, OldGuid);
                }
            }
            else
            {
                WBP->WidgetVariableNameToGuidMap.Remove(FName(*WidgetName));
                RegisterWidgetVariable(WBP, NewWidget);
            }
            WBP->WidgetTree->RemoveWidget(Widget);

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

    return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("ui_mutate_tree: unknown operation '%s' (expected one of: remove, reparent, replace, move, rename, duplicate)"),
        *Operation));
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

    bool bIncludeBlueprints = false;
    P->TryGetBoolField(TEXT("include_blueprints"), bIncludeBlueprints);

    bool bPanelsOnly = false;
    P->TryGetBoolField(TEXT("panels_only"), bPanelsOnly);

    TArray<TSharedPtr<FJsonValue>> Results;

    for (TObjectIterator<UClass> It; It; ++It)
    {
        UClass* C = *It;
        if (!C->IsChildOf(UWidget::StaticClass())) continue;
        if (C == UWidget::StaticClass()) continue;
        if (C->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists)) continue;
        // Blueprint widget classes (your own reusable WBP_* components) are
        // legitimate children — ui_add_element accepts them by class path — so
        // they are only excluded when the caller asks for native types only.
        if (!C->IsNative() && !bIncludeBlueprints) continue;

        const FString Name = C->GetName();
        if (!Filter.IsEmpty() && !Name.Contains(Filter)) continue;

        const bool bIsPanel = C->IsChildOf(UPanelWidget::StaticClass());
        if (bPanelsOnly && !bIsPanel) continue;

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Name);
        Entry->SetStringField(TEXT("class_path"), C->GetPathName());
        Entry->SetBoolField(TEXT("is_panel"), bIsPanel);
        Entry->SetBoolField(TEXT("is_native"), C->IsNative());

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

// ── Batch authoring ─────────────────────────────────────────────────────────
//
// One ui_add_element per widget costs a round trip each and leaves the
// blueprint half-built when a call in the middle fails. ui_build_tree takes the
// whole subtree as a nested spec, so a screen is one call and the response
// names every widget it created.

namespace
{
    struct FBuildTreeStats
    {
        int32 Created = 0;
        TArray<FString> Names;
        TArray<FString> Warnings;
    };

    /** Recursively realise one spec node under `Parent`.
     *  Spec: { class, name?, properties?, slot_props?, children?[] } */
    FString BuildTreeNode(UWidgetBlueprint* WBP, UPanelWidget* Parent,
        const TSharedPtr<FJsonObject>& Spec, FBuildTreeStats& Stats, int32 Depth)
    {
        if (Depth > 64) return TEXT("ui_build_tree: spec nested deeper than 64 levels");
        if (!Spec.IsValid()) return TEXT("ui_build_tree: empty node in children");

        FString ClassName;
        if (!Spec->TryGetStringField(TEXT("class"), ClassName) || ClassName.IsEmpty())
            return TEXT("ui_build_tree: every node needs a 'class'");

        UClass* Class = ResolveWidgetClass(ClassName);
        if (!Class || !Class->IsChildOf(UWidget::StaticClass()))
            return FString::Printf(TEXT("ui_build_tree: unknown class '%s'"), *ClassName);

        FString Name;
        Spec->TryGetStringField(TEXT("name"), Name);
        if (!Name.IsEmpty() && !ValidateWidgetName(WBP->WidgetTree, Name))
            return FString::Printf(TEXT("ui_build_tree: widget name '%s' is already taken"), *Name);

        const FName ConstructName = Name.IsEmpty() ? NAME_None : FName(*Name);
        UWidget* New = WBP->WidgetTree->ConstructWidget<UWidget>(Class, ConstructName);
        if (!New) return FString::Printf(TEXT("ui_build_tree: could not construct '%s'"), *ClassName);

        UPanelSlot* Slot = Parent->AddChild(New);
        if (!Slot)
            return FString::Printf(TEXT("ui_build_tree: '%s' (a %s) refused another child"),
                *Parent->GetName(), *Parent->GetClass()->GetName());

        RegisterWidgetVariable(WBP, New);
        Stats.Created++;
        Stats.Names.Add(New->GetName());

        const TSharedPtr<FJsonObject>* SlotProps = nullptr;
        if (Spec->TryGetObjectField(TEXT("slot_props"), SlotProps) && SlotProps && SlotProps->IsValid())
        {
            const FSlotApplyResult R = ApplySlotPropsChecked(Slot, *SlotProps);
            for (const FString& K : R.Unknown)
            {
                Stats.Warnings.Add(FString::Printf(TEXT("%s: slot key '%s' is not valid for a %s"),
                    *New->GetName(), *K, *Slot->GetClass()->GetName()));
            }
        }

        const TSharedPtr<FJsonObject>* Props = nullptr;
        if (Spec->TryGetObjectField(TEXT("properties"), Props) && Props && Props->IsValid())
        {
            for (const auto& Pair : (*Props)->Values)
            {
                const FString PropName(Pair.Key);
                if (!HaybaReflection::SetProp(New, PropName, Pair.Value))
                {
                    Stats.Warnings.Add(FString::Printf(TEXT("%s: property '%s' was rejected by %s"),
                        *New->GetName(), *PropName, *Class->GetName()));
                }
            }
        }

        const TArray<TSharedPtr<FJsonValue>>* Children = nullptr;
        if (Spec->TryGetArrayField(TEXT("children"), Children) && Children && Children->Num() > 0)
        {
            UPanelWidget* AsPanel = Cast<UPanelWidget>(New);
            if (!AsPanel)
            {
                return FString::Printf(TEXT("ui_build_tree: '%s' is a %s, which is not a panel and cannot take children"),
                    *New->GetName(), *Class->GetName());
            }
            for (const TSharedPtr<FJsonValue>& ChildVal : *Children)
            {
                if (!ChildVal.IsValid() || ChildVal->Type != EJson::Object)
                    return TEXT("ui_build_tree: every entry of 'children' must be an object");
                const FString Err = BuildTreeNode(WBP, AsPanel, ChildVal->AsObject(), Stats, Depth + 1);
                if (!Err.IsEmpty()) return Err;
            }
        }

        return FString();
    }
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleBuildTree(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath, ParentName;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_build_tree: missing widget_blueprint_path"));
    P->TryGetStringField(TEXT("parent_widget_name"), ParentName);

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_build_tree: widget blueprint not found"));

    UPanelWidget* Parent = nullptr;
    if (ParentName.IsEmpty())
    {
        Parent = Cast<UPanelWidget>(WBP->WidgetTree->RootWidget);
        if (!Parent)
            return FHaybaHandlerResult::Err(TEXT("ui_build_tree: root widget is not a panel; pass parent_widget_name"));
    }
    else
    {
        Parent = Cast<UPanelWidget>(FindWidgetByName(WBP->WidgetTree, ParentName));
        if (!Parent)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_build_tree: parent '%s' not found or not a panel"), *ParentName));
    }

    // Accept either a single root node or an array of siblings.
    TArray<TSharedPtr<FJsonValue>> Nodes;
    const TSharedPtr<FJsonObject>* SingleNode = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* NodeArray = nullptr;
    if (P->TryGetObjectField(TEXT("tree"), SingleNode) && SingleNode && SingleNode->IsValid())
    {
        Nodes.Add(MakeShared<FJsonValueObject>(SingleNode->ToSharedRef()));
    }
    else if (P->TryGetArrayField(TEXT("tree"), NodeArray) && NodeArray)
    {
        Nodes = *NodeArray;
    }
    else
    {
        return FHaybaHandlerResult::Err(TEXT("ui_build_tree: missing 'tree' (an object, or an array of objects, each {class, name?, properties?, slot_props?, children?})"));
    }

    WBP->Modify();

    FBuildTreeStats Stats;
    FString Error;
    for (const TSharedPtr<FJsonValue>& Node : Nodes)
    {
        if (!Node.IsValid() || Node->Type != EJson::Object)
        {
            Error = TEXT("ui_build_tree: every entry of 'tree' must be an object");
            break;
        }
        Error = BuildTreeNode(WBP, Parent, Node->AsObject(), Stats, 0);
        if (!Error.IsEmpty()) break;
    }

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
    WBP->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_blueprint_path"), WBP->GetPathName());
    Out->SetStringField(TEXT("parent"), Parent->GetName());
    Out->SetNumberField(TEXT("created"), Stats.Created);

    TArray<TSharedPtr<FJsonValue>> NameArr;
    for (const FString& N : Stats.Names) NameArr.Add(MakeShared<FJsonValueString>(N));
    Out->SetArrayField(TEXT("names"), NameArr);

    if (Stats.Warnings.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> WArr;
        for (const FString& W : Stats.Warnings) WArr.Add(MakeShared<FJsonValueString>(W));
        Out->SetArrayField(TEXT("warnings"), WArr);
    }

    if (!Error.IsEmpty())
    {
        // Partial builds are kept, not rolled back — the widgets that landed are
        // usually the ones the caller wanted, and silently discarding them would
        // hide how far the spec got. The error names where it stopped and the
        // response lists exactly what exists now.
        Out->SetStringField(TEXT("error"), Error);
        Out->SetBoolField(TEXT("partial"), true);
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("%s — %d widget(s) were created before the failure: %s"),
            *Error, Stats.Created, *FString::Join(Stats.Names, TEXT(", "))));
    }

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleSetVariable(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath, WidgetName;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_set_variable: missing widget_blueprint_path"));
    if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_set_variable: missing widget_name"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_set_variable: widget blueprint not found"));

    UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
    if (!Widget)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_set_variable: widget '%s' not found"), *WidgetName));

    bool bIsVariable = true;
    P->TryGetBoolField(TEXT("is_variable"), bIsVariable);

    WBP->Modify();
    Widget->Modify();
    Widget->bIsVariable = bIsVariable;

    if (bIsVariable) RegisterWidgetVariable(WBP, Widget);
    else WBP->WidgetVariableNameToGuidMap.Remove(Widget->GetFName());

    FString Category;
    if (P->TryGetStringField(TEXT("category"), Category) && !Category.IsEmpty())
    {
        Widget->SetCategoryName(Category);
    }

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
    WBP->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_name"), Widget->GetName());
    Out->SetBoolField(TEXT("is_variable"), bIsVariable);
    if (!Category.IsEmpty()) Out->SetStringField(TEXT("category"), Category);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleListWidgetBlueprints(const TSharedPtr<FJsonObject>& P)
{
    FString PathFilter, NameFilter;
    P->TryGetStringField(TEXT("path"), PathFilter);
    P->TryGetStringField(TEXT("filter"), NameFilter);

    IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();

    FARFilter Filter;
    Filter.ClassPaths.Add(UWidgetBlueprint::StaticClass()->GetClassPathName());
    Filter.bRecursiveClasses = true;
    if (!PathFilter.IsEmpty())
    {
        Filter.PackagePaths.Add(FName(*PathFilter));
        Filter.bRecursivePaths = true;
    }

    TArray<FAssetData> Assets;
    Registry.GetAssets(Filter, Assets);

    TArray<TSharedPtr<FJsonValue>> Results;
    for (const FAssetData& Asset : Assets)
    {
        const FString AssetName = Asset.AssetName.ToString();
        if (!NameFilter.IsEmpty() && !AssetName.Contains(NameFilter)) continue;

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), AssetName);
        Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());
        Entry->SetStringField(TEXT("package"), Asset.PackageName.ToString());

        // The parent class comes from asset-registry tags, so this stays cheap:
        // no blueprint is loaded just to list it.
        FString ParentClass;
        if (Asset.GetTagValue(FBlueprintTags::ParentClassPath, ParentClass))
        {
            Entry->SetStringField(TEXT("parent_class"), ParentClass);
        }
        // The `_C` suffix form is what ui_add_element / ui_create_widget need to
        // reference this blueprint as a class, so hand it over directly.
        Entry->SetStringField(TEXT("class_path"), Asset.GetObjectPathString() + TEXT("_C"));

        Results.Add(MakeShared<FJsonValueObject>(Entry));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("widget_blueprints"), Results);
    Out->SetNumberField(TEXT("count"), Results.Num());
    return FHaybaHandlerResult::Ok(Out);
}

// ── Measurement ─────────────────────────────────────────────────────────────

FHaybaHandlerResult FHaybaMCPUIHandler::HandleMeasureText(const TSharedPtr<FJsonObject>& P)
{
    FString Text;
    if (!P->TryGetStringField(TEXT("text"), Text))
        return FHaybaHandlerResult::Err(TEXT("ui_measure_text: missing text"));

    double AvailableWidth = 0.0;
    P->TryGetNumberField(TEXT("available_width"), AvailableWidth);

    double FontScale = 1.0;
    P->TryGetNumberField(TEXT("font_scale"), FontScale);

    FSlateFontInfo Font;
    bool bHaveFont = false;

    // Either measure against a live widget's real font, or against an explicit
    // font/size pair. The former is what validation uses — measuring with a
    // guessed font would defeat the entire point of measuring.
    FString BPPath, WidgetName;
    if (P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) && !BPPath.IsEmpty() &&
        P->TryGetStringField(TEXT("widget_name"), WidgetName) && !WidgetName.IsEmpty())
    {
        UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
        if (!WBP || !WBP->WidgetTree)
            return FHaybaHandlerResult::Err(TEXT("ui_measure_text: widget blueprint not found"));
        UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
        if (!Widget)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_measure_text: widget '%s' not found"), *WidgetName));
        if (!HaybaUILayout::GetWidgetFont(Widget, Font))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("ui_measure_text: '%s' is a %s, which renders no text and has no font"),
                *WidgetName, *Widget->GetClass()->GetName()));
        bHaveFont = true;

        // Default the available width to the widget's own laid-out box so the
        // common call needs nothing but the blueprint, the widget and the text.
        if (AvailableWidth <= 0.0)
        {
            TMap<FString, FHaybaUIWidgetGeom> Geoms;
            FString LayoutError;
            if (HaybaUILayout::ComputeGeometry(WBP, HaybaUILayout::GetDesignSize(WBP), Geoms, LayoutError))
            {
                if (const FHaybaUIWidgetGeom* G = Geoms.Find(WidgetName))
                {
                    AvailableWidth = G->Size.X;
                }
            }
        }
    }
    else
    {
        FString FontPath;
        double Size = 0.0;
        if (!P->TryGetNumberField(TEXT("font_size"), Size) || Size <= 0.0)
            return FHaybaHandlerResult::Err(TEXT("ui_measure_text: pass either (widget_blueprint_path + widget_name) or (font_size [+ font_asset])"));

        if (P->TryGetStringField(TEXT("font_asset"), FontPath) && !FontPath.IsEmpty())
        {
            UObject* FontObj = LoadObject<UObject>(nullptr, *FontPath);
            if (!FontObj)
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_measure_text: font asset '%s' could not be loaded"), *FontPath));
            if (FontObj->IsA<UFontFace>())
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("ui_measure_text: '%s' is a UFontFace. Slate measures (and renders) text through a composite UFont — pass the UFont asset."),
                    *FontPath));
            Font.FontObject = FontObj;
        }
        else
        {
            // No font given: fall back to the editor's own UI font so the answer
            // is still a real measurement rather than an invented average.
            Font = FCoreStyle::GetDefaultFontStyle("Regular", (int32)Size);
        }
        Font.Size = (float)Size;

        FString Typeface;
        if (P->TryGetStringField(TEXT("typeface"), Typeface) && !Typeface.IsEmpty())
            Font.TypefaceFontName = FName(*Typeface);

        bHaveFont = true;
    }

    if (!bHaveFont)
        return FHaybaHandlerResult::Err(TEXT("ui_measure_text: no font resolved"));

    const FHaybaUITextFit Fit = HaybaUILayout::AnalyzeTextFit(Text, Font, (float)AvailableWidth, (float)FontScale);
    if (!Fit.bValid)
        return FHaybaHandlerResult::Err(TEXT("ui_measure_text: the Slate font measure service is unavailable (headless editor?)"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("text"), Text);
    Out->SetNumberField(TEXT("width_px"), Fit.MeasuredWidth);
    Out->SetNumberField(TEXT("height_px"), Fit.MeasuredHeight);
    Out->SetNumberField(TEXT("available_width_px"), Fit.AvailableWidth);
    Out->SetBoolField(TEXT("overflows"), Fit.bOverflows);
    Out->SetNumberField(TEXT("chars_that_fit"), Fit.CharsThatFit);
    Out->SetNumberField(TEXT("typical_chars_that_fit"), Fit.TypicalChars);
    Out->SetNumberField(TEXT("worst_case_chars_that_fit"), Fit.WorstCaseChars);
    Out->SetNumberField(TEXT("font_size"), Font.Size);
    if (Font.FontObject) Out->SetStringField(TEXT("font_object"), Font.FontObject->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleReportFindings(const TSharedPtr<FJsonObject>& P)
{
    // Deliberately a pass-through that only validates shape: the judging lives
    // MCP-side so rules can change without a plugin rebuild, and this command
    // exists purely so those findings can reach the editor's Validation panel.
    // The actual push happens in the command handler's post-dispatch hook,
    // which is where every other panel-feeding command is wired.
    const TArray<TSharedPtr<FJsonValue>>* FindingsArr = nullptr;
    if (!P->TryGetArrayField(TEXT("findings"), FindingsArr) || !FindingsArr)
        return FHaybaHandlerResult::Err(TEXT("ui_report_findings: missing findings array"));

    int32 Errors = 0, Warnings = 0, Infos = 0;
    for (const auto& V : *FindingsArr)
    {
        const TSharedPtr<FJsonObject> F = V->AsObject();
        if (!F.IsValid()) continue;
        FString Severity;
        F->TryGetStringField(TEXT("severity"), Severity);
        if (Severity.Equals(TEXT("error"), ESearchCase::IgnoreCase)) ++Errors;
        else if (Severity.Equals(TEXT("warning"), ESearchCase::IgnoreCase)) ++Warnings;
        else ++Infos;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("received"), FindingsArr->Num());
    Out->SetNumberField(TEXT("errors"), Errors);
    Out->SetNumberField(TEXT("warnings"), Warnings);
    Out->SetNumberField(TEXT("infos"), Infos);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPUIHandler::HandleLayoutSnapshot(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_layout_snapshot: missing widget_blueprint_path"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_layout_snapshot: widget blueprint not found"));

    FVector2D ScreenSize = HaybaUILayout::GetDesignSize(WBP);
    double W = 0.0, H = 0.0;
    if (P->TryGetNumberField(TEXT("screen_width"), W) && W > 0.0)  ScreenSize.X = W;
    if (P->TryGetNumberField(TEXT("screen_height"), H) && H > 0.0) ScreenSize.Y = H;

    TMap<FString, FHaybaUIWidgetGeom> Geoms;
    FString LayoutError;
    const bool bHaveLayout = HaybaUILayout::ComputeGeometry(WBP, ScreenSize, Geoms, LayoutError);

    TArray<TSharedPtr<FJsonValue>> Widgets;

    WBP->WidgetTree->ForEachWidget([&](UWidget* Widget)
    {
        if (!Widget) return;

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Widget->GetName());
        Entry->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
        Entry->SetStringField(TEXT("parent"), Widget->GetParent() ? Widget->GetParent()->GetName() : FString());
        Entry->SetStringField(TEXT("slot_class"), ResolveSlotType(Widget));
        Entry->SetBoolField(TEXT("is_panel"), Widget->IsA<UPanelWidget>());
        Entry->SetBoolField(TEXT("is_variable"), Widget->bIsVariable);
        Entry->SetStringField(TEXT("visibility"), UEnum::GetValueAsString(Widget->GetVisibility()));
        Entry->SetNumberField(TEXT("render_opacity"), Widget->GetRenderOpacity());
        Entry->SetBoolField(TEXT("is_enabled"), Widget->GetIsEnabled());

        // Interactivity is what most input/accessibility rules key off, and it
        // is not derivable from the class name alone on the MCP side.
        const bool bInteractive =
            Widget->IsA<UButton>() || Widget->IsA<UCheckBox>() || Widget->IsA<USlider>() ||
            Widget->IsA<USpinBox>() || Widget->IsA<UComboBoxString>() || Widget->IsA<UEditableText>() ||
            Widget->IsA<UEditableTextBox>() || Widget->IsA<UMultiLineEditableTextBox>();
        Entry->SetBoolField(TEXT("is_interactive"), bInteractive);
        Entry->SetBoolField(TEXT("is_focusable"), ResolveIsFocusable(Widget));

        if (const FHaybaUIWidgetGeom* G = Geoms.Find(Widget->GetName()))
        {
            Entry->SetNumberField(TEXT("x"), G->Position.X);
            Entry->SetNumberField(TEXT("y"), G->Position.Y);
            Entry->SetNumberField(TEXT("width"), G->Size.X);
            Entry->SetNumberField(TEXT("height"), G->Size.Y);
            Entry->SetNumberField(TEXT("depth"), G->Depth);
            Entry->SetBoolField(TEXT("laid_out"), !G->IsDegenerate());
        }
        else
        {
            Entry->SetBoolField(TEXT("laid_out"), false);
        }

        if (UCanvasPanelSlot* CSlot = Cast<UCanvasPanelSlot>(Widget->Slot))
        {
            const FAnchors A = CSlot->GetAnchors();
            TSharedPtr<FJsonObject> Anch = MakeShared<FJsonObject>();
            Anch->SetNumberField(TEXT("min_x"), A.Minimum.X);
            Anch->SetNumberField(TEXT("min_y"), A.Minimum.Y);
            Anch->SetNumberField(TEXT("max_x"), A.Maximum.X);
            Anch->SetNumberField(TEXT("max_y"), A.Maximum.Y);
            Entry->SetObjectField(TEXT("anchors"), Anch);
            Entry->SetNumberField(TEXT("z_order"), CSlot->GetZOrder());
            Entry->SetBoolField(TEXT("auto_size"), CSlot->GetAutoSize());
        }

        // Text facts, including the measurement that only Slate can do.
        FString Text;
        FSlateFontInfo Font;
        const bool bHasText = HaybaUILayout::GetWidgetText(Widget, Text);
        const bool bHasFont = HaybaUILayout::GetWidgetFont(Widget, Font);

        if (bHasText || bHasFont)
        {
            TSharedPtr<FJsonObject> TextObj = MakeShared<FJsonObject>();
            if (bHasText) TextObj->SetStringField(TEXT("text"), Text);
            if (bHasFont)
            {
                TextObj->SetNumberField(TEXT("font_size"), Font.Size);
                TextObj->SetStringField(TEXT("typeface"), Font.TypefaceFontName.ToString());
                if (Font.FontObject)
                {
                    TextObj->SetStringField(TEXT("font_object"), Font.FontObject->GetPathName());
                    TextObj->SetBoolField(TEXT("font_is_font_face"), Font.FontObject->IsA<UFontFace>());
                }
                else
                {
                    TextObj->SetBoolField(TEXT("font_is_font_face"), false);
                }

                float AvailableWidth = 0.f;
                if (const FHaybaUIWidgetGeom* G = Geoms.Find(Widget->GetName()))
                {
                    AvailableWidth = (float)G->Size.X;
                }
                if (bHasText && AvailableWidth > 0.f)
                {
                    const FHaybaUITextFit Fit = HaybaUILayout::AnalyzeTextFit(Text, Font, AvailableWidth);
                    if (Fit.bValid)
                    {
                        TextObj->SetNumberField(TEXT("measured_width"), Fit.MeasuredWidth);
                        TextObj->SetNumberField(TEXT("measured_height"), Fit.MeasuredHeight);
                        TextObj->SetNumberField(TEXT("available_width"), Fit.AvailableWidth);
                        TextObj->SetBoolField(TEXT("overflows"), Fit.bOverflows);
                        TextObj->SetNumberField(TEXT("chars_that_fit"), Fit.CharsThatFit);
                        TextObj->SetNumberField(TEXT("typical_chars_that_fit"), Fit.TypicalChars);
                        TextObj->SetNumberField(TEXT("worst_case_chars_that_fit"), Fit.WorstCaseChars);
                    }
                }
            }

            if (UTextBlock* TB = Cast<UTextBlock>(Widget))
            {
                TextObj->SetBoolField(TEXT("auto_wrap"), TB->GetAutoWrapText());
                const FLinearColor C = TB->GetColorAndOpacity().GetSpecifiedColor();
                TArray<TSharedPtr<FJsonValue>> ColorArr;
                ColorArr.Add(MakeShared<FJsonValueNumber>(C.R));
                ColorArr.Add(MakeShared<FJsonValueNumber>(C.G));
                ColorArr.Add(MakeShared<FJsonValueNumber>(C.B));
                ColorArr.Add(MakeShared<FJsonValueNumber>(C.A));
                TextObj->SetArrayField(TEXT("color"), ColorArr);
            }
            Entry->SetObjectField(TEXT("text_info"), TextObj);
        }

        // Brush facts for the fill/contrast rules.
        if (UImage* Img = Cast<UImage>(Widget))
        {
            TSharedPtr<FJsonObject> BrushObj = MakeShared<FJsonObject>();
            const FSlateBrush& B = Img->GetBrush();
            BrushObj->SetBoolField(TEXT("has_resource"), B.GetResourceObject() != nullptr);
            if (B.GetResourceObject()) BrushObj->SetStringField(TEXT("resource"), B.GetResourceObject()->GetPathName());
            const FLinearColor Tint = Img->GetColorAndOpacity();
            TArray<TSharedPtr<FJsonValue>> TintArr;
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.R));
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.G));
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.B));
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.A));
            BrushObj->SetArrayField(TEXT("tint"), TintArr);
            BrushObj->SetNumberField(TEXT("image_size_x"), B.ImageSize.X);
            BrushObj->SetNumberField(TEXT("image_size_y"), B.ImageSize.Y);
            Entry->SetObjectField(TEXT("brush_info"), BrushObj);
        }
        if (UBorder* Bd = Cast<UBorder>(Widget))
        {
            TSharedPtr<FJsonObject> BrushObj = MakeShared<FJsonObject>();
            const FLinearColor Tint = Bd->GetBrushColor();
            TArray<TSharedPtr<FJsonValue>> TintArr;
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.R));
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.G));
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.B));
            TintArr.Add(MakeShared<FJsonValueNumber>(Tint.A));
            BrushObj->SetArrayField(TEXT("tint"), TintArr);
            // A Border's own brush is reached through the reflection system
            // rather than the member: UMG moved these properties behind
            // accessors, and the member is not public in current engine
            // versions. The contrast rules only need the tint, so a missing
            // brush here degrades to "no resource" rather than failing.
            bool bHasResource = false;
            if (FStructProperty* BgProp = CastField<FStructProperty>(Bd->GetClass()->FindPropertyByName(TEXT("Background"))))
            {
                if (BgProp->Struct == TBaseStructure<FSlateBrush>::Get() ||
                    BgProp->Struct->GetName() == TEXT("SlateBrush"))
                {
                    const FSlateBrush* Brush = BgProp->ContainerPtrToValuePtr<FSlateBrush>(Bd);
                    bHasResource = Brush && Brush->GetResourceObject() != nullptr;
                }
            }
            BrushObj->SetBoolField(TEXT("has_resource"), bHasResource);
            Entry->SetObjectField(TEXT("brush_info"), BrushObj);
        }

        if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
        {
            Entry->SetNumberField(TEXT("child_count"), Panel->GetChildrenCount());
        }

        Widgets.Add(MakeShared<FJsonValueObject>(Entry));
    });

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_blueprint_path"), WBP->GetPathName());
    Out->SetNumberField(TEXT("screen_width"), ScreenSize.X);
    Out->SetNumberField(TEXT("screen_height"), ScreenSize.Y);
    Out->SetBoolField(TEXT("layout_resolved"), bHaveLayout);
    // Callers MUST be able to tell "no problems found" from "could not measure".
    // Rules that depend on geometry are skipped, not passed, when this is set.
    if (!bHaveLayout) Out->SetStringField(TEXT("layout_error"), LayoutError);
    Out->SetNumberField(TEXT("widget_count"), Widgets.Num());
    Out->SetArrayField(TEXT("widgets"), Widgets);
    return FHaybaHandlerResult::Ok(Out);
}

#endif // WITH_EDITOR
