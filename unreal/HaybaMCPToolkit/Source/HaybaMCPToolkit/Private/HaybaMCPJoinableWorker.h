#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "HAL/ThreadSafeBool.h"
#include "Templates/Function.h"

/**
 * An explicitly owned, truly joinable connection worker.
 *
 * UE 5.8's Async(EAsyncExecution::Thread) fulfills its promise from inside
 * TAsyncRunnable::Run before the runnable, thread object, and callable capture
 * are deleted. Waiting on that future is therefore not an unload barrier.
 * JoinAndDestroy waits for the actual FRunnableThread, deletes its platform
 * thread object, then resets the callable so every captured plugin object is
 * destroyed before returning.
 */
class FHaybaMCPJoinableWorker final : public FRunnable
{
public:
	explicit FHaybaMCPJoinableWorker(TUniqueFunction<void()>&& InCallable)
		: Callable(MoveTemp(InCallable))
	{
	}

	~FHaybaMCPJoinableWorker()
	{
		JoinAndDestroy();
	}

	FHaybaMCPJoinableWorker(const FHaybaMCPJoinableWorker&) = delete;
	FHaybaMCPJoinableWorker& operator=(const FHaybaMCPJoinableWorker&) = delete;

	bool Start(const TCHAR* ThreadName)
	{
		if (Thread || !Callable)
		{
			return false;
		}
		Thread = FRunnableThread::Create(this, ThreadName, 0, TPri_Normal);
		return Thread != nullptr;
	}

	bool IsCompleted() const { return bCompleted; }

	void JoinAndDestroy()
	{
		if (Thread)
		{
			Thread->WaitForCompletion();
			delete Thread;
			Thread = nullptr;
		}
		// This reset, after the real join, is the module-unload guarantee. It is
		// deliberately explicit rather than deferred to a future/shared state.
		Callable.Reset();
	}

	virtual uint32 Run() override
	{
		Callable();
		bCompleted = true;
		return 0;
	}

private:
	TUniqueFunction<void()> Callable;
	FRunnableThread* Thread = nullptr;
	FThreadSafeBool bCompleted{ false };
};
