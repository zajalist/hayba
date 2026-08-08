#pragma once

// Camera orientation, decided without touching a viewport.
//
// editor_set_camera has three ways to say where the camera should point, a
// precedence order between them, and a deliberate asymmetry about roll. All of
// that is pure decision-making, and until now it was spelled out in the middle
// of a function that also calls SetViewLocation / SetViewRotation on a live
// FEditorViewportClient — so none of it could be tested, and the rule most
// likely to be got wrong is the one nothing was checking.
//
// The rule exists because of a real, repeated failure: UE's FRotator is
// (Pitch, Yaw, Roll), not XYZ euler. An agent thinking "rotate N degrees about
// Z" passes [0, 0, N] expecting yaw and gets ROLL — the horizon tilts and the
// screenshot comes back at an angle, which reads as a rendering bug rather than
// a caller mistake. See HaybaActorOps.h for the same split applied to actors,
// and #320.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

namespace HaybaEditorOps
{
    /** Which input decided the orientation. Reported back so a caller can see
     *  that look_at won over a rotation it also sent, rather than wondering why
     *  its angles were ignored. */
    enum class ECameraRotationSource : uint8
    {
        Unchanged,   // nothing usable supplied — keep what the viewport has
        LookAt,      // look_at [x,y,z]           (preferred: roll is 0 by construction)
        RotationObj, // rotation {pitch,yaw,roll} (the only way to opt into roll)
        RotationArr, // rotation [pitch,yaw]      (roll ignored on purpose)
    };

    struct FCameraOrientation
    {
        FRotator Rotation = FRotator::ZeroRotator;
        ECameraRotationSource Source = ECameraRotationSource::Unchanged;

        bool bChanged() const { return Source != ECameraRotationSource::Unchanged; }
    };

    /**
     * Decide the camera rotation from the request.
     *
     * Precedence, highest first:
     *   1. `look_at` [x,y,z] — aim at a world point. Derived via
     *      FVector::Rotation(), so roll is zero by construction and the horizon
     *      cannot tilt. This is the correct way to aim a camera.
     *   2. `rotation` as an object {pitch, yaw, roll} — unambiguous, and the
     *      ONLY way to ask for roll.
     *   3. `rotation` as an array [pitch, yaw] — a third element is read as roll
     *      by FRotator's constructor order and is therefore **ignored**, so a
     *      stray value cannot tilt the view.
     *
     * A look_at pointing at the camera's own position is not an orientation and
     * falls through to the rotation forms rather than producing a zero vector.
     *
     * Pure: no GEditor, no viewport. `Current` is the viewport's existing
     * rotation, used as the base when only some components are supplied.
     */
    FCameraOrientation ResolveCameraRotation(
        const TSharedPtr<FJsonObject>& Params,
        const FVector& CameraLocation,
        const FRotator& Current);

    /** Name of the source, for the response. */
    const TCHAR* RotationSourceName(ECameraRotationSource Source);
}
