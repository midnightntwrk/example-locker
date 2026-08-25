# Tutorial: Building example-locker from Scratch

This tutorial focuses on what makes example-locker distinct. For foundational setup — package.json, tsconfig, providers, wallet wiring — see [example-counter](https://github.com/midnightntwrk/example-counter) which covers those patterns in detail. This tutorial picks up where that one leaves off.

**What you'll build:** A locker rental system where a 4-digit combination is set when renting. Only its hash is stored on-chain. Vacating requires a ZK proof that you know the combination; the digits never appear in any transaction. Vacated lockers are returned to a bank and automatically reused.

**What's new here (not covered in example-counter):**
- `List<T>`: Compact's dynamic list type and its front-only constraint
- Struct spread: partial struct updates without restating every field
- Internal circuits: helpers that are not exposed as public transactions
- Typed private state: storing the combination in `LockerPrivateState` rather than as a plain module variable

---

## Prerequisites

- Node.js >= 20
- Compact toolchain: [installation guide](https://docs.midnight.network/getting-started/installation#install-compact)
- Docker (for the proof server)

Check the [compatibility matrix](https://docs.midnight.network/relnotes/support-matrix) for exact version requirements before starting.

---

## Step 1 - Project setup

All source files live in two top-level directories: `contract/` for the Compact smart contract and its TypeScript witness, and `locker-cli/` for the CLI.

```bash
mkdir example-locker && cd example-locker
mkdir contract/src
mkdir locker-cli/src
```

The `package.json`, `tsconfig.json`, `.gitignore`, and `proof-server.yml` follow the same structure as example-counter. Copy them from that repo and update the package name, then run:

```bash
npm install
```

---

## Step 2 - The contract

The Compact contract defines what data lives on-chain, what ZK circuits users can call, and what rules govern them. Every `export circuit` in this file becomes a callable transaction from the CLI. Writing the contract first before any TypeScript makes the wiring easier to follow.

```bash
touch contract/src/locker.compact
```

Every Compact file starts with a language version pragma and an import of the standard library, which provides types like `Counter`, `Map`, `List`, and `Maybe`:

```compact
pragma language_version >= 0.22.0;

import CompactStandardLibrary;
```

**Types.** `export` is required on both; without it these types won't appear in the generated TypeScript bindings. The struct is kept minimal so a future vault variant could add a `contents` field without changing the access control model:

```compact
export enum LockerStatus { AVAILABLE, RENTED }

export struct Locker {
  status:   LockerStatus;
  codeHash: Bytes<32>;
}
```

**On-chain state.** `export ledger` is required; using `ledger` without `export` means the fields won't appear in the TypeScript `Ledger` type. The `lockerBank` field introduces `List<T>`, which is new here compared to example-counter:

```compact
export ledger lockers: Map<Uint<64>, Locker>;
export ledger totalLockers: Counter;
export ledger lockerBank: List<Uint<64>>;
```

**Using `List<T>` in Compact.** The `List` ADT supports `pushFront`, `popFront`, `head`, `isEmpty`, and `length`. It only has front operations — there is no `pushBack` or `popBack`. This makes it a stack (last vacated = first reused) rather than a queue. FIFO ordering would require a `Map<Uint<64>, Uint<64>>` with two `Counter` fields as read and write pointers. For this example the reuse order is not significant, but this is a real constraint to know when choosing data structures.

`lockerBank` holds locker IDs that have been vacated and are available for reuse. `rent()` checks this list first and reuses a slot if one is available, otherwise it creates a new slot. `vacate()` adds the freed ID back to the front of the list.

**Witness.** Declared here, implemented in TypeScript. The combination bytes are injected at proof-generation time and never appear in any public transcript:

```compact
witness myCombination(): Bytes<32>;
```

**Commitment helper.** Rather than storing the combination on-chain, we store a hash of it. The domain separator `"locker:v1:"` scopes this hash to this contract so it cannot be confused with hashes from other contracts:

```compact
circuit combinationCommitment(combination: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "locker:v1:"), combination]);
}
```

**Internal helpers.** These circuits are not `export`ed, so they cannot be called directly as transactions from the CLI. They exist only to keep the public circuits readable. This is an important pattern: circuits without `export` are private implementation details.

```compact
circuit addLocker(): Uint<64> {
  totalLockers.increment(1);
  return totalLockers.read() as Uint<64>;
}

circuit rentFromBank(): Uint<64> {
  const id = lockerBank.head().value;
  lockerBank.popFront();
  return id;
}
```

`addLocker` increments before reading so the first locker gets ID 1 (1-indexed). `rentFromBank` reads the front of the list and removes it in the same step. `head()` reads without removing and `popFront()` removes without returning, so both operations are always needed together.

**Public circuits.** `rent()` checks `lockerBank.isEmpty()` and either pulls an ID from the bank or creates a new slot. Because both branches produce a `Uint<64>`, the ternary works cleanly here:

```compact
export circuit rent(): [] {
  const id = disclose(lockerBank.isEmpty() ? addLocker() : takeFromBank());
  lockers.insert(id, Locker {
    status:   LockerStatus.RENTED,
    codeHash: disclose(combinationCommitment(myCombination()))
  });
}
```

`vacate()` proves knowledge of the combination without revealing it, then returns the locker to the bank. Notice the struct spread on the insert: `Locker { ...box, status: LockerStatus.AVAILABLE }` copies every field from `box` and overrides only `status`. This preserves `codeHash` without restating it. Without spread, `Map.insert` requires every field to be explicitly provided even if only one changes:

```compact
export circuit vacate(id: Uint<64>): [] {
  const publicId = disclose(id);
  assert(lockers.member(publicId), "locker does not exist");
  const box = lockers.lookup(publicId);
  assert(box.status == LockerStatus.RENTED, "locker is not rented");
  assert(box.codeHash == combinationCommitment(myCombination()), "wrong combination");
  lockers.insert(publicId, Locker { ...box, status: LockerStatus.AVAILABLE });
  lockerBank.pushFront(publicId);
}
```

`disclose()` is required on any circuit value that gets written to the ledger. Compact's taint system treats all circuit inputs as potentially private; `disclose()` is your explicit declaration that a value is public. Without it, the compiler rejects the ledger operation.

---

## Step 3 - Compile

With the contract written, compile it to generate the TypeScript bindings and circuit keys before writing any TypeScript:

```bash
npm run compact
```

You should see two circuits compiled: `rent` and `vacate`. The managed output at `contract/src/managed/locker/` is what the CLI imports.

---

## Step 4 - The witness

The witness file implements the `witness myCombination()` function declared in the contract. The proof server calls this during proof generation to retrieve the combination bytes. Nothing returned from a witness appears in any public transcript — the data is used inside the ZK circuit and only the resulting proof is submitted on-chain.

```bash
touch contract/src/witnesses.ts
```

This repo's `LockerPrivateState` is different from example-counter's. Rather than using an empty private state (`Record<string, never>`), it holds the combination as a typed field. This gives the type system a concrete shape and means the combination persists in levelDB between sessions:

```typescript
import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { type Ledger } from './managed/locker/contract/index.js';

export type LockerPrivateState = {
  combination: Uint8Array;
};

export const createLockerPrivateState = (): LockerPrivateState => ({
  combination: new Uint8Array(32),
});

// Set the combination immediately before calling callTx.rent() or callTx.vacate().
let _combination = new Uint8Array(32);

export const setCombination = (combination: number): void => {
  _combination = new Uint8Array(32);
  new DataView(_combination.buffer).setUint32(0, combination, false);
};

export const witnesses = {
  myCombination: ({ privateState }: WitnessContext<Ledger, LockerPrivateState>): [LockerPrivateState, Uint8Array] => {
    // Prefer the in-memory value if set (non-zero), otherwise fall back to private state.
    const combo = _combination.some((b) => b !== 0) ? _combination : privateState.combination;
    if (!combo.some((b) => b !== 0)) {
      throw new Error('No combination set - call setCombination() before rent() or vacate()');
    }
    // Return the updated private state so the combination persists in levelDB after each call.
    return [{ ...privateState, combination: combo }, combo];
  },
};
```

The module-level `_combination` buffer is set right before each circuit call. The witness prefers it if non-zero, then falls back to whatever is already stored in levelDB. An all-zero combination throws immediately, surfacing a missing `setCombination()` call as a clear error rather than a silent wrong-combination failure on-chain.

Every witness returns `[newPrivateState, witnessReturnValue]`. Returning `{ ...privateState, combination: combo }` as the first element updates the stored private state after each call.

---

## Step 5 - CLI wiring

The `common-types.ts`, `config.ts`, entry points, and wallet setup follow the same patterns as example-counter. The notable differences in `api.ts` are in the circuit calls section.

`rent()` takes no ID parameter because the contract assigns the slot automatically. After the transaction lands, `totalLockers` holds the newly assigned ID for a fresh slot:

```typescript
export const rent = async (
  c: DeployedLockerContract,
  providers: LockerProviders,
  combination: number,
): Promise<bigint> => {
  setCombination(combination);
  await c.callTx.rent();
  const state = await getLedgerState(providers, c.deployTxData.public.contractAddress);
  return state?.totalLockers ?? 0n;
};

export const vacate = async (c: DeployedLockerContract, id: bigint, combination: number) => {
  setCombination(combination);
  await c.callTx.vacate(id);
};
```

`lockerBank` is a `List<T>`, and the generated TypeScript type for it is iterable. Reading the bank state is a simple spread:

```typescript
export const getAvailableLockers = async (
  providers: LockerProviders,
  contractAddress: ContractAddress,
): Promise<bigint[]> => {
  assertIsContractAddress(contractAddress);
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) return [];
  return [...LockerContract.ledger(state.data).lockerBank];
};
```

---

## Step 6 - Run it

Start the proof server first. All transactions on Midnight require ZK proofs, including simple state updates, so the proof server must be running before the first transaction is submitted:

```bash
docker compose -f proof-server.yml up -d
```

With the proof server running, start the CLI against the preprod network:

```bash
npm run preprod
```

On first run with a new wallet, fund it at [faucet.preprod.midnight.network](https://faucet.preprod.midnight.network/) using the address printed to the terminal.

---

## What to try

Once you have the CLI running:

1. **Rent a locker** — no ID needed, the contract assigns one. The CLI shows if a vacated slot will be reused or a new one created.
2. **Try the wrong combination on vacate** — the assert fails, the transaction is rejected, the locker stays rented.
3. **Vacate it** — enter the correct combination; the ZK proof is generated and verified on-chain without revealing the digits.
4. **Rent again** — the vacated slot appears in the available list and gets reused automatically.

---

## Project structure

```
example-locker/
  contract/
    src/
      locker.compact    # Compact smart contract
      witnesses.ts      # Witness implementation + LockerPrivateState
      managed/          # Generated by npm run compact (gitignored)
  locker-cli/
    src/
      config.ts         # Network configs (standalone, preprod)
      common-types.ts   # Type aliases for midnight-js
      api.ts            # Contract operations + wallet setup
      cli.ts            # Interactive CLI
      standalone.ts     # Entry: local devnet
      preprod.ts        # Entry: preprod
  proof-server.yml
  package.json
  tsconfig.json
  .gitignore
```
