#include "HaybaMCPUIHandler.h"
#include "HaybaUIOps.h"
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
#include "HaybaMCPAssetGuard.h"
#include "HaybaMCPSaveVerify.h"
#include "HaybaMCPReflection.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPUILayout.h"
// ui_render_widget_to_png — off-screen widget rendering.
#include "Slate/WidgetRenderer.h"
#include "Engine/TextureRenderTarget2D.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"
#include "RenderingThread.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPUI, Log, All);

#if WITH_EDITOR

static TArray<TSharedPtr<FJsonValue>> HaybaColorArray(const FLinearColor& C)
{
    TArray<TSharedPtr<FJsonValue>> Arr;
    Arr.Add(MakeShared<FJsonValueNumber>(C.R));
    Arr.Add(MakeShared<FJsonValueNumber>(C.G));
    Arr.Add(MakeShared<FJsonValueNumber>(C.B));
    Arr.Add(MakeShared<FJsonValueNumber>(C.A));
    return Arr;
}

/** Engine name for a brush draw type, matching what ui_set_brush accepts. */
static FString HaybaDrawTypeName(ESlateBrushDrawType::Type T)
{
    switch (T)
    {
    case ESlateBrushDrawType::NoDrawType: return TEXT("NoDrawType");
    case ESlateBrushDrawType::Box:        return TEXT("Box");
    case ESlateBrushDrawType::Border:     return TEXT("Border");
    case ESlateBrushDrawType::Image:      return TEXT("Image");
    case ESlateBrushDrawType::RoundedBox: return TEXT("RoundedBox");
    default:                              return TEXT("Unknown");
    }
}

static FString HaybaTilingName(ESlateBrushTileType::Type T)
{
    switch (T)
    {
    case ESlateBrushTileType::NoTile:     return TEXT("NoTile");
    case ESlateBrushTileType::Horizontal: return TEXT("Horizontal");
    case ESlateBrushTileType::Vertical:   return TEXT("Vertical");
    case ESlateBrushTileType::Both:       return TEXT("Both");
    default:                              return TEXT("Unknown");
    }
}

/**
 * Everything about a brush that distinguishes it from another brush.
 *
 * The point is answering "what is the working panel doing that mine is not".
 * draw_as and margin are the load-bearing pair: a frame material drawn as Box
 * with a fractional margin looks completely different from the same material
 * drawn as Image, and neither the widget tree nor the old brush_info showed
 * either of them.
 */
static TSharedPtr<FJsonObject> HaybaDescribeBrush(const FSlateBrush& B)
{
    TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();

    O->SetStringField(TEXT("draw_as"), HaybaDrawTypeName(B.DrawAs));
    O->SetStringField(TEXT("tiling"), HaybaTilingName(B.Tiling));

    UObject* Res = B.GetResourceObject();
    O->SetBoolField(TEXT("has_resource"), Res != nullptr);
    if (Res)
    {
        O->SetStringField(TEXT("resource"), Res->GetPathName());
        // Material vs texture matters: a material brush must be assigned with
        // SetBrushFromMaterial, and hand-building an FSlateBrush around one
        // renders black.
        O->SetStringField(TEXT("resource_class"), Res->GetClass()->GetName());
    }

    TArray<TSharedPtr<FJsonValue>> MarginArr;
    MarginArr.Add(MakeShared<FJsonValueNumber>(B.Margin.Left));
    MarginArr.Add(MakeShared<FJsonValueNumber>(B.Margin.Top));
    MarginArr.Add(MakeShared<FJsonValueNumber>(B.Margin.Right));
    MarginArr.Add(MakeShared<FJsonValueNumber>(B.Margin.Bottom));
    O->SetArrayField(TEXT("margin"), MarginArr);

    O->SetNumberField(TEXT("image_size_x"), B.ImageSize.X);
    O->SetNumberField(TEXT("image_size_y"), B.ImageSize.Y);
    O->SetArrayField(TEXT("brush_tint"), HaybaColorArray(B.TintColor.GetSpecifiedColor()));

    if (B.DrawAs == ESlateBrushDrawType::RoundedBox)
    {
        TSharedPtr<FJsonObject> R = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> Radii;
        Radii.Add(MakeShared<FJsonValueNumber>(B.OutlineSettings.CornerRadii.X));
        Radii.Add(MakeShared<FJsonValueNumber>(B.OutlineSettings.CornerRadii.Y));
        Radii.Add(MakeShared<FJsonValueNumber>(B.OutlineSettings.CornerRadii.Z));
        Radii.Add(MakeShared<FJsonValueNumber>(B.OutlineSettings.CornerRadii.W));
        R->SetArrayField(TEXT("corner_radii"), Radii);
        R->SetNumberField(TEXT("width"), B.OutlineSettings.Width);
        R->SetArrayField(TEXT("color"), HaybaColorArray(B.OutlineSettings.Color.GetSpecifiedColor()));
        O->SetObjectField(TEXT("outline"), R);
    }

    return O;
}

/** Read an FSlateBrush property off a widget by name, or null when the widget
 *  has no such property (or it is not a brush). */
