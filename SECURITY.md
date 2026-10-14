# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Write to **security@silykat.com** instead, with:

- what you found and where (file, command, version);
- how to reproduce it;
- what an attacker could do with it.

You will get an answer within a week. Once the fix is released, the report can be made public, with your name if you wish.

## Supported versions

Only the latest release is supported: fixes are not backported.

## What silykat does with your data

silykat keeps everything on your machine, in plain files (`.silykat/` in your repositories, `~/.silykat/`). It makes no network call and collects no telemetry, except one opt-in: the classification of a retro by Jev, only if you set up its key. See the [README](README.md#where-your-data-lives).
