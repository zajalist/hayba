#include "HaybaMCPSecretRedaction.h"

#include "Dom/JsonValue.h"
#include "Internationalization/Regex.h"

namespace HaybaMCPSecretRedaction
{
namespace
{
    static constexpr const TCHAR* RedactedPrefix = TEXT("[REDACTED:");
    static constexpr const TCHAR* TruncatedPrefix = TEXT("[TRUNCATED:");
    static constexpr const TCHAR* SecurityMetaKey = TEXT("hayba/security_redaction");

    struct FWalkState
    {
        FLimits Limits;
        int32 Nodes = 0;
        int32 StringChars = 0;
        TSet<const FJsonObject*> ActiveObjects;
        TSet<const FJsonValue*> ActiveValues;
        TSet<FString> Categories;
        TSet<FString> TruncationReasons;
        int32 RedactedValues = 0;
    };

    struct FValueResult
    {
        TSharedPtr<FJsonValue> Value;
        bool bChanged = false;
    };

    struct FObjectResult
    {
        TSharedPtr<FJsonObject> Value;
        bool bChanged = false;
        FString ReplacementReason;
    };

    struct FObjectEntry
    {
        // Key is complete only when it fits MaxKeyChars; otherwise it is the
        // bounded prefix used by property-name scanning.
        FString Key;
        // At most 1,024 chars (head + tail), used for stable ordering and the
        // structural key vocabulary without copying an attacker-sized key.
        FString StructuralKey;
        TSharedPtr<FJsonValue> Value;
        uint32 KeyHash = 0;
        int32 OriginalLength = 0;
        bool bOverlong = false;
        bool bMandatory = false;
    };

    const TArray<FString>& SecretCategories()
    {
        static const TArray<FString> Values = {
            TEXT("api_key"), TEXT("authorization"), TEXT("bearer"), TEXT("credential"),
            TEXT("password"), TEXT("private_key"), TEXT("provider_key"), TEXT("token"),
            TEXT("url_query") };
        return Values;
    }

    const TArray<FString>& TruncationReasons()
    {
        static const TArray<FString> Values = {
            TEXT("accessor"), TEXT("array_items"), TEXT("cycle"), TEXT("depth"),
            TEXT("nodes"), TEXT("object_keys"), TEXT("string_chars"),
            TEXT("total_string_chars") };
        return Values;
    }

    FString Marker(const FString& Category)
    {
        return FString::Printf(TEXT("%s%s]"), RedactedPrefix, *Category);
    }

    FString TruncationMarker(const FString& Reason)
    {
        return FString::Printf(TEXT("%s%s]"), TruncatedPrefix, *Reason);
    }

    bool IsExactMarker(const FString& Value, const TCHAR* Prefix, const TArray<FString>& Names)
    {
        for (const FString& Name : Names)
        {
            if (Value == FString::Printf(TEXT("%s%s]"), Prefix, *Name))
            {
                return true;
            }
        }
        return false;
    }

    bool IsRedactedMarker(const FString& Value)
    {
        return IsExactMarker(Value, RedactedPrefix, SecretCategories());
    }

    bool IsTruncationMarker(const FString& Value)
    {
        return IsExactMarker(Value, TruncatedPrefix, TruncationReasons());
    }

    FValueResult Truncated(FWalkState& State, const FString& Reason)
    {
        State.TruncationReasons.Add(Reason);
        return { MakeShared<FJsonValueString>(TruncationMarker(Reason)), true };
    }

    FLimits SanitizeLimits(const FLimits& In)
    {
        FLimits Out = In;
        Out.MaxDepth = FMath::Max(1, Out.MaxDepth);
        Out.MaxNodes = FMath::Max(1, Out.MaxNodes);
        Out.MaxArrayItems = FMath::Max(1, Out.MaxArrayItems);
        Out.MaxObjectKeys = FMath::Max(1, Out.MaxObjectKeys);
        Out.MaxKeyChars = FMath::Max(1, Out.MaxKeyChars);
        Out.MaxStringChars = FMath::Max(1, Out.MaxStringChars);
        Out.MaxTotalStringChars = FMath::Max(1, Out.MaxTotalStringChars);
        return Out;
    }