static const FSlateBrush* HaybaFindBrushProperty(UObject* Owner, const TCHAR* PropName)
{
    if (!Owner) return nullptr;
    FStructProperty* Prop = CastField<FStructProperty>(Owner->GetClass()->FindPropertyByName(FName(PropName)));
    if (!Prop) return nullptr;
    if (Prop->Struct != TBaseStructure<FSlateBrush>::Get() && Prop->Struct->GetName() != TEXT("SlateBrush"))
        return nullptr;
    return Prop->ContainerPtrToValuePtr<FSlateBrush>(Owner);
}

#endif // WITH_EDITOR

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
        TEXT("ui_bind_property"),
        TEXT("ui_list_widget_blueprints"),
        TEXT("ui_layout_snapshot"),
        TEXT("ui_measure_text"),
        TEXT("ui_report_findings"),
        TEXT("ui_render_widget_to_png"),
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
            if (PropName == TEXT("Slot")) continue;   // owned by the parent panel
            // A panel's Slots array holds pointers to slot objects whose Content
            // points at the SOURCE's children. Copying it makes two widgets claim
            // the same children, which is a corrupt tree rather than a copy.
            // Children are rebuilt explicitly by the caller instead.
            if (PropName == TEXT("Slots")) continue;
            // Structural links on a UPanelSlot. Copying these is what made a
            // duplicated subtree adopt the ORIGINAL's widgets: the new slot's
            // Content was overwritten with a pointer to the source's child, so
            // the tree showed one widget reached through two slots — two entries
            // with the same name AND the same object path. Layout values are the
            // only thing worth copying between slots; who they point at is set
            // by AddChild and must survive.
            if (PropName == TEXT("Content")) continue;
            if (PropName == TEXT("Parent")) continue;

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

    /** Recursively clone a widget and its children into `WBP`'s widget tree.
     *
     *  DuplicateObject cannot do this. A UPanelSlot's Content is a plain pointer
     *  to a widget owned by the WidgetTree, not a subobject of the panel, so
     *  duplication copies the POINTER: the "copy" ends up sharing the original's
     *  children, and renaming the copy's subtree renames the original's widgets
     *  out from under the blueprint. That was observable as two widgets with the
     *  same name and a child that had silently moved.
     *
     *  So the tree is rebuilt node by node: construct a widget of the same class,
     *  copy its properties, then recurse and re-parent, copying each slot's
     *  layout across as we go. Every widget produced is genuinely new.
     *
     *  Returns nullptr if construction fails at any level. */
    UWidget* DeepCloneWidget(UWidgetBlueprint* WBP, UWidget* Source, FName DesiredName, int32 Depth = 0)
    {
        if (!WBP || !WBP->WidgetTree || !Source) return nullptr;
        if (Depth > 64) return nullptr;  // defensive: a cycle would never terminate

        UClass* Cls = Source->GetClass();
        const FName Name = DesiredName.IsNone()
            ? MakeUniqueObjectName(WBP->WidgetTree, Cls, Source->GetFName())
            : DesiredName;

        UWidget* New = WBP->WidgetTree->ConstructWidget<UWidget>(Cls, Name);
        if (!New) return nullptr;

        CopyCommonProperties(Source, New);

        if (UPanelWidget* SrcPanel = Cast<UPanelWidget>(Source))
        {
            UPanelWidget* NewPanel = Cast<UPanelWidget>(New);
            if (NewPanel)
            {
                for (int32 i = 0; i < SrcPanel->GetChildrenCount(); ++i)
                {
                    UWidget* SrcChild = SrcPanel->GetChildAt(i);
                    if (!SrcChild) continue;

                    UWidget* NewChild = DeepCloneWidget(WBP, SrcChild, NAME_None, Depth + 1);
                    if (!NewChild) continue;

                    UPanelSlot* NewSlot = NewPanel->AddChild(NewChild);
                    if (NewSlot && SrcChild->Slot && NewSlot->GetClass() == SrcChild->Slot->GetClass())
                    {
                        CopyCommonProperties(SrcChild->Slot, NewSlot);
                        NewSlot->SynchronizeProperties();
                    }
                }
            }
        }

        return New;
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
     *  as [x,y] pairs (which is what the typed slot-layout tool sends).
     *
     *  Mutates `Anchors` in place and reports whether anything was set. The
     *  caller owns the surrounding FAnchorData and commits it ONCE via
     *  UCanvasPanelSlot::SetLayout — this function deliberately never touches
     *  the slot, so anchors can no longer be written through a different path
     *  than position/alignment. */
    static bool TryApplyAnchors(const TSharedPtr<FJsonObject>& Props, FAnchors& Anchors)
    {
        bool bChanged = false;

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
            // ONE FAnchorData, ONE commit. The previous code pushed anchors,
            // position, size and alignment through four separate setters
            // (SetAnchors / SetOffsets / SetPosition / SetSize / SetAlignment).
            // Each of those reads its baseline through the slot's GETTERS,
            // which prefer the live Slate slot over the serialized LayoutData
            // whenever a preview is attached — so a value could be read from
            // one place, modified, and written through another, and anchors in
            // particular could be rebuilt from a stale copy. Field report
            // (2026-07/08, Aphrosia): ui_set_slot_layout anchors were a silent
            // no-op and the working workaround was object_set_property with a
            // full LayoutData literal on the slot. This is that workaround made
            // first-class: build the complete FAnchorData from the serialized
            // layout (GetLayout reads LayoutData, never Slate) and commit it
            // atomically via SetLayout, which writes LayoutData and pushes
            // offsets + anchors + alignment to any live slot in one step.
            FAnchorData Layout = CSlot->GetLayout();
            bool bLayoutChanged = TryApplyAnchors(Props, Layout.Anchors);

            double OffX, OffY, OffW, OffH;
            const bool bHasOffX = Props->TryGetNumberField(TEXT("x"), OffX);
            const bool bHasOffY = Props->TryGetNumberField(TEXT("y"), OffY);
            const bool bHasOffW = Props->TryGetNumberField(TEXT("w"), OffW);
            const bool bHasOffH = Props->TryGetNumberField(TEXT("h"), OffH);
            if (bHasOffX) { Layout.Offsets.Left   = OffX; bLayoutChanged = true; }
            if (bHasOffY) { Layout.Offsets.Top    = OffY; bLayoutChanged = true; }
            if (bHasOffW) { Layout.Offsets.Right  = OffW; bLayoutChanged = true; }
            if (bHasOffH) { Layout.Offsets.Bottom = OffH; bLayoutChanged = true; }

            // HasField (not "is non-zero") so a caller CAN move a widget back to
            // the origin or collapse it to zero size. position/size mirror the
            // engine's own SetPosition/SetSize: Left/Top and Right/Bottom of
            // the offsets — under stretched anchors Right/Bottom are margins,
            // not a size, exactly as in the designer.
            if (Props->HasField(TEXT("position")))
            {
                const FVector2D Pos = ParseVec2(Props, TEXT("position"));
                Layout.Offsets.Left = Pos.X;
                Layout.Offsets.Top  = Pos.Y;
                bLayoutChanged = true;
            }
            if (Props->HasField(TEXT("size")))
            {
                const FVector2D Sz = ParseVec2(Props, TEXT("size"));
                Layout.Offsets.Right  = Sz.X;
                Layout.Offsets.Bottom = Sz.Y;
                bLayoutChanged = true;
            }
            if (Props->HasField(TEXT("alignment")))
            {
                Layout.Alignment = ParseVec2(Props, TEXT("alignment"));
                bLayoutChanged = true;
            }

            if (bLayoutChanged) CSlot->SetLayout(Layout);

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
        // Full object path. Display names can repeat in a malformed tree, and
        // two entries showing one name is ambiguous between "two widgets" and
        // "one widget reached through two slots" — the path distinguishes them.
        Out->SetStringField(TEXT("object_path"), W->GetPathName());

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

    /** Save and verify against the file system. See HaybaMCPSaveVerify.h — the
     *  previous version returned a bare bool and the caller then inferred
     *  success from IsDirty(), which answers a different question and reported
     *  false on saves that had in fact reached disk. */
    HaybaSaveVerify::FResult SaveWidgetPackage(UWidgetBlueprint* WBP)
    {
        if (!WBP) return HaybaSaveVerify::FResult{};
        WBP->MarkPackageDirty();
        return HaybaSaveVerify::SaveAndVerify(WBP);
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
    if (Cmd == TEXT("ui_bind_property"))       return HandleBindProperty(P);
    if (Cmd == TEXT("ui_list_widget_blueprints")) return HandleListWidgetBlueprints(P);
    if (Cmd == TEXT("ui_layout_snapshot"))     return HandleLayoutSnapshot(P);
    if (Cmd == TEXT("ui_measure_text"))        return HandleMeasureText(P);
    if (Cmd == TEXT("ui_report_findings"))     return HandleReportFindings(P);
    if (Cmd == TEXT("ui_render_widget_to_png")) return HandleRenderToPng(P);

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

    // Refuse a taken name instead of letting CreateAsset raise a modal overwrite
    // dialog, which would block the game thread and hang every queued MCP
    // request. See HaybaMCPAssetGuard.h for why this is worth guarding.
    if (HaybaAssetGuard::AssetNameTaken(PkgPath, AssetName))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("ui_create_widget"), PkgPath, AssetName));
    }

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
    // 1. Parse — pure, no editor. Everything the wire format decides (which
    //    fields are required, which of three spellings the slot payload used,
    //    whether there is a single key to apply) is settled before anything is
    //    loaded, and every problem is reported in one message. See HaybaUIOps.h.
    FHaybaParamReader R(P, TEXT("ui_set_widget_properties"));
    const HaybaUIOps::FSetPropertiesRequest Req = HaybaUIOps::ParseSetProperties(R);
    if (R.HasErrors())
        return FHaybaHandlerResult::Err(R.ErrorMessage());

    const FString& WidgetName = Req.WidgetName;
    const TSharedPtr<FJsonObject> SlotPropsObj = Req.Slot.Object;

    // 2. Execute — needs the editor.
    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *Req.BlueprintPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_set_widget_properties: widget blueprint not found"));

    UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
    if (!Widget)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_set_widget_properties: widget '%s' not found"), *WidgetName));

    HaybaUIOps::FSetPropertiesResult Result;
    Result.WidgetName   = WidgetName;
    Result.SlotSpelling = Req.Slot.Spelling;

    // References, not copies: the block below writes straight into Result, which
    // is the only thing the reply is built from.
    int32& Succeeded = Result.Succeeded;
    int32& Failed = Result.Failed;
    TArray<FString>& FailedProps = Result.FailedProps;
    TArray<FString>& UnknownSlotProps = Result.UnknownSlotProps;
    TArray<FString>& Warnings = Result.Warnings;
    {
        // No FScopedTransaction: these are automation-tool edits with no undo/redo
        // requirement, and the global editor transaction buffer (GEditor->Trans) can
        // end up retaining a reference into a PIE session, crashing the editor on PIE
        // stop with "Object 'GameInstance ...' from PIE level still referenced".
        WBP->Modify();
        Widget->Modify();

        if (Req.Properties.IsValid())
        {
            for (const auto& Pair : Req.Properties->Values)
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

        if (SlotPropsObj.IsValid())
        {
            if (!Widget->Slot)
            {
                // The root widget has no slot at all. Reporting the keys as
                // applied here would be a flat lie.
                for (const auto& Pair : SlotPropsObj->Values)
                {
                    ++Failed;
                    FailedProps.Add(HaybaUIOps::SlotKeyName(FString(Pair.Key)));
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
                const FSlotApplyResult SlotResult = ApplySlotPropsChecked(Widget->Slot, SlotPropsObj);
                Widget->Slot->PostEditChange();

                // Count what actually landed. The previous code incremented the
                // success counter once per submitted key regardless of whether
                // the slot understood it.
                Succeeded += SlotResult.Applied.Num();
                Failed += SlotResult.Unknown.Num();
                for (const FString& Key : SlotResult.Unknown)
                {
                    UnknownSlotProps.Add(Key);
                    FailedProps.Add(HaybaUIOps::SlotKeyName(Key));
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

    // 3. Shape — pure.
    if (Result.AppliedNothing())
    {
        return FHaybaHandlerResult::Err(HaybaUIOps::NothingAppliedError(Result));
    }

    return FHaybaHandlerResult::Ok(HaybaUIOps::ShapeSetProperties(Result));
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
            Entry->SetStringField(TEXT("object_path"), Widget->GetPathName());
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

            // Collect BEFORE detaching (the subtree walk needs the links), but purge AFTER.
            // WidgetBlueprintCompiler requires a GUID for EVERY source widget, not just the
            // ones marked Is Variable, so a widget that is still in the tree with its GUID
            // already dropped trips "was added but did not get a GUID".
            TArray<UWidget*> Doomed;
            CollectSubtree(Widget, Doomed);

            // Detach the widget objects from the tree as well; RemoveChild only
            // unlinks from the panel, leaving the widgets owned by the tree.
            WBP->WidgetTree->RemoveWidget(Widget);

            for (UWidget* W : Doomed)
            {
                if (W) WBP->WidgetVariableNameToGuidMap.Remove(W->GetFName());
            }

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
        // Rebuild the subtree rather than duplicating it. See DeepCloneWidget:
        // DuplicateObject leaves the copy pointing at the ORIGINAL's children,
        // because a slot's Content is a plain pointer rather than a subobject.
        // Two earlier attempts to fix that by renaming after the fact were
        // treating the symptom — the copy and the original genuinely shared
        // widgets, so renaming "the copy's" subtree renamed the original's.
        const FName RootName = NewName.IsEmpty()
            ? MakeUniqueObjectName(WBP->WidgetTree, Source->GetClass(), Source->GetFName())
            : FName(*NewName);

        UWidget* Copy = DeepCloneWidget(WBP, Source, RootName);
        if (!Copy)
            return FHaybaHandlerResult::Err(TEXT("ui_mutate_tree duplicate: could not clone the widget subtree"));

        TArray<FString> RenameFallbacks;
        if (Copy->GetFName() != RootName)
        {
            RenameFallbacks.Add(FString::Printf(
                TEXT("wanted \"%s\", got \"%s\""), *RootName.ToString(), *Copy->GetName()));
        }

        // Stage capture. Two rounds of fixes were spent guessing WHICH call
        // trashes the copy; recording the name at each step answers it in one
        // build instead.
        const FString NameAfterClone = Copy->GetName();

        UPanelSlot* NewSlot = TargetParent->AddChild(Copy);
        if (!NewSlot)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("ui_mutate_tree duplicate: '%s' refused the child (panel is full)"), *TargetParent->GetName()));

        const FString NameAfterAddChild = Copy->GetName();

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

        // Structural, like every other tree mutation here.
        //
        // A stage trace showed the copy surviving the clone and AddChild, then
        // becoming TRASH_ across this call — which looked like the recompile was
        // at fault. It was not. The copy was ORPHANED (its parent slot pointed
        // at the source's child, because slot Content was being copied), and the
        // recompile simply collected a widget nothing referenced. Fixing the
        // slot pointers made it reachable, and it now survives compilation like
        // every other widget these tools create.
        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();

        {
            TSharedPtr<FJsonObject> Stages = MakeShared<FJsonObject>();
            Stages->SetStringField(TEXT("after_clone"), NameAfterClone);
            Stages->SetStringField(TEXT("after_add_child"), NameAfterAddChild);
            Stages->SetStringField(TEXT("final"), Copy->GetName());
            Stages->SetStringField(TEXT("object_path"), Copy->GetPathName());
            Out->SetObjectField(TEXT("name_stages"), Stages);
        }

        Out->SetStringField(TEXT("source"), WidgetName);
        Out->SetStringField(TEXT("name"), Copy->GetName());
        Out->SetStringField(TEXT("parent"), TargetParent->GetName());
        Out->SetNumberField(TEXT("widgets_duplicated"), Subtree.Num());

        // Post-condition check. Two rounds of fixes have improved this path
        // without fully settling it: the clone no longer corrupts the ORIGINAL's
        // subtree, but the copy can still come back trashed or sharing a name
        // with its source. Rather than return ok on a tree that is wrong, verify
        // what actually landed and say so.
        //
        // This is deliberately a hard error. A silently mis-shaped widget tree is
        // the expensive kind of failure — it surfaces later as a binding that
        // cannot resolve, with nothing pointing back at the call that caused it.
        {
            const FString FinalName = Copy->GetName();
            TArray<FString> Defects;

            if (FinalName.StartsWith(TEXT("TRASH_")))
            {
                Defects.Add(FString::Printf(
                    TEXT("the copy was trashed by the engine and is named \"%s\""), *FinalName));
            }
            if (!NewName.IsEmpty() && FinalName != NewName)
            {
                Defects.Add(FString::Printf(
                    TEXT("asked for \"%s\" but the copy is named \"%s\""), *NewName, *FinalName));
            }

            // Two widgets answering to one name means later lookups are
            // ambiguous, which is how the original corruption presented.
            TMap<FString, int32> NameCounts;
            WBP->WidgetTree->ForEachWidget([&NameCounts](UWidget* W)
            {
                if (W) NameCounts.FindOrAdd(W->GetName())++;
            });
            for (const auto& Pair : NameCounts)
            {
                if (Pair.Value > 1)
                {
                    Defects.Add(FString::Printf(
                        TEXT("%d widgets now share the name \"%s\""), Pair.Value, *Pair.Key));
                }
            }

            if (Defects.Num() > 0)
            {
                // Carry the stage trace in the error itself. The success payload
                // is discarded on this path, and the whole point of recording
                // where the name changed is to know WHICH call broke it.
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("ui_mutate_tree duplicate: the copy did not come out clean — %s. ")
                    TEXT("Name by stage: after_clone=\"%s\" after_add_child=\"%s\" final=\"%s\". ")
                    TEXT("The blueprint has NOT been saved; discard the change by reloading the asset. ")
                    TEXT("Build the widget explicitly with ui_build_tree instead."),
                    *FString::Join(Defects, TEXT("; ")),
                    *NameAfterClone, *NameAfterAddChild, *Copy->GetName()));
            }
        }

        if (RenameFallbacks.Num() > 0)
        {
            TArray<TSharedPtr<FJsonValue>> Arr;
            for (const FString& R : RenameFallbacks) Arr.Add(MakeShared<FJsonValueString>(R));
            Out->SetArrayField(TEXT("rename_fallbacks"), Arr);
        }
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

    HaybaSaveVerify::FResult SaveResult;
    bool bAttemptedSave = false;
    if (bSaveOnSuccess && CR.bSuccess)
    {
        bAttemptedSave = true;
        SaveResult = SaveWidgetPackage(WBP);
        if (!SaveResult.DidReachDisk())
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("ui_compile_widget: compile succeeded but the change did not reach disk. %s"),
                *SaveResult.Note));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("success"), CR.bSuccess);
    Out->SetStringField(TEXT("status"), CR.Status);
    if (bAttemptedSave) HaybaSaveVerify::Describe(SaveResult, Out);

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

    const HaybaSaveVerify::FResult SaveResult = SaveWidgetPackage(WBP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("saved_path"), WBP->GetPathName());
    HaybaSaveVerify::Describe(SaveResult, Out);

    // `saved` comes from the file system, not from the dirty flag. A caller
    // about to restart the editor needs a straight answer to "is my work on
    // disk", and inferring it from IsDirty() gave the wrong one.
    if (!SaveResult.DidReachDisk())
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("ui_save_widget: %s did not reach disk. %s"),
            *WBP->GetPathName(), *SaveResult.Note));
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
            if (R.Unknown.Num() > 0)
            {
                // A slot key is LAYOUT-CRITICAL: ignoring one does not degrade
                // the result, it changes it. This used to warn and build the
                // tree anyway, so a misspelled key (`size_rule`, which is what
                // the UMG details panel calls it) produced 17 warnings, a
                // reported `created: 26`, and a ScrollBox that sized to content
                // instead of filling its parent — discovered much later, in a
                // layout snapshot. Silent-but-wrong layout is worse than a
                // failed call.
                TArray<FString> Valid = ApplicableSlotKeys(Slot).Array();
                Valid.Sort();
                return FString::Printf(
                    TEXT("ui_build_tree: '%s' — slot key%s %s not valid for a %s. Valid keys for that slot: %s. ")
                    TEXT("Nothing was built; fix the key and call again."),
                    *New->GetName(),
                    R.Unknown.Num() == 1 ? TEXT("") : TEXT("s"),
                    *FString::Join(R.Unknown, TEXT(", ")),
                    *Slot->GetClass()->GetName(),
                    Valid.Num() > 0 ? *FString::Join(Valid, TEXT(", ")) : TEXT("(none)"));
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

    // A failed build leaves nothing behind. Aborting halfway used to hand back
    // a partial tree with an error, which is the worst of both: the call failed
    // AND the blueprint changed, so a retry stacks a second partial tree on top
    // of the first. Remove what this call created, newest first so parents go
    // after their children.
    int32 RolledBack = 0;
    if (!Error.IsEmpty() && Stats.Names.Num() > 0)
    {
        for (int32 i = Stats.Names.Num() - 1; i >= 0; --i)
        {
            if (UWidget* Created = FindWidgetByName(WBP->WidgetTree, Stats.Names[i]))
            {
                WBP->WidgetTree->RemoveWidget(Created);
                ++RolledBack;
            }
        }
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
        // Partial builds USED to be kept, on the reasoning that the widgets
        // which landed are usually the ones the caller wanted. Reversed
        // deliberately: the caller's next move after a failed build is to fix
        // the spec and call again, and a retry on top of a kept partial stacks
        // a SECOND copy of everything that succeeded the first time. A field
        // session hit exactly that shape from the other direction — a tree
        // mutation that timed out after succeeding, where the natural retry was
        // the dangerous act. Failing clean is the only answer that makes retry
        // safe, which is the operation a failure invites.
        Out->SetStringField(TEXT("error"), Error);
        Out->SetBoolField(TEXT("partial"), false);
        Out->SetNumberField(TEXT("rolled_back"), RolledBack);
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("%s%s"),
            *Error,
            RolledBack > 0
                ? *FString::Printf(TEXT(" %d widget(s) created before the failure were removed, so the blueprint "
                                        "is as it was and a corrected call will not duplicate them."), RolledBack)
                : TEXT("")));
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

