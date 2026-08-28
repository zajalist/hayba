#include "HaybaMCPAutomationIsolationPolicy.h"

using namespace HaybaAutomationIsolation;

static_assert(ClassifyLiteral(L"Hayba.MCP.Params.Reader") == EExecutionMode::InProcess);
static_assert(ClassifyLiteral(L"Hayba.MCP.Future.Unreviewed") == EExecutionMode::OwnedChild);
static_assert(ClassifyLiteral(L"Aphrosia.GameInstance.InvalidOuter") == EExecutionMode::OwnedChild);
static_assert(ClassifyLiteral(L"Engine.Editor.ContextFixture") == EExecutionMode::OwnedChild);

static_assert(ClassifyChildOutcome(false, false, false, false, -1) == EChildOutcome::NeverStarted);
static_assert(ClassifyChildOutcome(true, false, true, false, -1) == EChildOutcome::TimedOut);
static_assert(ClassifyChildOutcome(true, false, false, true, -1) == EChildOutcome::Cancelled);
static_assert(ClassifyChildOutcome(true, true, false, false, 1) == EChildOutcome::Reported);
static_assert(ClassifyChildOutcome(true, false, false, false, 0) == EChildOutcome::NeverStarted);
static_assert(ClassifyChildOutcome(true, false, false, false, 3) == EChildOutcome::Crashed);

int main()
{
    return 0;
}