    const TSet<FString>& MeasurementHeads()
    {
        static const TSet<FString> Values = {
            TEXT("age"), TEXT("algorithm"), TEXT("allowed"), TEXT("at"), TEXT("budget"),
            TEXT("count"), TEXT("date"), TEXT("depth"), TEXT("disabled"), TEXT("duration"),
            TEXT("enabled"), TEXT("error"), TEXT("expired"), TEXT("format"), TEXT("found"),
            TEXT("id"), TEXT("index"), TEXT("kind"), TEXT("label"), TEXT("last4"),
            TEXT("length"), TEXT("limit"), TEXT("max"), TEXT("message"), TEXT("min"),
            TEXT("missing"), TEXT("mode"), TEXT("name"), TEXT("offset"), TEXT("order"),
            TEXT("policy"), TEXT("position"), TEXT("present"), TEXT("reason"),
            TEXT("remaining"), TEXT("required"), TEXT("rule"), TEXT("scheme"),
            TEXT("size"), TEXT("source"), TEXT("state"), TEXT("status"),
            TEXT("supported"), TEXT("time"), TEXT("timestamp"), TEXT("total"),
            TEXT("ttl"), TEXT("type"), TEXT("used"), TEXT("valid"), TEXT("version") };
        return Values;
    }

    const TArray<TPair<FString, FString>>& SecretCompounds()
    {
        static const TArray<TPair<FString, FString>> Values = {
            {TEXT("authorization"), TEXT("authorization")},
            {TEXT("proxyauthorization"), TEXT("authorization")},
            {TEXT("privatekey"), TEXT("private_key")},
            {TEXT("signingkey"), TEXT("private_key")},
            {TEXT("clientsecret"), TEXT("credential")},
            {TEXT("webhooksecret"), TEXT("credential")},
            {TEXT("accesskey"), TEXT("credential")},
            {TEXT("apikey"), TEXT("api_key")},
            {TEXT("accesstoken"), TEXT("token")},
            {TEXT("refreshtoken"), TEXT("token")},
            {TEXT("authtoken"), TEXT("token")},
            {TEXT("bearertoken"), TEXT("token")},
            {TEXT("password"), TEXT("password")},
            {TEXT("passwd"), TEXT("password")},
            {TEXT("pwd"), TEXT("password")},
            {TEXT("credential"), TEXT("credential")},
            {TEXT("secretkey"), TEXT("credential")},
            {TEXT("token"), TEXT("token")},
            {TEXT("secret"), TEXT("credential")} };
        return Values;
    }

    TArray<FString> KeyWords(const FString& Raw)
    {
        FString Spaced;
        Spaced.Reserve(Raw.Len() + 8);
        TCHAR Previous = 0;
        for (const TCHAR Character : Raw)
        {
            const bool bAlphaNumeric = FChar::IsAlnum(Character);
            const bool bCamelBoundary = Previous != 0 && FChar::IsLower(Previous) && FChar::IsUpper(Character);
            if (bCamelBoundary)
            {
                Spaced.AppendChar(TEXT(' '));
            }
            Spaced.AppendChar(bAlphaNumeric ? FChar::ToLower(Character) : TEXT(' '));
            Previous = Character;
        }
        TArray<FString> Words;
        Spaced.ParseIntoArrayWS(Words);
        return Words;
    }

    TOptional<FString> SecretCategoryForKey(const FString& RawKey)
    {
        const FString Bounded = RawKey.Len() > 1024
            ? RawKey.Left(512) + RawKey.Right(512)
            : RawKey;
        const TArray<FString> Words = KeyWords(Bounded);
        if (Words.Num() == 0)
        {
            return {};
        }
        const TSet<FString>& Measurements = MeasurementHeads();
        if (Measurements.Contains(Words.Last()))
        {
            return {};
        }
        FString Normalized = FString::Join(Words, TEXT(""));
        for (const FString& Head : Measurements)
        {
            if (Normalized != Head && Normalized.EndsWith(Head))
            {
                return {};
            }
        }

        TSet<FString> Candidates;
        for (const FString& Word : Words)
        {
            Candidates.Add(Word);
        }
        Candidates.Add(Normalized);
        for (int32 Index = 0; Index < Words.Num(); ++Index)
        {
            Candidates.Add(Words[Index] + (Words.IsValidIndex(Index + 1) ? Words[Index + 1] : FString()));
            Candidates.Add(Words[Index]
                + (Words.IsValidIndex(Index + 1) ? Words[Index + 1] : FString())
                + (Words.IsValidIndex(Index + 2) ? Words[Index + 2] : FString()));
        }
        for (const TPair<FString, FString>& Compound : SecretCompounds())
        {
            if (Candidates.Contains(Compound.Key) || Normalized.EndsWith(Compound.Key))
            {
                return Compound.Value;
            }
        }
        return {};
    }

