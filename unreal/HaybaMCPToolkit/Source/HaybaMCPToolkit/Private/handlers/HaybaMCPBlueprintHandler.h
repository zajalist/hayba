#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPBlueprintHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("blueprint"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult Create(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddComponent(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddVariable(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddFunction(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddNode(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ConnectNodes(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Compile(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Document(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddEvent(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetDefaults(const TSharedPtr<FJsonObject>& P);
    /** Set a literal on an unconnected input pin — the third leg of graph authoring. */
    FHaybaHandlerResult SetPinDefault(const TSharedPtr<FJsonObject>& P);

    // Initiative #7 — Blueprint compilation safety gates.
    // After every mutation we record the BP's compile state. If the most
    // recent compile failed, subsequent mutation commands on the same BP
    // return `bp_compile_required` until the user (or a follow-up tool call)
    // produces a clean compile.
    static TSet<FString>& BrokenBlueprintsRef();
    /** Compile and update the broken-set. Returns true on clean compile. */
    bool RecompileAndTrack(class UBlueprint* BP, TArray<FString>& OutErrors, TArray<FString>& OutWarnings);
    /** Convenience — turns the broken-set check + ok result into a FHaybaHandlerResult. */
    FHaybaHandlerResult MaybeRejectIfBroken(const TSharedPtr<FJsonObject>& P) const;
};
