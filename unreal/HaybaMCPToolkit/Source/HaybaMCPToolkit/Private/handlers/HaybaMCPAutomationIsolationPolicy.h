#pragma once

namespace HaybaAutomationIsolation
{
    enum class EExecutionMode
    {
        InProcess,
        OwnedChild,
    };

    enum class EChildOutcome
    {
        NeverStarted,
        TimedOut,
        Cancelled,
        Reported,
        Crashed,
    };

    constexpr EChildOutcome ClassifyChildOutcome(
        bool bStarted,
        bool bHasValidReport,
        bool bTimedOut,
        bool bCancelled,
        int ExitCode)
    {
        if (!bStarted) return EChildOutcome::NeverStarted;
        if (bTimedOut) return EChildOutcome::TimedOut;
        if (bCancelled) return EChildOutcome::Cancelled;
        if (bHasValidReport) return EChildOutcome::Reported;
        return ExitCode == 0 ? EChildOutcome::NeverStarted : EChildOutcome::Crashed;
    }

    template <typename CharType>
    constexpr bool Equals(const CharType* Value, int Length, const wchar_t* Expected)
    {
        int Index = 0;
        while (Expected[Index] != L'\0')
        {
            if (Index >= Length || Value[Index] != static_cast<CharType>(Expected[Index]))
            {
                return false;
            }
            ++Index;
        }
        return Index == Length;
    }

    /**
     * Exact, lifecycle-audited allowlist for pure Hayba contract tests.
     *
     * These tests operate on value types or isolated registries and do not
     * create worlds, UObject graphs, render resources, subprocesses, or editor
     * state. Adding an entry requires reviewing the test body against those
     * constraints. Namespace/category membership is deliberately insufficient.
     */
    template <typename CharType>
    constexpr EExecutionMode ClassifyName(const CharType* Name, int Length)
    {
        if (Equals(Name, Length, L"Hayba.MCP.Params.Reader")
            || Equals(Name, Length, L"Hayba.MCP.ResponseBuilder.ImageIsNeverTrimmed")
            || Equals(Name, Length, L"Hayba.MCP.TestSelection.SelectorsAndFailuresAreTruthful")
            || Equals(Name, Length, L"Hayba.MCP.Tests.RunLifecycle")
            || Equals(Name, Length, L"Hayba.MCP.Transport.FrameReadPolicy"))
        {
            return EExecutionMode::InProcess;
        }

        // The containment invariant: every unknown project, engine, plugin,
        // and future Hayba test executes in a disposable owned child.
        return EExecutionMode::OwnedChild;
    }

    template <typename StringType>
    constexpr EExecutionMode Classify(const StringType& Name)
    {
        return ClassifyName(*Name, Name.Len());
    }

    template <int Length>
    constexpr EExecutionMode ClassifyLiteral(const wchar_t (&Name)[Length])
    {
        return ClassifyName(Name, Length - 1);
    }
}
