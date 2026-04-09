// This file is part of example-locker.
// Copyright (C) 2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { type Ledger } from './managed/locker/contract/index.js';

// The combination is stored in private state so it is always a typed, validated value.
// The witness reads directly from private state — there is no way to call store() or
// vacate() without a combination having been set, because the type enforces it.
export type LockerPrivateState = {
  combination: Uint8Array;
};

export const createLockerPrivateState = (): LockerPrivateState => ({
  combination: new Uint8Array(32),
});

// Set the combination in private state immediately before calling callTx.addLocker() or
// callTx.vacate(). The witness reads from private state, guaranteeing a valid Uint8Array
// is always present - an empty buffer cannot slip through undetected.
let _combination = new Uint8Array(32);

export const setCombination = (combination: number): void => {
  _combination = new Uint8Array(32);
  new DataView(_combination.buffer).setUint32(0, combination, false);
};

export const witnesses = {
  myCombination: ({ privateState }: WitnessContext<Ledger, LockerPrivateState>): [LockerPrivateState, Uint8Array] => {
    // Prefer the in-memory value if it has been set (non-zero), otherwise fall back to
    // whatever is already persisted in private state. Guards against calling addLocker() or
    // vacate() without first calling setCombination().
    const combo = _combination.some((b) => b !== 0) ? _combination : privateState.combination;
    if (!combo.some((b) => b !== 0)) {
      throw new Error('No combination set - call setCombination() before addLocker() or vacate()');
    }
    // Return the updated private state so the combination persists in levelDB after each call.
    return [{ ...privateState, combination: combo }, combo];
  },
};
