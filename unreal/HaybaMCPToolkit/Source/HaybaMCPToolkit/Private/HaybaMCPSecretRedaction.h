#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Last-mile secret redaction for the native TCP response envelope.
 *
 * This boundary is intentionally independent of handlers. A handler may put a
 * credential in an error, warning, reflected property name, or nested content
 * string; the response must still be safe immediately before serialization.
 * The walk is non-mutating, bounded and cycle-safe. Binary/base64 media fields
 * are opaque unless their property name itself denotes a secret.
 */
namespace HaybaMCPSecretRedaction
{
    struct FLimits
    {
        int32 MaxDepth = 16;
        int32 MaxNodes = 10000;
        int32 MaxArrayItems = 256;
        int32 MaxObjectKeys = 256;
        int32 MaxKeyChars = 256;
        int32 MaxStringChars = 64 * 1024;
        int32 MaxTotalStringChars = 1024 * 1024;
    };

    struct FSummary
    {
        bool bApplied = false;
        int32 RedactedValues = 0;
        TArray<FString> Categories;
        bool bTruncated = false;
        TArray<FString> TruncationReasons;

        TSharedRef<FJsonObject> ToJson() const;
    };

    struct FResult
    {
        TSharedPtr<FJsonObject> Value;
        FSummary Summary;
    };

    /** Redact an envelope without changing the caller's object graph. */
    FResult Redact(const TSharedPtr<FJsonObject>& Envelope, const FLimits& Limits = FLimits());

    /** Last-mile boundary for native log text that never enters a JSON/TCP
     * envelope. The result is secret-scanned and deterministically bounded;
     * callers may log it, but must never fall back to the raw input. */
    FString RedactTextForLog(const FString& Input, int32 MaxChars = 4096);

    /**
     * Redact and, when anything changed, attach the machine-readable summary at
     * `_meta["hayba/security_redaction"]`.
     *
     * The root response boundary should call this exactly once, immediately
     * before passing the envelope to FJsonSerializer.
     */
    TSharedPtr<FJsonObject> RedactFinalEnvelope(
        const TSharedPtr<FJsonObject>& Envelope,
        const FLimits& Limits = FLimits());
}
