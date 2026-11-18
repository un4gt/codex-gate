# Codex model metadata snapshot

These unmodified assets come from [openai/codex](https://github.com/openai/codex/tree/29eb79e9866b3262a777fdf8195c1b9e63684c91), tag `rust-v0.170.0`, commit `29eb79e9866b3262a777fdf8195c1b9e63684c91`:

| File | Upstream path | SHA-256 |
| --- | --- | --- |
| `models.json` | `codex-rs/models-manager/models.json` | `d50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068` |
| `prompt.md` | `codex-rs/models-manager/prompt.md` | `ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807` |
| `LICENSE` | `LICENSE` | `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc` |
| `NOTICE` | `NOTICE` | `9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915` |

The upstream Apache-2.0 license and NOTICE accompany binary packages and Docker images under `licenses/openai-codex/`. The gateway embeds the model metadata and generic fallback prompt in its executable; this snapshot is not a live OAuth account entitlement list.

`backend/src/codex_catalog.rs` independently implements catalog rendering, informed by the negotiation, size limit and version compatibility design in [tbphp/gpt-load](https://github.com/tbphp/gpt-load/tree/d3307afa7991e3100a1564bd4f3190b19e78890f). No gpt-load implementation or assets are bundled.

Only models with an authorized Responses route enter the catalog. At runtime, the gateway adjusts visibility, API availability, ordering and alias identity, and removes redundant legacy instructions for compatible clients. Unknown models, protocol bridges and aliases with different target models use conservative metadata rather than inheriting another model's capabilities.

To update: choose a reviewed Codex release, copy all four upstream files without modifying them, update the pinned revision and hashes here, review the `ModelInfo` schema and generic fallback, then run the Rust tests and `scripts/run_codex_catalog_regression.py` with the corresponding native Codex executable. Verify both the ordinary OpenAI list and the native Codex catalog before releasing.
