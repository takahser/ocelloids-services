import * as path from 'node:path';
import { readFileSync } from 'node:fs';

import { decode } from 'cbor-x';
import { TypeRegistry, Metadata } from '@polkadot/types';
import { createSignedBlockExtended } from '@polkadot/api-derive';
import type { SignedBlock, EventRecord, AccountId } from '@polkadot/types/interfaces';

import { HexString } from '../services/monitoring/types';

export type BinBlock = {
  block: Uint8Array;
  events: Uint8Array[];
  author?: Uint8Array;
}

type RpcResult = {
  jsonrpc: string,
  id: number,
  result: HexString
}

export function testBlocksFrom(file: string, metadataFile: string) {
  const bufferBlock = readFileSync(path.resolve(__dirname, '__data__', file));
  const blocks: BinBlock[] = decode(bufferBlock);

  const m = readFileSync(path.resolve(__dirname, '__data__/metadata', metadataFile)).toString();
  const r : RpcResult = JSON.parse(m);

  const registry = new TypeRegistry() as any;
  const metadata = new Metadata(registry, r.result);

  registry.setMetadata(metadata);

  return blocks.map(b => {
    const block = registry.createType('SignedBlock', b.block);
    const records = registry.createType('Vec<EventRecord>', b.events, true);
    const author = registry.createType('AccountId', b.author);

    return createSignedBlockExtended(
      registry,
      block as SignedBlock,
      records as unknown as EventRecord[],
      null,
      author as AccountId
    );
  });
}