#pragma once

// Typed param extraction for command handlers.
//
// The thin GetString/GetNumber/GetBool helpers below are 1:1 wrappers over the
// FJsonObject TryGet* methods. They are kept because existing handlers use
// them, but they are the reason this header was ignored: wrapping a call in a
// call of the same shape saves nobody anything, so 549 sites went straight to
// TryGet*Field and each re-invented the same three things —
//
//   1. the missing-required-field error string, in a slightly different format
//      every time ("x is required", "missing x", "<cmd>: missing x");
//   2. one-at-a-time reporting, so a caller who got three params wrong had to
//      make three round trips to find that out;
//   3. defaults, spelled as an uninitialised local plus an ignored return.
//
// FHaybaParamReader does those three things once. It accumulates failures
// rather than returning on the first, so a handler validates everything and
// reports it together.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

namespace HaybaParams
{
    // Thin wrapper over TryGetStringField. Returns false (Out untouched) if the
    // object is null or the field is missing / not a string.
    inline bool GetString(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, FString& Out)
    {
        return Obj.IsValid() && Obj->TryGetStringField(Key, Out);
    }

    // Thin wrapper over TryGetNumberField.
    inline bool GetNumber(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, double& Out)
    {
        return Obj.IsValid() && Obj->TryGetNumberField(Key, Out);
    }

    // Thin wrapper over TryGetBoolField.
    inline bool GetBool(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, bool& Out)
    {
        return Obj.IsValid() && Obj->TryGetBoolField(Key, Out);
    }

    // Reads a 3-element JSON number array into an FVector. Returns false (Out
    // untouched) unless the field is an array with at least 3 numeric entries.
    inline bool GetVec3(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, FVector& Out)
    {
        if (!Obj.IsValid()) return false;
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Obj->TryGetArrayField(Key, Arr) || !Arr || Arr->Num() < 3) return false;
        Out = FVector(
            (*Arr)[0]->AsNumber(),
            (*Arr)[1]->AsNumber(),
            (*Arr)[2]->AsNumber());
        return true;
    }
}

/**
 * Reads a command's params, collecting every problem instead of stopping at
 * the first.
 *
 * Usage mirrors how handlers already read params, minus the error plumbing:
 *
 *     FHaybaParamReader R(Params, TEXT("ui_set_brush"));
 *     const FString Path = R.RequiredString(TEXT("widget_blueprint_path"));
 *     const FString Name = R.RequiredString(TEXT("widget_name"));
 *     const double  Size = R.OptionalNumber(TEXT("size"), 12.0);
 *     if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
 *
 * A caller who omitted two fields is told about both, once — rather than
 * fixing one, re-sending, and learning about the next.
 */
class FHaybaParamReader
{
public:
    FHaybaParamReader(const TSharedPtr<FJsonObject>& InParams, const FString& InCommandName)
        : Params(InParams), CommandName(InCommandName)
    {
        if (!Params.IsValid())
        {
            // A null params object is not "every field missing" — say the one
            // true thing rather than listing every field the handler asks for.
            Errors.Add(TEXT("no params object was supplied"));
            bParamsMissing = true;
        }
    }

    FString RequiredString(const TCHAR* Key)
    {
        FString Out;
        if (!bParamsMissing && !Params->TryGetStringField(Key, Out))
        {
            Missing(Key, TEXT("string"));
        }
        else if (!bParamsMissing && Out.IsEmpty())
        {
            // An empty string is the shape of a caller that built the value and
            // got nothing, which fails later and further away.
            Errors.Add(FString::Printf(TEXT("'%s' is present but empty"), Key));
        }
        return Out;
    }

    double RequiredNumber(const TCHAR* Key)
    {
        double Out = 0.0;
        if (!bParamsMissing && !Params->TryGetNumberField(Key, Out)) Missing(Key, TEXT("number"));
        return Out;
    }

    FString OptionalString(const TCHAR* Key, const FString& Default = FString()) const
    {
        FString Out;
        if (bParamsMissing || !Params->TryGetStringField(Key, Out)) return Default;
        return Out;
    }

    double OptionalNumber(const TCHAR* Key, double Default = 0.0) const
    {
        double Out = 0.0;
        if (bParamsMissing || !Params->TryGetNumberField(Key, Out)) return Default;
        return Out;
    }

    bool OptionalBool(const TCHAR* Key, bool Default = false) const
    {
        bool Out = false;
        if (bParamsMissing || !Params->TryGetBoolField(Key, Out)) return Default;
        return Out;
    }

    int32 OptionalInt(const TCHAR* Key, int32 Default = 0) const
    {
        return static_cast<int32>(OptionalNumber(Key, static_cast<double>(Default)));
    }

    /** Record a problem the reader cannot detect on its own (a value out of
     *  range, a combination that does not make sense). */
    void AddError(const FString& Message) { Errors.Add(Message); }

    bool HasErrors() const { return Errors.Num() > 0; }

    /** One message naming the command and every problem found. */
    FString ErrorMessage() const
    {
        return FString::Printf(TEXT("%s: %s"), *CommandName, *FString::Join(Errors, TEXT("; ")));
    }

private:
    void Missing(const TCHAR* Key, const TCHAR* Type)
    {
        Errors.Add(FString::Printf(TEXT("missing required %s '%s'"), Type, Key));
    }

    TSharedPtr<FJsonObject> Params;
    FString CommandName;
    TArray<FString> Errors;
    bool bParamsMissing = false;
};

/**
 * PIE input coordinate spaces.
 *
 * editor_pie_widget_tree reports a widget's position from Slate geometry, which
 * is ABSOLUTE DESKTOP space. editor_pie_mouse used to add the game window's
 * on-screen origin to whatever it was given — correct only if the caller had
 * measured from the window. Feeding it tree coordinates, which the tree's own
 * note told callers to do, therefore double-counted the origin and every click
 * landed low and right by the window's offset.
 *
 * That offset is the window chrome: 24px at 1080p with a title bar, but it is a
 * function of DPI, window position and whether a title bar exists at all — so
 * it must be computed, never assumed. The error is smaller than a large button,
 * which is why it went unnoticed: it only misses on targets under ~48px, like a
 * 33px tab or a 26px text field.
 */
namespace HaybaPieCoords
{
    /**
     * Resolve an input coordinate to the absolute desktop point to click.
     *
     * `WindowOrigin` is the game window's top-left in screen space. It is added
     * ONLY for viewport-relative input; absolute input is already in the space
     * Slate dispatches in and must pass through untouched.
     */
    inline FVector2D ToAbsolute(const FVector2D& Input, const FVector2D& WindowOrigin, bool bViewportRelative)
    {
        return bViewportRelative ? (WindowOrigin + Input) : Input;
    }
}
