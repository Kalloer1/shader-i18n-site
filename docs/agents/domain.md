# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This repo keeps vocabulary and decisions in **`README.md`**, not in separate files. It consolidated
its docs on 2026-10-09 (see README「历史决策摘要」第 8 条). Do **not** create `GLOSSARY.md` or
`docs/adr/` here.

- **Vocabulary**: `README.md` → `## 术语` section.
- **Decisions**: `README.md` → `## 历史决策摘要` section (numbered list, one line each).
- **Architecture and flow**: `README.md`, plus `FLOW.md` for the pipeline diagrams.
- **Directory responsibilities** (what is hand-written vs generated vs never-touch): `docs/项目结构.md`.
- **Known problems and lessons**: `docs/用户问题记录.md` (the authoritative ledger).

If a term or decision you need isn't recorded, that's a signal: either you're inventing language the
project doesn't use (reconsider), or there's a real gap (note it for `/domain-modeling`, which will
add it to the README section rather than a new file).

## ⚠️ `glossary.json` is NOT a glossary

Two different things share the word "glossary" in this repo. Confusing them is destructive.

| | `GLOSSARY.md` (does not exist here) | `site/data/glossary.json` (**exists, 4.4 MB**) |
|---|---|---|
| Purpose | Human-readable vocabulary — what a term *means* | Machine translation memory — what English *maps to* in Chinese |
| Shape | `**光影包（Shaderpack）**：放入 shaderpacks 目录的压缩包` | `"sky & clouds": "天空与云"` |
| Entries | ~8 | ~39,448 |
| Consumers | People and agents, for consistent naming | `scripts/pipeline.mjs` at translation time (a hit skips the LLM) |

`site/data/glossary.json` is **runtime data with a real cost to rebuild** — a pipeline that reads it
must never be pointed at a hand-written glossary, and it must never be deleted as "duplicate docs".
Related code: `scripts/lib/glossary.mjs` (shared pure functions), `scripts/rebuild-glossary.mjs`
(one-off rebuild), `tests/glossary.test.mjs`.

## Use the vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in README「术语」. Don't drift to synonyms it explicitly avoids —
e.g. 「光影包」not 材质包/资源包, 「汉化文件」not 汉化包, 「AI 初翻」not 机翻.

## Flag decision conflicts

If your output contradicts a numbered entry in README「历史决策摘要」, surface it explicitly rather
than silently overriding:

> _Contradicts 历史决策摘要 第 7 条（免费层优先）, but worth reopening because…_