    bool IsMandatoryOutputKey(const FString& Key)
    {
        FString Normalized;
        Normalized.Reserve(Key.Len());
        for (const TCHAR Character : Key)
        {
            if (FChar::IsAlnum(Character))
            {
                Normalized.AppendChar(FChar::ToLower(Character));
            }
        }
        return Normalized == TEXT("error")
            || Normalized == TEXT("errors")
            || Normalized == TEXT("mandatoryrecovery")
            || Normalized == TEXT("recovery")
            || Normalized == TEXT("recoveryaction")
            || Normalized == TEXT("recoveryactions");
    }

    bool IsOpaquePayload(const FString& Key, const TSharedPtr<FJsonObject>& Owner)
    {
        FString Normalized;
        for (const TCHAR Character : Key)
        {
            if (FChar::IsAlnum(Character))
            {
                Normalized.AppendChar(FChar::ToLower(Character));
            }
        }
        if (Normalized.Contains(TEXT("base64"))
            || Normalized.EndsWith(TEXT("binary"))
            || Normalized.EndsWith(TEXT("bytes")))
        {
            return true;
        }
        FString Type;
        if (Owner.IsValid())
        {
            Owner->TryGetStringField(TEXT("type"), Type);
        }
        Type.ToLowerInline();
        return Normalized == TEXT("data")
            && (Type == TEXT("image") || Type == TEXT("audio") || Type == TEXT("blob"));
    }

    bool IsStructurallyValidBase64(const FString& Value)
    {
        if (Value.IsEmpty() || Value.Len() % 4 != 0) return false;
        int32 FirstPadding = INDEX_NONE;
        for (int32 Index = 0; Index < Value.Len(); ++Index)
        {
            const TCHAR C = Value[Index];
            if (C == TEXT('='))
            {
                if (FirstPadding == INDEX_NONE) FirstPadding = Index;
                continue;
            }
            const bool bAsciiAlphabet = (C >= TEXT('A') && C <= TEXT('Z'))
                || (C >= TEXT('a') && C <= TEXT('z'))
                || (C >= TEXT('0') && C <= TEXT('9'))
                || C == TEXT('+') || C == TEXT('/');
            if (FirstPadding != INDEX_NONE || !bAsciiAlphabet)
            {
                return false;
            }
        }
        if (FirstPadding != INDEX_NONE)
        {
            const int32 Padding = Value.Len() - FirstPadding;
            if (Padding < 1 || Padding > 2) return false;
        }
        return true;
    }

    bool IsHighConfidenceProviderKey(const FString& Value)
    {
        // AWS access key ids are themselves valid standard-base64 characters,
        // so syntax alone cannot make an opaque field safe. Keep this narrow
        // and allocation-free to avoid scanning large image payloads with a
        // general regex engine.
        if (Value.Len() != 20 || !Value.StartsWith(TEXT("AKIA"))) return false;
        for (int32 Index = 4; Index < Value.Len(); ++Index)
        {
            const TCHAR C = Value[Index];
            if (!((C >= TEXT('A') && C <= TEXT('Z')) || (C >= TEXT('0') && C <= TEXT('9'))))
            {
                return false;
            }
        }
        return true;
    }

    void RecordRedaction(FWalkState& State, const FString& Category)
    {
        State.Categories.Add(Category);
        ++State.RedactedValues;
    }

