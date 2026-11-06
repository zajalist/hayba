#pragma once

// Static checks on a Material Custom node's HLSL before it reaches the shader
// compiler. Pure: no editor, no materials.
//
// Why: M_UI_SandText's Custom node had an apostrophe leak into its code. The
// translator accepted it, material_compile answered ok, and the platform shader
// compile failed later on another thread ("Unclosed character literal"). The
// material silently fell back to the default, and the menu text rendered as
// nothing in game. HLSL here has no character literals, so a stray ' outside a
// comment is always prose that leaked in.

#include "CoreMinimal.h"

namespace HaybaMaterialLint
{
    /** Empty when Code looks like HLSL, otherwise the first problem found:
     *  an apostrophe outside comments, an unclosed string, block comment or
     *  bracket, or a closing bracket with no opener. */
    inline FString LintCustomHlsl(const FString& Code)
    {
        if (Code.TrimStartAndEnd().IsEmpty()) return TEXT("is empty");
        TArray<TCHAR> Stack;
        int32 Line = 1;
        for (int32 I = 0; I < Code.Len(); ++I)
        {
            const TCHAR C = Code[I];
            const TCHAR Next = I + 1 < Code.Len() ? Code[I + 1] : 0;
            if (C == TEXT('\n')) { ++Line; continue; }
            if (C == TEXT('/') && Next == TEXT('/'))
            {
                while (I < Code.Len() && Code[I] != TEXT('\n')) ++I;
                --I; // let the newline be counted
                continue;
            }
            if (C == TEXT('/') && Next == TEXT('*'))
            {
                const int32 End = Code.Find(TEXT("*/"), ESearchCase::CaseSensitive, ESearchDir::FromStart, I + 2);
                if (End == INDEX_NONE) return FString::Printf(TEXT("has an unclosed /* comment (line %d)"), Line);
                for (int32 J = I; J < End; ++J) if (Code[J] == TEXT('\n')) ++Line;
                I = End + 1;
                continue;
            }
            if (C == TEXT('"'))
            {
                int32 J = I + 1;
                while (J < Code.Len() && Code[J] != TEXT('"') && Code[J] != TEXT('\n')) J += Code[J] == TEXT('\\') ? 2 : 1;
                if (J >= Code.Len() || Code[J] != TEXT('"')) return FString::Printf(TEXT("has an unclosed \" string (line %d)"), Line);
                I = J;
                continue;
            }
            if (C == TEXT('\''))
                return FString::Printf(TEXT("has an apostrophe outside a comment (line %d): HLSL has no character literals, so this is prose that leaked into the code"), Line);
            if (C == TEXT('(') || C == TEXT('[') || C == TEXT('{')) Stack.Push(C);
            else if (C == TEXT(')') || C == TEXT(']') || C == TEXT('}'))
            {
                const TCHAR Want = C == TEXT(')') ? TEXT('(') : C == TEXT(']') ? TEXT('[') : TEXT('{');
                if (Stack.Num() == 0 || Stack.Pop() != Want)
                    return FString::Printf(TEXT("has an unmatched '%c' (line %d)"), C, Line);
            }
        }
        if (Stack.Num() > 0) return FString::Printf(TEXT("has an unclosed '%c'"), Stack.Last());
        return FString();
    }
}
