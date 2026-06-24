#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Components/SplineComponent.h"
#include "TunnelSpline.generated.h"

UCLASS(BlueprintType)
class HAYBAMCPTOOLKIT_API ATunnelSpline : public AActor
{
    GENERATED_BODY()

public:
    ATunnelSpline();

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Tunnel")
    TObjectPtr<USplineComponent> SplineComponent;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    FName Builder = "native";

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    FString Phase = "I";

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    int32 Seed = 0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    double W = 1.8;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    double H = 2.4;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Hayba")
    double Importance = 0.3;
};