    FString ReplaceRegexCapture(
        const FString& Input,
        const FRegexPattern& Pattern,
        int32 CaptureGroup,
        const FString& Category,
        FWalkState& State,
        bool& bChanged,
        bool bAcceptMissingFinalBracket = false)
    {
        FRegexMatcher Matcher(Pattern, Input);
        FString Output;
        int32 Cursor = 0;
        while (Matcher.FindNext())
        {
            const int32 MatchBegin = Matcher.GetMatchBeginning();
            const int32 MatchEnd = Matcher.GetMatchEnding();
            const int32 CaptureBegin = Matcher.GetCaptureGroupBeginning(CaptureGroup);
            const int32 CaptureEnd = Matcher.GetCaptureGroupEnding(CaptureGroup);
            if (MatchBegin < Cursor || CaptureBegin < MatchBegin || CaptureEnd > MatchEnd || CaptureBegin < 0)
            {
                continue;
            }
            const FString Raw = Input.Mid(CaptureBegin, CaptureEnd - CaptureBegin);
            if (IsRedactedMarker(Raw)
                || (bAcceptMissingFinalBracket && IsRedactedMarker(Raw + TEXT("]"))))
            {
                Output += Input.Mid(Cursor, MatchEnd - Cursor);
                Cursor = MatchEnd;
                continue;
            }
            Output += Input.Mid(Cursor, CaptureBegin - Cursor);
            Output += Marker(Category);
            Output += Input.Mid(CaptureEnd, MatchEnd - CaptureEnd);
            Cursor = MatchEnd;
            RecordRedaction(State, Category);
            bChanged = true;
        }
        if (Cursor == 0)
        {
            return Input;
        }
        Output += Input.Mid(Cursor);
        return Output;
    }

    FString ReplaceWholeRegex(
        const FString& Input,
        const FRegexPattern& Pattern,
        const FString& Category,
        FWalkState& State,
        bool& bChanged)
    {
        FRegexMatcher Matcher(Pattern, Input);
        FString Output;
        int32 Cursor = 0;
        while (Matcher.FindNext())
        {
            const int32 Begin = Matcher.GetMatchBeginning();
            const int32 End = Matcher.GetMatchEnding();
            if (Begin < Cursor)
            {
                continue;
            }
            const FString Raw = Input.Mid(Begin, End - Begin);
            if (IsRedactedMarker(Raw))
            {
                Output += Input.Mid(Cursor, End - Cursor);
            }
            else
            {
                Output += Input.Mid(Cursor, Begin - Cursor);
                Output += Marker(Category);
                RecordRedaction(State, Category);
                bChanged = true;
            }
            Cursor = End;
        }
        if (Cursor == 0)
        {
            return Input;
        }
        Output += Input.Mid(Cursor);
        return Output;
    }

    FString RedactPrivateKeyBlocks(const FString& Input, FWalkState& State, bool& bChanged)
    {
        static const FString Terminal = TEXT("PRIVATE KEY-----");
        FString Output;
        int32 Cursor = 0;
        while (Cursor < Input.Len())
        {
            const int32 Begin = Input.Find(TEXT("-----BEGIN "), ESearchCase::CaseSensitive, ESearchDir::FromStart, Cursor);
            if (Begin == INDEX_NONE)
            {
                Output += Input.Mid(Cursor);
                break;
            }
            const int32 HeaderEnd = Input.Find(Terminal, ESearchCase::CaseSensitive, ESearchDir::FromStart, Begin);
            if (HeaderEnd == INDEX_NONE || HeaderEnd - Begin > 80)
            {
                Output += Input.Mid(Cursor, Begin + 11 - Cursor);
                Cursor = Begin + 11;
                continue;
            }
            const int32 End = Input.Find(
                Terminal, ESearchCase::CaseSensitive, ESearchDir::FromStart, HeaderEnd + Terminal.Len());
            Output += Input.Mid(Cursor, Begin - Cursor);
            Output += Marker(TEXT("private_key"));
            RecordRedaction(State, TEXT("private_key"));
            bChanged = true;
            Cursor = End == INDEX_NONE ? Input.Len() : End + Terminal.Len();
        }
        return bChanged ? Output : Input;
    }

