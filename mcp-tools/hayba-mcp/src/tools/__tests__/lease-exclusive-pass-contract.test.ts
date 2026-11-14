/**
 * A production project, 2026-11-12: with about 15 lanes, short area leases on disjoint folders queued behind a
 * whole-editor EXCLUSIVE that was itself waiting for a holder (the root IX of every area lease conflicts with its X),
 * so everything ran one at a time; and a coordinator's urgent request had no way to the front. Pins the fix in the
 * pure lease table: a short request (TTL <= BypassMaxTtlSeconds) that conflicts with no holder is granted ahead of a
 * stuck, non-front EXCLUSIVE during that EXCLUSIVE's first AgingSeconds; such a grant is capped at
 * BypassMaxTtlSeconds from its grant, renewals included, so the EXCLUSIVE cannot starve; front ranks ahead of every
 * other waiter. The behaviour itself is covered by the UE automation test Hayba.MCP.Lease.ExclusivePass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leaseAcquireSchema } from '../lease/lease-tools.js';

const priv = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'unreal',
  'HaybaMCPToolkit',
  'Source',
  'HaybaMCPToolkit',
  'Private',
);
const read = (...p: string[]) => readFileSync(join(priv, ...p), 'utf8').replace(/\r\n/g, '\n');
const policy = read('HaybaMCPLeasePolicy.h');
const handler = read('handlers', 'HaybaMCPLeaseHandler.cpp');
const fn = (name: string) => policy.slice(policy.indexOf(name), policy.indexOf('\n\t\t}\n', policy.indexOf(name)));

describe('a short request may pass a stuck whole-editor EXCLUSIVE', () => {
  it('only a short, non-EXCLUSIVE candidate may pass, and only a passable waiter', () => {
    expect(policy).toContain('double BypassMaxTtlSeconds = 300.0;');
    expect(policy).toContain('ClampTtl(Candidate.Request.TtlSeconds) <= Tuning.BypassMaxTtlSeconds');
    expect(policy).toContain('&& !IsWholeEditorExclusive(Candidate.Locks);');
    expect(policy).toContain('if (bShort && MayBePassed(Other, Now))');
  });

  it('passable means: whole-editor EXCLUSIVE, not front, younger than AgingSeconds, held up by a holder', () => {
    const passable = fn('bool MayBePassed(const FWaiter& W, double Now) const');
    expect(passable).toContain(
      'W.Request.bFront || !IsWholeEditorExclusive(W.Locks) || Now - W.EnqueuedAt >= Tuning.AgingSeconds',
    );
    expect(passable).toContain('HaybaMCPAccess::FindConflict(W.Locks, L.Locks) && !FenceServes(L, W, Now)');
    expect(fn('static bool IsWholeEditorExclusive(')).toContain(
      'L.Key == TEXT("global") && L.Mode == HaybaMCPAccess::ELockMode::Exclusive',
    );
  });

  it('a holder still blocks: only the waiter check changed', () => {
    expect(policy).toContain('if (!Blocker && !AheadBlocker)');
    expect(policy).toContain('return Grant(WaiterIndex, Now, FenceOf, bPassesExclusive);');
  });

  it('caps a passing grant at BypassMaxTtlSeconds, renewals included', () => {
    expect(policy).toContain('Lease.ExpiresAt = FMath::Min(Lease.ExpiresAt, Now + Tuning.BypassMaxTtlSeconds);');
    expect(fn('double CapExpiry(const FLease& Lease, double Wanted) const')).toContain(
      'Out = FMath::Min(Out, Lease.GrantedAt + Tuning.BypassMaxTtlSeconds);',
    );
    expect(handler).toContain('Out->SetBoolField(TEXT("passed_exclusive"), true);');
  });
});

describe('front', () => {
  it('ranks ahead of every other waiter', () => {
    expect(fn('int64 Ranks(const FWaiter& W, double Now) const')).toContain('W.Request.bFront ? 0 :');
  });

  it('is read from lease_acquire and accepted by the MCP tool', () => {
    expect(handler).toContain('P->TryGetBoolField(TEXT("front"), Request.bFront);');
    expect(leaseAcquireSchema.safeParse({ resources: ['global'], front: true }).success).toBe(true);
  });
});
