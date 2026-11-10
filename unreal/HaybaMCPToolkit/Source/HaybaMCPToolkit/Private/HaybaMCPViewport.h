#pragma once

// Which viewport an editor command means, decided in one place.
//
// GEditor->GetActiveViewport() is the FOCUSED viewport. With PIE or another application in front it is the PIE
// window or nothing, so commands built on it captured from 0,0,0 (all-black frames in a production project, 2026-11-10 17:14), and the
// bookmark commands, which static_cast its client to FEditorViewportClient, could reinterpret a PIE client. Every
// viewport command resolves through here instead:
//   - reading the view (capture, bookmark): the PIE player's view while PIE runs, else the level viewport;
//   - changing the level camera or view mode: the level viewport, refused while PIE runs (PIE replaces the level
//     view, so the change would be invisible and silently undone).

#include "CoreMinimal.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "Camera/PlayerCameraManager.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"

namespace HaybaViewport
{
	/** The level viewport the user last worked in (kept when the editor loses focus), else the first perspective one. */
	inline FLevelEditorViewportClient* LevelViewport()
	{
		if (!GEditor) return nullptr;
		if (GCurrentLevelEditingViewportClient && GCurrentLevelEditingViewportClient->IsPerspective())
			return GCurrentLevelEditingViewportClient;
		for (FLevelEditorViewportClient* Client : GEditor->GetLevelViewportClients())
		{
			if (Client && Client->IsPerspective()) return Client;
		}
		return nullptr;
	}

	struct FView
	{
		FVector Location = FVector::ZeroVector;
		FRotator Rotation = FRotator::ZeroRotator;
		float Fov = 90.f;
		UWorld* World = nullptr;
		const TCHAR* Source = TEXT("");   // "pie_player" | "level_viewport"
	};

	/** What the user is looking at. False with Error when there is no view to read. */
	inline bool CurrentView(FView& Out, FString& Error)
	{
		if (!GEditor) { Error = TEXT("GEditor is not available"); return false; }
		if (UWorld* Play = GEditor->PlayWorld.Get())
		{
			if (APlayerController* PC = Play->GetFirstPlayerController())
			{
				PC->GetPlayerViewPoint(Out.Location, Out.Rotation);
				if (PC->PlayerCameraManager) Out.Fov = PC->PlayerCameraManager->GetFOVAngle();
				Out.World = Play;
				Out.Source = TEXT("pie_player");
				return true;
			}
		}
		FLevelEditorViewportClient* Client = LevelViewport();
		if (!Client) { Error = TEXT("no perspective level viewport is open"); return false; }
		Out.Location = Client->GetViewLocation();
		Out.Rotation = Client->GetViewRotation();
		Out.Fov = Client->ViewFOV;
		Out.World = GEditor->GetEditorWorldContext().World();
		Out.Source = TEXT("level_viewport");
		return true;
	}

	/** The level viewport to change, or null with Error (none open, or PIE running). */
	inline FLevelEditorViewportClient* LevelViewportToChange(const TCHAR* Cmd, FString& Error)
	{
		if (GEditor && GEditor->PlayWorld)
		{
			Error = FString::Printf(TEXT("%s: a Play-In-Editor session is running and replaces the level view, so the change "
				"would not show and would be lost; stop PIE first. Nothing was changed."), Cmd);
			return nullptr;
		}
		FLevelEditorViewportClient* Client = LevelViewport();
		if (!Client) Error = FString::Printf(TEXT("%s: no perspective level viewport is open. Nothing was changed."), Cmd);
		return Client;
	}
}