    FValueResult WalkString(const FString& Input, FWalkState& State, bool bOpaque)
    {
        if (IsRedactedMarker(Input) || IsTruncationMarker(Input) || bOpaque)
        {
            return { MakeShared<FJsonValueString>(Input), false };
        }

        FString Text = Input;
        bool bChanged = false;
        const int32 Remaining = FMath::Max(0, State.Limits.MaxTotalStringChars - State.StringChars);
        const int32 Allowed = FMath::Min(State.Limits.MaxStringChars, Remaining);
        if (Text.Len() > Allowed)
        {
            Text = Text.Left(Allowed) + TruncationMarker(TEXT("string_chars"));
            State.TruncationReasons.Add(
                Remaining < State.Limits.MaxStringChars ? TEXT("total_string_chars") : TEXT("string_chars"));
            bChanged = true;
        }
        State.StringChars += FMath::Min(Input.Len(), Allowed);

        Text = RedactPrivateKeyBlocks(Text, State, bChanged);

        // Inputs are bounded before matching. The expressions have no nested
        // quantifiers and no attacker-controlled pattern construction.
        static const FRegexPattern Bearer(TEXT("(?i)\\bBearer[ \\t]+[A-Za-z0-9._~+/=:-]+"));
        static const FRegexPattern Jwt(TEXT("\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b"));
        static const FRegexPattern Provider(
            TEXT("\\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\\b"));
        static const FRegexPattern UrlUserInfo(TEXT("(?i)(\\bhttps?://[^\\s/@:]+:)([^\\s/@]+)(@)"));
        static const FRegexPattern UrlSecret(
            TEXT("(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|signature|sig|x-amz-signature|x-amz-credential)=)([^&#\\s]+)"));
        static const FRegexPattern Assignment(
            TEXT("(?i)((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|private[_ -]?key|password|passwd|pwd|token|secret|authorization|credential|x-api-key|cookie|set-cookie)[\\\"']?\\s*[:=]\\s*[\\\"']?)([^\\\"'&,;\\s}\\]]+)"));

        Text = ReplaceWholeRegex(Text, Bearer, TEXT("bearer"), State, bChanged);
        Text = ReplaceWholeRegex(Text, Jwt, TEXT("token"), State, bChanged);
        Text = ReplaceWholeRegex(Text, Provider, TEXT("provider_key"), State, bChanged);
        Text = ReplaceRegexCapture(Text, UrlUserInfo, 2, TEXT("password"), State, bChanged);
        Text = ReplaceRegexCapture(Text, UrlSecret, 2, TEXT("url_query"), State, bChanged);
        Text = ReplaceRegexCapture(Text, Assignment, 2, TEXT("credential"), State, bChanged, true);
        return { MakeShared<FJsonValueString>(Text), bChanged };
    }

    TOptional<FString> InspectPropertyKey(const FString& RawKey, FWalkState& Parent)
    {
        const FString Bounded = RawKey.Left(Parent.Limits.MaxKeyChars);
        FWalkState Local;
        Local.Limits.MaxDepth = 1;
        Local.Limits.MaxNodes = 2;
        Local.Limits.MaxArrayItems = 1;
        Local.Limits.MaxObjectKeys = 1;
        Local.Limits.MaxKeyChars = Parent.Limits.MaxKeyChars;
        Local.Limits.MaxStringChars = Parent.Limits.MaxKeyChars;
        Local.Limits.MaxTotalStringChars = Parent.Limits.MaxKeyChars;
        const FValueResult Result = WalkString(Bounded, Local, false);
        if (Local.RedactedValues == 0)
        {
            return {};
        }
        for (const FString& Category : Local.Categories)
        {
            Parent.Categories.Add(Category);
        }
        Parent.RedactedValues += Local.RedactedValues;
        TArray<FString> Categories = Local.Categories.Array();
        Categories.Sort();
        return Categories.Num() > 0 ? TOptional<FString>(Categories[0]) : TOptional<FString>(TEXT("credential"));
    }

    FString UniquePlaceholder(const FString& Base, const TSet<FString>& Reserved, const TSet<FString>& Emitted)
    {
        FString Candidate = Base;
        int32 Suffix = 1;
        while (Reserved.Contains(Candidate) || Emitted.Contains(Candidate))
        {
            Candidate = FString::Printf(TEXT("%s_%d"), *Base, Suffix++);
        }
        return Candidate;
    }

    FValueResult WalkValue(
        const TSharedPtr<FJsonValue>& Input,
        FWalkState& State,
        int32 Depth,
        bool bOpaque);

