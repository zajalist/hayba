#include "TunnelSpline.h"
#include "Components/SplineComponent.h"

ATunnelSpline::ATunnelSpline()
{
    PrimaryActorTick.bCanEverTick = false;

    SplineComponent = CreateDefaultSubobject<USplineComponent>(TEXT("SplineComponent"));
    RootComponent = SplineComponent;

    Tags.Add(FName("hayba.primitive"));
}