FHaybaHandlerResult FHaybaMCPUIHandler::HandleBindProperty(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath, WidgetName, PropertyName, VariableName;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_bind_property: missing widget_blueprint_path"));
    if (!P->TryGetStringField(TEXT("widget_name"), WidgetName) || WidgetName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_bind_property: missing widget_name"));
    if (!P->TryGetStringField(TEXT("property_name"), PropertyName) || PropertyName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_bind_property: missing property_name (e.g. \"Text\")"));

    const bool bClearing = !P->TryGetStringField(TEXT("variable_name"), VariableName) || VariableName.IsEmpty();

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_bind_property: widget blueprint not found"));

    UWidget* Widget = FindWidgetByName(WBP->WidgetTree, WidgetName);
    if (!Widget)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_bind_property: widget '%s' not found"), *WidgetName));

    // A binding only survives compile if the widget is a variable of the UserWidget — the
    // binding is stored by name and resolved against the generated class.
    if (!Widget->bIsVariable)
    {
        Widget->Modify();
        Widget->bIsVariable = true;
        RegisterWidgetVariable(WBP, Widget);
    }

    WBP->Modify();

    // One binding per (widget, property) — FDelegateEditorBinding::operator== compares exactly
    // those two, so removing first makes this idempotent and doubles as the "clear" path.
    FDelegateEditorBinding Binding;
    Binding.ObjectName = Widget->GetName();
    Binding.PropertyName = FName(*PropertyName);
    WBP->Bindings.Remove(Binding);

    if (bClearing)
    {
        FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
        WBP->MarkPackageDirty();

        TSharedPtr<FJsonObject> ClearedOut = MakeShared<FJsonObject>();
        ClearedOut->SetStringField(TEXT("widget_name"), Widget->GetName());
        ClearedOut->SetStringField(TEXT("property_name"), PropertyName);
        ClearedOut->SetBoolField(TEXT("bound"), false);
        ClearedOut->SetStringField(TEXT("note"), TEXT("Binding cleared. Call ui_compile_widget then ui_save_widget to persist."));
        return FHaybaHandlerResult::Ok(ClearedOut);
    }

    // The source variable lives on the generated class. Resolve it now rather than letting the
    // compiler fail later with a binding that points at nothing.
    UClass* SourceClass = WBP->GeneratedClass ? WBP->GeneratedClass.Get() : WBP->SkeletonGeneratedClass.Get();
    if (!SourceClass)
        return FHaybaHandlerResult::Err(TEXT("ui_bind_property: blueprint has no generated class — compile it first"));

    FProperty* SourceProperty = FindFProperty<FProperty>(SourceClass, FName(*VariableName));
    if (!SourceProperty)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("ui_bind_property: no variable '%s' on '%s'. Create it first with blueprint_add_variable."),
            *VariableName, *SourceClass->GetName()));
    }

    // Verify the destination is actually bindable: UMG generates a companion delegate property
    // named "<Property>Delegate" for every property the designer can bind.
    const FName DelegateName(*(PropertyName + TEXT("Delegate")));
    FDelegateProperty* DelegateProperty = FindFProperty<FDelegateProperty>(Widget->GetClass(), DelegateName);
    if (!DelegateProperty)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("ui_bind_property: '%s' on %s is not bindable (no %s). Bindable examples: Text, ToolTipText, Visibility, bIsEnabled."),
            *PropertyName, *Widget->GetClass()->GetName(), *DelegateName.ToString()));
    }

    TArray<FFieldVariant> Chain;
    Chain.Add(SourceProperty);

    Binding.SourceProperty = FName(*VariableName);
    Binding.SourcePath = FEditorPropertyPath(Chain);
    Binding.Kind = EBindingKind::Property;

    // Refuse a type mismatch here, where the message can name both sides, instead of emitting a
    // compile error that only says the binding is invalid.
    FText BindError;
    if (!Binding.SourcePath.Validate(DelegateProperty, BindError))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("ui_bind_property: '%s' cannot drive %s.%s — %s"),
            *VariableName, *Widget->GetName(), *PropertyName, *BindError.ToString()));
    }

    WBP->Bindings.Add(Binding);
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WBP);
    WBP->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_name"), Widget->GetName());
    Out->SetStringField(TEXT("property_name"), PropertyName);
    Out->SetStringField(TEXT("variable_name"), VariableName);
    Out->SetBoolField(TEXT("bound"), true);
    Out->SetNumberField(TEXT("binding_count"), WBP->Bindings.Num());
    Out->SetStringField(TEXT("note"), TEXT("Staged. Call ui_compile_widget then ui_save_widget to persist."));
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
    FHaybaParamReader ParamR(P, TEXT("ui_measure_text"));
    Text = ParamR.RequiredString(TEXT("text"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

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

        // Brush facts.
        //
        // These used to carry a tint, a has_resource bool, and for a Border not
        // even the resource PATH. That is not enough to answer the question
        // people actually ask — "what is the working panel doing that mine is
        // not" — so the only way through was dropping to object_get_property and
        // reading the raw ExportText. Everything that distinguishes one brush
        // from another is reported now: draw_as, the resource, the 9-slice
        // margin, tiling and the outline.
        if (UImage* Img = Cast<UImage>(Widget))
        {
            TSharedPtr<FJsonObject> BrushObj = HaybaDescribeBrush(Img->GetBrush());
            // Image's own ColorAndOpacity multiplies the brush tint, so it is
            // the colour actually on screen.
            BrushObj->SetArrayField(TEXT("tint"), HaybaColorArray(Img->GetColorAndOpacity()));
            BrushObj->SetStringField(TEXT("brush_property"), TEXT("Brush"));
            Entry->SetObjectField(TEXT("brush_info"), BrushObj);
        }
        else if (UBorder* Bd = Cast<UBorder>(Widget))
        {
            // A Border's brush is reached through reflection rather than a
            // member: UMG moved these behind accessors and the member is not
            // public in current engine versions.
            TSharedPtr<FJsonObject> BrushObj;
            if (const FSlateBrush* Brush = HaybaFindBrushProperty(Bd, TEXT("Background")))
            {
                BrushObj = HaybaDescribeBrush(*Brush);
            }
            else
            {
                BrushObj = MakeShared<FJsonObject>();
                BrushObj->SetBoolField(TEXT("has_resource"), false);
                BrushObj->SetStringField(TEXT("note"), TEXT("Background brush could not be read through reflection on this engine version"));
            }
            BrushObj->SetArrayField(TEXT("tint"), HaybaColorArray(Bd->GetBrushColor()));
            BrushObj->SetStringField(TEXT("brush_property"), TEXT("Background"));
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

// ── ui_render_widget_to_png ─────────────────────────────────────────────────
//
// Draw a Widget Blueprint to a PNG without launching PIE.
//
// The problem this exists for: every font, brush, spacing and sizing mistake in
// a UMG layout is invisible until it renders, and the only way to render one
// was close editor → build → relaunch → drive PIE → screenshot. That is a
// four-minute round trip to answer "is the text still Roboto". An agent cannot
// see the viewport, so it either pays that cost on every change or works blind.
//
// FWidgetRenderer is what the UMG designer's own thumbnails use: it draws a
// Slate widget into a render target off-screen, on the game thread, with no
// world and no play session.

FHaybaHandlerResult FHaybaMCPUIHandler::HandleRenderToPng(const TSharedPtr<FJsonObject>& P)
{
    FString BPPath;
    if (!P->TryGetStringField(TEXT("widget_blueprint_path"), BPPath) || BPPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ui_render_widget_to_png: missing widget_blueprint_path"));

    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *BPPath);
    if (!WBP || !WBP->WidgetTree)
        return FHaybaHandlerResult::Err(TEXT("ui_render_widget_to_png: widget blueprint not found"));

    // Default to the size the blueprint is authored against, so what comes back
    // matches what the designer shows rather than an arbitrary crop.
    const FVector2D DesignSize = HaybaUILayout::GetDesignSize(WBP);
    double ReqW = DesignSize.X;
    double ReqH = DesignSize.Y;
    P->TryGetNumberField(TEXT("width"), ReqW);
    P->TryGetNumberField(TEXT("height"), ReqH);

    double Scale = 1.0;
    P->TryGetNumberField(TEXT("scale"), Scale);
    Scale = FMath::Clamp(Scale, 0.1, 4.0);

    const int32 Width  = FMath::Clamp(FMath::RoundToInt(ReqW * Scale), 16, 8192);
    const int32 Height = FMath::Clamp(FMath::RoundToInt(ReqH * Scale), 16, 8192);

    FString OutPath;
    P->TryGetStringField(TEXT("out_path"), OutPath);
    if (OutPath.IsEmpty())
    {
        const FString Stamp = FDateTime::Now().ToString(TEXT("%Y%m%d_%H%M%S"));
        const FString Uuid8 = FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
        OutPath = FPaths::ProjectSavedDir() / TEXT("Screenshots/Hayba")
                / FString::Printf(TEXT("widget_%s_%s_%s.png"), *WBP->GetName(), *Stamp, *Uuid8);
    }
    else if (FPaths::IsRelative(OutPath))
    {
        OutPath = FPaths::ProjectDir() / OutPath;
    }
    OutPath = FPaths::ConvertRelativePathToFull(OutPath);

    FString Error;
    HaybaUILayout::FPreviewInstance Preview;
    if (!HaybaUILayout::MakePreviewInstance(WBP, Preview, Error))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_render_widget_to_png: %s"), *Error));

    const FVector2D DrawSize(Width, Height);

    // bUseGammaCorrection: without it every colour comes back visibly dark, and
    // "the mockup looks wrong" is exactly the judgement this tool exists to
    // support — a systematically wrong palette would make it worse than useless.
    TSharedPtr<FWidgetRenderer> Renderer = MakeShared<FWidgetRenderer>(/*bUseGammaCorrection=*/true);
    if (!Renderer.IsValid())
        return FHaybaHandlerResult::Err(TEXT("ui_render_widget_to_png: could not create the widget renderer"));
    Renderer->SetIsPrepassNeeded(true);

    UTextureRenderTarget2D* RT = Renderer->DrawWidget(Preview.Slate.ToSharedRef(), DrawSize);
    if (!RT)
        return FHaybaHandlerResult::Err(TEXT("ui_render_widget_to_png: DrawWidget produced no render target"));

    // DrawWidget enqueues render commands; reading the pixels before they have
    // executed yields an empty (black) buffer. This is the same "first frame is
    // black" trap the PIE screenshot path hit.
    FlushRenderingCommands();

    FTextureRenderTargetResource* Res = RT->GameThread_GetRenderTargetResource();
    if (!Res)
        return FHaybaHandlerResult::Err(TEXT("ui_render_widget_to_png: render target has no resource"));

    TArray<FColor> Pixels;
    if (!Res->ReadPixels(Pixels) || Pixels.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("ui_render_widget_to_png: failed to read pixels back from the render target"));

    // UMG draws onto transparency. Left alone, every pixel the layout does not
    // cover is alpha-0 and most viewers show the whole image as black, which
    // reads as "the render failed" rather than "this widget does not fill its
    // canvas". Opaque by default; opt out when compositing is the point.
    bool bOpaqueBackground = true;
    P->TryGetBoolField(TEXT("opaque_background"), bOpaqueBackground);
    int32 OpaquePixels = 0;
    for (FColor& C : Pixels)
    {
        if (C.A != 0) ++OpaquePixels;
        if (bOpaqueBackground) C.A = 255;
    }

    IFileManager::Get().MakeDirectory(*FPaths::GetPath(OutPath), /*Tree=*/true);

    // PNGCompressImageArray, NOT ThumbnailCompressImageArray/CompressImageArray:
    // those emit JPEG bytes behind a .png extension (see HaybaMCPRenderHandler).
    TArray64<uint8> Png;
    FImageUtils::PNGCompressImageArray(Width, Height, Pixels, Png);
    if (!FFileHelper::SaveArrayToFile(Png, *OutPath))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("ui_render_widget_to_png: could not write %s"), *OutPath));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("widget_blueprint_path"), WBP->GetPathName());
    Out->SetStringField(TEXT("out_path"), OutPath);

    // Hand back the image itself, not just where it went. The caller cannot see
    // the viewport — that is the entire reason this command exists — so a bare
    // filename would leave them as blind as the four-minute PIE loop did.
    //
    // Capped: a full-resolution render can base64 to several MB, which is worth
    // refusing rather than pushing through the transport. When it is too big the
    // path is still there to read, and the response says so instead of silently
    // omitting the field.
    bool bInlineImage = true;
    P->TryGetBoolField(TEXT("inline_image"), bInlineImage);
    const int64 InlineByteLimit = 3 * 1024 * 1024;
    if (bInlineImage)
    {
        if (Png.Num() <= InlineByteLimit)
        {
            TArray<uint8> Narrow;
            Narrow.Append(Png.GetData(), Png.Num());
            Out->SetStringField(TEXT("image_base64"), FBase64::Encode(Narrow));
        }
        else
        {
            Out->SetStringField(TEXT("inline_image_skipped"),
                FString::Printf(TEXT("PNG is %lld bytes, over the %lld-byte inline limit — read out_path instead, ")
                                TEXT("or re-render with a smaller scale."), (int64)Png.Num(), InlineByteLimit));
        }
    }
    Out->SetNumberField(TEXT("width"), Width);
    Out->SetNumberField(TEXT("height"), Height);
    Out->SetNumberField(TEXT("design_width"), DesignSize.X);
    Out->SetNumberField(TEXT("design_height"), DesignSize.Y);
    Out->SetNumberField(TEXT("bytes"), Png.Num());
    Out->SetBoolField(TEXT("opaque_background"), bOpaqueBackground);

    // A fully transparent render means the widget drew nothing — a collapsed
    // root, an empty tree, an inactive switcher slot. The file still exists and
    // still has a size, so without this the caller gets a confident success for
    // a blank image.
    const double CoveragePct = Pixels.Num() > 0 ? (100.0 * OpaquePixels / Pixels.Num()) : 0.0;
    Out->SetNumberField(TEXT("coverage_percent"), FMath::RoundToDouble(CoveragePct * 100.0) / 100.0);
    if (OpaquePixels == 0)
    {
        Out->SetStringField(TEXT("warning"),
            TEXT("The widget drew NOTHING — every pixel was fully transparent. The PNG exists but is blank. ")
            TEXT("Usual causes: the root widget is Collapsed/Hidden, the tree is empty, the visible content sits ")
            TEXT("in an inactive WidgetSwitcher slot, or nothing has an explicit size. Do not treat this as a render."));
    }

    return FHaybaHandlerResult::Ok(Out);
}

#endif // WITH_EDITOR