    FObjectResult WalkObject(const TSharedPtr<FJsonObject>& Input, FWalkState& State, int32 Depth)
    {
        if (!Input.IsValid())
        {
            State.TruncationReasons.Add(TEXT("accessor"));
            return { nullptr, true, TEXT("accessor") };
        }
        if (State.ActiveObjects.Contains(Input.Get()))
        {
            State.TruncationReasons.Add(TEXT("cycle"));
            return { nullptr, true, TEXT("cycle") };
        }
        State.ActiveObjects.Add(Input.Get());

        const int32 Limit = FMath::Min(Input->Values.Num(), State.Limits.MaxObjectKeys);
        TArray<FObjectEntry> Entries;
        Entries.Reserve(Limit);

        const auto IsBetterEntry = [](const FObjectEntry& Left, const FObjectEntry& Right)
        {
            if (Left.bMandatory != Right.bMandatory)
            {
                return Left.bMandatory; // Mandatory facts always win a slot.
            }
            const int32 KeyOrder = Left.StructuralKey.Compare(Right.StructuralKey, ESearchCase::CaseSensitive);
            if (KeyOrder != 0)
            {
                return KeyOrder < 0;
            }
            if (Left.KeyHash != Right.KeyHash)
            {
                return Left.KeyHash < Right.KeyHash;
            }
            return Left.OriginalLength < Right.OriginalLength;
        };
        // TArray heaps put the predicate's preferred element at index zero.
        // We need the least useful selected entry there so a better candidate
        // can replace it in O(log K), with O(K) memory for K=MaxObjectKeys.
        const auto IsWorseHeapEntry = [&IsBetterEntry](const FObjectEntry& Left, const FObjectEntry& Right)
        {
            return IsBetterEntry(Right, Left);
        };

        for (const auto& Pair : Input->Values)
        {
            // UE 5.8 FJsonObject::Values uses TSharedString keys. Work from its
            // view so an overlong key is never copied in full.
            const FStringView RawKey = Pair.Key.ToView();
            FObjectEntry Candidate;
            Candidate.OriginalLength = RawKey.Len();
            Candidate.bOverlong = RawKey.Len() > State.Limits.MaxKeyChars;
            Candidate.Key = FString(RawKey.Left(FMath::Min(RawKey.Len(), State.Limits.MaxKeyChars)));
            if (RawKey.Len() > 1024)
            {
                Candidate.StructuralKey = FString(RawKey.Left(512)) + FString(RawKey.Right(512));
            }
            else
            {
                Candidate.StructuralKey = FString(RawKey);
            }
            Candidate.Value = Pair.Value;
            Candidate.KeyHash = GetTypeHash(Pair.Key);
            Candidate.bMandatory = IsMandatoryOutputKey(Candidate.StructuralKey);

            if (Entries.Num() < Limit)
            {
                Entries.HeapPush(MoveTemp(Candidate), IsWorseHeapEntry);
            }
            else if (Limit > 0 && IsBetterEntry(Candidate, Entries[0]))
            {
                Entries.HeapPopDiscard(IsWorseHeapEntry, EAllowShrinking::No);
                Entries.HeapPush(MoveTemp(Candidate), IsWorseHeapEntry);
            }
        }
        Entries.Sort(IsBetterEntry);

        bool bChanged = Input->Values.Num() > Limit;
        if (bChanged)
        {
            State.TruncationReasons.Add(TEXT("object_keys"));
        }

        TSet<FString> Reserved;
        for (const FObjectEntry& Entry : Entries)
        {
            if (!Entry.bOverlong)
            {
                Reserved.Add(Entry.Key);
            }
        }
        TSet<FString> Emitted;
        TSharedPtr<FJsonObject> Output = MakeShared<FJsonObject>();
        for (const FObjectEntry& Entry : Entries)
        {
            FString OutputKey = Entry.Key;
            const TOptional<FString> PropertySecret = InspectPropertyKey(Entry.Key, State);
            if (PropertySecret.IsSet())
            {
                OutputKey = UniquePlaceholder(
                    FString::Printf(
                        TEXT("_redacted_key_%s_%08x"),
                        *PropertySecret.GetValue(),
                        Entry.KeyHash),
                    Reserved,
                    Emitted);
                bChanged = true;
            }
            else if (Entry.bOverlong)
            {
                OutputKey = UniquePlaceholder(
                    FString::Printf(TEXT("_truncated_key_%08x"), Entry.KeyHash), Reserved, Emitted);
                State.TruncationReasons.Add(TEXT("object_keys"));
                bChanged = true;
            }

            FValueResult Next;
            const TOptional<FString> StructuralSecret = SecretCategoryForKey(Entry.StructuralKey);
            FString ExistingString;
            const bool bExactMarker = Entry.Value.IsValid()
                && Entry.Value->Type == EJson::String
                && (ExistingString = Entry.Value->AsString(), IsRedactedMarker(ExistingString));
            if (StructuralSecret.IsSet() && !bExactMarker)
            {
                RecordRedaction(State, StructuralSecret.GetValue());
                Next = { MakeShared<FJsonValueString>(Marker(StructuralSecret.GetValue())), true };
            }
            else if (!Entry.Value.IsValid())
            {
                Next = Truncated(State, TEXT("accessor"));
            }
            else
            {
                Next = WalkValue(Entry.Value, State, Depth + 1, IsOpaquePayload(Entry.StructuralKey, Input));
            }
            Output->SetField(OutputKey, Next.Value);
            Emitted.Add(OutputKey);
            bChanged = bChanged || Next.bChanged || OutputKey != Entry.Key;
        }
        State.ActiveObjects.Remove(Input.Get());
        return bChanged ? FObjectResult{Output, true, FString()} : FObjectResult{Input, false, FString()};
    }

