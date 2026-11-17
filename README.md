<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="paper-to-post" width="330">
  </picture>
</p>

<p align="center"><b>Every number in the output traces back to the paper.</b></p>

<p align="center">
  Turn an arXiv paper into publication-ready drafts for multiple platforms —<br>
  and fail the build when the prose disagrees with the source.
</p>

<p align="center">
  <a href="https://github.com/wanggdnju/paper-to-post/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/wanggdnju/paper-to-post/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.18-5FA04E">
  <img alt="Platforms" src="https://img.shields.io/badge/output-zhihu%20%7C%20wechat%20%7C%20xiaohongshu-2f6bff">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/pipeline-overview.md">Pipeline</a> ·
  <a href="docs/drivers.md">Drivers</a> ·
  <a href="examples/">Examples</a> ·
  <a href="examples/drivers/">Automation</a> ·
  <a href="docs/zhihu-workflow.md">Platform notes</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

---

Reading a paper and writing it up is not the hard part. Getting the facts right is.
Language models routinely turn "3.7% faster" into "37% faster", move a number from
Table 1 into Table 2, and describe an untested setting as a poor result.

This repository is organized around preventing that. Facts are extracted and frozen
before any prose is generated, and every claim is checked against them afterwards.

## How it works

```
ingest → research → structure → write → polish → review → render → publish
```

| Stage | Command | Output |
| --- | --- | --- |
| Ingest | `npm run publish -- --stage=new` | `articles/<slug>/article.yaml` (state machine) |
| Assets | `npm run fetch:all` | Paper text, figures, tables, links |
| Research | `npm run research:paper` | Lineage, community discussion, related work |
| Brief | `npm run briefing` | One-page writing brief |
| Structure | `npm run facts` `glossary` `outline` | Number table, glossary, section outline |
| Write | `npm run pipeline` | `article.md` (8 sections, concurrent) |
| Polish | `npm run polish` | Rewrites prose; facts, tables and formulas are byte-checked |
| Review | `npm run critic` `verify:numbers` `publish:check` | Claim-level audit, 34 structural checks |
| Render | `npm run finalize` | `dist/{html,zhihu,wechat,xhs}` |
| Publish | `npm run publish:platform` | Handed to a publish driver |

Each stage is a standalone script and can be re-run in isolation. `pipeline.mjs` only
sequences them, stops on failure, and records timing and token spend. Interrupted runs
resume from the first missing artifact (`--from=generate`), or regenerate a single
section (`--only=s4 --force`).

### Verification

The validity of the output rests on four mechanisms:

| Mechanism | Behaviour |
| --- | --- |
| `facts.json` | Extracts every number, table and comparison from the LaTeX source; single source of truth |
| `critic` | Checks each claim in the prose against facts; flags unsupported and conflicting statements |
| `verify-numbers` / `verify-table` | Matches every decimal and every table cell; wide and compact table renderings checked separately |
| `polish` guards | Rewrites expression only — headings, table rows, formula blocks are byte-identical, the set of numbers must be unchanged, length within ±20% |

A stage that fails verification keeps the previous version rather than writing a
degraded one.

## Requirements

- Node.js 20.18 or newer
- An OpenAI-compatible or Anthropic-compatible LLM endpoint (`LLM_PROTOCOL=openai|anthropic`)
- Optional: Playwright's Chromium, used for figure extraction and image rendering

## Installation

```bash
npm install
npx playwright install chromium   # only needed for the asset and render stages
cp .env.example .env              # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
```

Writing is a long-output task; a context window of at least 32k tokens is recommended.

## Quick start

```bash
npm run publish  -- --slug=mypaper --stage=new --arxiv=2401.15077
npm run fetch:all -- --slug=mypaper --arxiv=2401.15077
npm run briefing  -- --slug=mypaper
npm run pipeline  -- --slug=mypaper --paper=/tmp/mypaper.txt --jobs=8
npm run finalize  -- --slug=mypaper
npm run publish:platform -- --slug=mypaper --to=wechat
```

`npm run publish -- --status` prints the state of every article.

## Example

