// This file is part of example-locker.
// Copyright (C) 2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import * as LockerContract from '../../contract/src/managed/locker/contract/index.js';
import type { LockerPrivateState } from '../../contract/src/witnesses.js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { ProvableCircuitId } from '@midnight-ntwrk/compact-js';

export type LockerCircuits = ProvableCircuitId<LockerContract.Contract<LockerPrivateState>>;

export const LockerPrivateStateId = 'lockerPrivateState';

export type LockerProviders = MidnightProviders<LockerCircuits, typeof LockerPrivateStateId, LockerPrivateState>;

export type LockerContractType = LockerContract.Contract<LockerPrivateState>;

export type DeployedLockerContract = DeployedContract<LockerContractType> | FoundContract<LockerContractType>;