    FValueResult WalkValue(
        const TSharedPtr<FJsonValue>& Input,
        FWalkState& State,
        int32 Depth,
        bool bOpaque)
    {
        ++State.Nodes;
        if (State.Nodes > State.Limits.MaxNodes)
        {
            return Truncated(State, TEXT("nodes"));
        }
        if (Depth > State.Limits.MaxDepth)
        {
            return Truncated(State, TEXT("depth"));
        }
        if (!Input.IsValid())
        {
            return Truncated(State, TEXT("accessor"));
        }
        if (State.ActiveValues.Contains(Input.Get()))
        {
            return Truncated(State, TEXT("cycle"));
        }
        State.ActiveValues.Add(Input.Get());

        FValueResult Result;
        switch (Input->Type)
        {
        case EJson::String:
            // A field name containing `base64` is only an encoding hint, not
            // permission to bypass scanning arbitrary prose. Preserve payload
            // bytes only when the value is actually complete base64; malformed
            // or clipped fields are scanned like any other string. An AWS key
            // is valid base64 syntax, so that high-confidence exact token also
            // overrides opacity.
            Result = WalkString(
                Input->AsString(), State,
                bOpaque && IsStructurallyValidBase64(Input->AsString())
                    && !IsHighConfidenceProviderKey(Input->AsString()));
            if (!Result.bChanged)
            {
                Result.Value = Input;
            }
            break;
        case EJson::Array:
        {
            const TArray<TSharedPtr<FJsonValue>>& Items = Input->AsArray();
            const int32 Limit = FMath::Min(Items.Num(), State.Limits.MaxArrayItems);
            bool bChanged = Items.Num() > Limit;
            if (bChanged)
            {
                State.TruncationReasons.Add(TEXT("array_items"));
            }
            TArray<TSharedPtr<FJsonValue>> Output;
            Output.Reserve(Limit);
            for (int32 Index = 0; Index < Limit; ++Index)
            {
                const FValueResult Next = WalkValue(Items[Index], State, Depth + 1, false);
                Output.Add(Next.Value);
                bChanged = bChanged || Next.bChanged;
            }
            Result = bChanged
                ? FValueResult{MakeShared<FJsonValueArray>(Output), true}
                : FValueResult{Input, false};
            break;
        }
        case EJson::Object:
        {
            const FObjectResult Object = WalkObject(Input->AsObject(), State, Depth);
            Result = Object.bChanged
                ? (Object.Value.IsValid()
                    ? FValueResult{MakeShared<FJsonValueObject>(Object.Value), true}
                    : Truncated(State, Object.ReplacementReason.IsEmpty()
                        ? FString(TEXT("accessor"))
                        : Object.ReplacementReason))
                : FValueResult{Input, false};
            break;
        }
        default:
            Result = {Input, false};
            break;
        }
        State.ActiveValues.Remove(Input.Get());
        return Result;
    }

