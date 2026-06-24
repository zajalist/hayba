#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Components/BoxComponent.h"
#include "RoomVolume.generated.h"

UCLASS(BlueprintType)
class HAYBAMCPTOOLKIT_API ARoomVolume : public AActor
{
    GENERATED_BODY()

public:
    ARoomVolume();

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Room")
    TObjectPtr<UBoxComponent> BoxComponent;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    FName Builder = "native";

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    FString Phase = "I";

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    int32 Seed = 0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    double Importance = 0.3;
};
