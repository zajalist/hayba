#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FHaybaResponseLimits
{
    int32 MaxArrayItems = 50;
    int32 MaxStringChars = 512;
    int32 MaxTopLevelFields = 20;

    /**
     * Fields whose value must never be trimmed, by key name.
     *
     * A base64 image is always over the string cap, and clipping it does not
     * produce a shorter image — it produces a NON-EMPTY string that is not
     * valid base64. The MCP SDK then rejects the whole content block
     * ("Invalid Base64 string"), so the reply is lost entirely, metadata
     * included, and ui_render_widget_to_png has been unusable for at least a
     * week. editor_capture_viewport was reported failing the same way earlier,
     * with a "_truncated: image_base64" marker that named the culprit.
     *
     * Exempting by FIELD rather than by command on purpose: the previous
     * mechanism was a per-command override (python_run), which protects only
     * the commands somebody remembered. Any command that returns an image is
     * covered by this, including ones not written yet.
     */
    TSet<FString> NeverTrimFields { TEXT("image_base64") };

    /** Correctness facts used by the advisory classifier and callers. These
     * survive the top-level presentation cap even when their lexical order
     * would otherwise drop them. The allowlist itself is a fixed bound. */
    TSet<FString> NeverDropTopLevelFields {
        TEXT("succeeded"), TEXT("failed"), TEXT("saved"), TEXT("save_verified"),
        TEXT("verified"), TEXT("readback_verified"), TEXT("compiled_clean"),
        TEXT("dirty"), TEXT("dirty_count"), TEXT("valid"), TEXT("status"),
        TEXT("code"), TEXT("error"), TEXT("errors"), TEXT("phase"),
        TEXT("mutation_status"), TEXT("failure_kind"), TEXT("save_attempted"),
        TEXT("dirty_known"), TEXT("partial"), TEXT("unknown_outcome"),
        TEXT("session_suspect"), TEXT("crafted_format_safety")
    };
};

class FHaybaMCPResponseBuilder
{
public:
    explicit FHaybaMCPResponseBuilder(const FHaybaResponseLimits& InLimits = FHaybaResponseLimits());

    /** Trim string in place, returning whether trimmed. */
    bool TrimString(FString& InOutValue) const;

    /** Whether a field carrying this key is exempt from string trimming. */
    bool IsFieldExempt(const FString& Key) const;

    /** Trim array in place, returning number of items removed. */
    int32 TrimArray(TArray<TSharedPtr<FJsonValue>>& InOutItems) const;

    /** Recursively walk and trim a JSON object, marking truncations under `_truncated`. */
    TSharedRef<FJsonObject> Build(const TSharedRef<FJsonObject>& Source) const;

    /** Convenience: serialize to compact string. */
    FString Serialize(const TSharedRef<FJsonObject>& Source) const;

private:
    FHaybaResponseLimits Limits;
};