    FSummary BuildSummary(const FWalkState& State)
    {
        FSummary Summary;
        Summary.bApplied = State.RedactedValues > 0;
        Summary.RedactedValues = State.RedactedValues;
        Summary.Categories = State.Categories.Array();
        Summary.Categories.Sort();
        Summary.bTruncated = State.TruncationReasons.Num() > 0;
        Summary.TruncationReasons = State.TruncationReasons.Array();
        Summary.TruncationReasons.Sort();
        return Summary;
    }
}

TSharedRef<FJsonObject> FSummary::ToJson() const
{
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("applied"), bApplied);
    Out->SetNumberField(TEXT("redacted_values"), RedactedValues);
    TArray<TSharedPtr<FJsonValue>> CategoryValues;
    for (const FString& Category : Categories)
    {
        CategoryValues.Add(MakeShared<FJsonValueString>(Category));
    }
    Out->SetArrayField(TEXT("categories"), CategoryValues);
    Out->SetBoolField(TEXT("truncated"), bTruncated);
    TArray<TSharedPtr<FJsonValue>> ReasonValues;
    for (const FString& Reason : TruncationReasons)
    {
        ReasonValues.Add(MakeShared<FJsonValueString>(Reason));
    }
    Out->SetArrayField(TEXT("truncation_reasons"), ReasonValues);
    return Out;
}

FResult Redact(const TSharedPtr<FJsonObject>& Envelope, const FLimits& Limits)
{
    if (!Envelope.IsValid())
    {
        FResult Invalid;
        Invalid.Value = MakeShared<FJsonObject>();
        Invalid.Summary.bTruncated = true;
        Invalid.Summary.TruncationReasons = {TEXT("accessor")};
        return Invalid;
    }

    FWalkState State;
    State.Limits = SanitizeLimits(Limits);
    State.Nodes = 1; // The root object is a node too.
    const FObjectResult Walked = WalkObject(Envelope, State, 0);
    FResult Result;
    Result.Value = Walked.Value.IsValid() ? Walked.Value : MakeShared<FJsonObject>();
    Result.Summary = BuildSummary(State);
    return Result;
}

FString RedactTextForLog(const FString& Input, int32 MaxChars)
{
    const int32 SafeMaxChars = FMath::Clamp(MaxChars, 64, 64 * 1024);
    FLimits Limits;
    Limits.MaxDepth = 2;
    Limits.MaxNodes = 8;
    Limits.MaxArrayItems = 1;
    Limits.MaxObjectKeys = 4;
    Limits.MaxKeyChars = 32;
    Limits.MaxStringChars = SafeMaxChars;
    Limits.MaxTotalStringChars = Limits.MaxStringChars;

    TSharedPtr<FJsonObject> Wrapper = MakeShared<FJsonObject>();
    Wrapper->SetStringField(TEXT("text"), Input);
    const FResult Safe = Redact(Wrapper, Limits);
    FString Output;
    if (!Safe.Value.IsValid() || !Safe.Value->TryGetStringField(TEXT("text"), Output))
    {
        return TEXT("[TRUNCATED:accessor]");
    }
    // WalkString appends a machine truncation marker after its content budget.
    // A log boundary promises a hard final size, so cap the already-redacted
    // value once more. Cutting a marker cannot reveal any removed secret.
    return Output.Left(SafeMaxChars);
}

TSharedPtr<FJsonObject> RedactFinalEnvelope(const TSharedPtr<FJsonObject>& Envelope, const FLimits& Limits)
{
    const FResult Result = Redact(Envelope, Limits);
    if (!Result.Summary.bApplied && !Result.Summary.bTruncated)
    {
        return Result.Value;
    }

    TSharedPtr<FJsonObject> Output = MakeShared<FJsonObject>();
    for (const auto& Pair : Result.Value->Values)
    {
        Output->SetField(FString(*Pair.Key), Pair.Value);
    }

    TSharedPtr<FJsonObject> Meta = MakeShared<FJsonObject>();
    const TSharedPtr<FJsonObject>* ExistingMeta = nullptr;
    if (Result.Value->TryGetObjectField(TEXT("_meta"), ExistingMeta)
        && ExistingMeta
        && ExistingMeta->IsValid())
    {
        for (const auto& Pair : (*ExistingMeta)->Values)
        {
            Meta->SetField(FString(*Pair.Key), Pair.Value);
        }
    }
    Meta->SetObjectField(SecurityMetaKey, Result.Summary.ToJson());
    Output->SetObjectField(TEXT("_meta"), Meta);
    return Output;
}
}
