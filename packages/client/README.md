# Ocelloids Client Library

<a href="https://www.npmjs.com/package/@sodazone/ocelloids-client"><img src="https://img.shields.io/npm/v/@sodazone/ocelloids-client?color=69D2E7&labelColor=69D2E7&logo=npm&logoColor=333333" alt="npm @sodazone/ocelloids-client" /></a> 

TypeScript client library to interact with Ocelloids Service APIs.

[Documentation Site](https://sodazone.github.io/ocelloids-services/).

## Install

NPM
```shell
npm install @sodazone/ocelloids-client
```

Yarn
```shell
yarn add @sodazone/ocelloids-client
```

## Usage

```typescript
import { OcelloidsClient, isXcmReceived, isXcmSent } from "@sodazone/ocelloids-client";

const client = new OcelloidsClient({
  httpUrl: "http://127.0.0.1:3000",
  wsUrl: "ws://127.0.0.1:3000"
});

// subscribe on-demand
const ws = client.subscribe({
  origin: "urn:ocn:polkadot:2004",
  senders: "*",
  events: "*",
  destinations: [ 
    "urn:ocn:polkadot:0",
    "urn:ocn:polkadot:1000",
    "urn:ocn:polkadot:2000",
    "urn:ocn:polkadot:2034",
    "urn:ocn:polkadot:2104"
  ]
}, {
 onMessage: msg => {
   if(isXcmReceived(msg)) {
     console.log("RECV", msg.subscriptionId);
   } else if(isXcmSent(msg)) {
     console.log("SENT", msg.subscriptionId)
   }
   console.log(msg);
 },
 onError: error => console.log(error),
 onClose: event => console.log(event.reason)
});
```

[Explore the documentation site for further details](https://sodazone.github.io/ocelloids-services/).

## Development

Enable corepack:

```shell
corepack enable
```

Install dependencies and build the project:

```shell
yarn && yarn build
```

## Testing

Run unit tests:

```shell
yarn test
```

## Compatibility

Compatible with [browser environments, Node, Bun and Deno](https://github.com/sodazone/ocelloids-services/blob/main/packages/client/test).