[`examples/minimal/`](examples/minimal/) contains a complete article directory for a
fictional paper: metadata, writing brief, fact table, outline, the article itself, the
critic report and the rendered figures. It passes all 34 machine checks and renders to
both Zhihu HTML and a self-contained page.

```bash
cp -r examples/minimal articles/minimal
npm run publish:check -- --slug=minimal
npm run render:zhihu -- --slug=minimal
```

Use it as a reference for file structure, or as a fixture when changing the pipeline.

## Publishing drivers

Platform-specific publishing is isolated in `scripts/drivers/`. The core pipeline
renders artifacts; a driver decides what to do with them.

| Driver | Behaviour | Requirements |
| --- | --- | --- |
| `manual` (default) | Lists every artifact under `dist/` for manual upload | None |
| `wechat` | Official WeChat MP API: upload images, create or update a draft, verify by reading it back | `WECHAT_APPID`, `WECHAT_APPSECRET` |

```bash
npm run publish:platform -- --slug=mypaper                # manual
npm run publish:platform -- --slug=mypaper --to=wechat    # WeChat draft
```

Zhihu and Xiaohongshu are not built in. Both are web-editor only, so automating them
requires a specific browser tool; shipping one tool's integration would make the
repository unusable for anyone without it.

[`examples/drivers/`](examples/drivers/) contains a working implementation of both,
built on browser-skill's `bsk` CLI. Copy it in when you have the tool installed:

```bash
cp examples/drivers/*.mjs drivers/
npm run publish:platform -- --slug=mypaper --to=zhihu
```

An adapter for any other tool can be added the same way — create `drivers/<id>.mjs`
in the project root. See [docs/drivers.md](docs/drivers.md) for the interface.

**No driver presses publish.** Drafts and prefilled editors only; the final action is
left to the operator.

## Project structure

```
scripts/            40 stage scripts, each runnable on its own
scripts/lib/        LLM client, front matter, arXiv, LaTeX tables, concurrency pool
scripts/drivers/    Publishing drivers (manual, wechat)
publish/            Account positioning, writing spec, manual checklist, word list
docs/               Pipeline walkthrough, platform notes, driver interface
.claude/skills/     Agent skill encapsulating the workflow
examples/           Worked example article, plus optional browser drivers
articles/<slug>/    One directory per paper (not tracked by git)
```

## Design notes

- **One script per stage.** A failure is diagnosable and re-runnable in isolation; a
  single monolithic pipeline is not.
- **Hand-edited sources are authoritative.** `article.md`, `article.yaml` and
  `assets/links.json` are reviewed by a human. `facts.json`, `outline.json` and `dist/`
  are derived and can be rebuilt at any time.
- **Verification happens after the platform reads back.** Platforms rewrite submitted
  HTML — WeChat splits list items, and the Zhihu editor is in-memory state. A clean
  local file does not imply a clean draft.
- **Platform limitations are surfaced, not worked around.** WeChat strips anchor tags
  from article bodies, so links are rendered as QR codes and a single "read original"
  URL instead of being described as a formatting issue.

## Documentation

| File | Contents |
| --- | --- |
| [docs/pipeline-overview.md](docs/pipeline-overview.md) | Stage-by-stage inputs, outputs and acceptance criteria |
| [docs/drivers.md](docs/drivers.md) | Driver interface and implementation guide |
| [docs/zhihu-workflow.md](docs/zhihu-workflow.md) | Manual Zhihu workflow and editor behaviour |
| [docs/xiaohongshu-workflow.md](docs/xiaohongshu-workflow.md) | Manual Xiaohongshu workflow and editor behaviour |
| [docs/browser-automation.md](docs/browser-automation.md) | Browser automation pitfalls, tool-agnostic |
| [.claude/skills/paper-publish/](.claude/skills/paper-publish/) | Agent-facing runbook and failure catalogue |

Platform notes are written in Chinese, since the target platforms are Chinese-language.

## Testing

```bash
npm test    # unit tests for the shared libraries
```

## Contributing

Issues and pull requests are welcome. For changes to the pipeline, run `npm test` and
verify that `publish:check` still passes on an existing article.

## License

MIT — see [LICENSE](LICENSE).

Paper figures and PDFs remain the property of their respective authors. This
repository contains code and process only, no paper content.
