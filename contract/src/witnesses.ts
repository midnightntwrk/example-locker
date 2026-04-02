// This file is part of example-locker.
// Copyright (C) 2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { type Ledger } from './managed/locker/contract/index.js';

// Private state is unused — the combination is passed in-memory via setCode().
export type LockerPrivateState = Record<string, never>;

export const createLockerPrivateState = (): LockerPrivateState => ({});

// In-memory combination — set immediately before calling callTx.rent() or callTx.open().
// Each rent/open operation sets its own combination, so multiple lockers can have
// different combinations within the same session.
let _code = new Uint8Array(32);

export const setCode = (combination: number): void => {
  _code = new Uint8Array(32);
  new DataView(_code.buffer).setUint32(0, combination, false);
};

export const witnesses = {
  myCode: ({ privateState }: WitnessContext<Ledger, LockerPrivateState>): [LockerPrivateState, Uint8Array] =>
    [privateState, _code],
};
