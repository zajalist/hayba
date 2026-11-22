#pragma once
#include "IHaybaMCPHandler.h"

namespace HaybaLightEdit
{
    FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params);
}
