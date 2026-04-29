# IDL attribution

`jupiter-perpetuals-idl.ts` is vendored from
[`julianfssen/jupiter-perps-anchor-idl-parsing`](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing)
(ISC license). The IDL is the on-chain Anchor IDL for the Jupiter
Perpetuals program at `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`.

We vendor rather than fetch on-chain so the adapter has no runtime
dependency on Anchor's IDL fetcher and can be typechecked offline.
Re-sync this file if Jupiter ships a program upgrade that adds new
instructions or accounts we want to support.
