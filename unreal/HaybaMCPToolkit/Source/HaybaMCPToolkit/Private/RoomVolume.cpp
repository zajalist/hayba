#include "RoomVolume.h"
#include "Components/BoxComponent.h"

ARoomVolume::ARoomVolume()
{
    PrimaryActorTick.bCanEverTick = false;

    BoxComponent = CreateDefaultSubobject<UBoxComponent>(TEXT("BoxComponent"));
    RootComponent = BoxComponent;
    BoxComponent->InitBoxExtent(FVector(300.0, 400.0, 175.0));

    Tags.Add(FName("hayba.primitive"));
}
