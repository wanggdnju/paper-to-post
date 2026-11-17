# Synthetic example: TinyLM

A complete article directory for a **fictional paper**, showing what each stage of the
pipeline produces. Nothing here is a real publication: the paper, the numbers, the
repository and the figures are all invented.

The example passes every machine check in `publish-check` (34 checks) and renders to
Zhihu HTML and a self-contained H5 page, so it doubles as a regression fixture.

## Files

| File | Produced by | Purpose |
| --- | --- | --- |
| `article.yaml` | `publish --stage=new` | State machine and per-article metadata |
| `briefing.md` | `briefing` | The one-page writing brief |
| `facts.json` | `facts` | Every number and table cell, extracted from the source |
| `outline.json` | `outline` | Section plan; each section declares the fact IDs it may cite |
| `article.md` | `generate` + `polish` | The article itself, 8 sections plus a Q&A appendix |
| `critic.json` | `critic` | Claim-level audit of the finished text |
| `xhs.md` | `derive --only=xhs` | Short-form copy for Xiaohongshu |
| `assets/links.json` | `extract-links` | Repository, model and project links |
| `assets/figures.json` | `fetch:figures` | Figure inventory with section hints |
| `assets/fig-*.png` | `fetch:figures` | Schematic figures, drawn for this example |

## Reading order

Read `facts.json` → `outline.json` → `article.md`. The three files show the central
constraint of the pipeline: the outline assigns fact IDs to each section before
writing starts, so the generator can only cite numbers that already exist.

Compare the `factIds` in `outline.json` with the numbers in `article.md`. Every decimal
in the article appears in `facts.json`; `verify-numbers` enforces this mechanically, and
will fail the build if one does not.

## Running it

The tooling expects articles under `articles/`:

```bash
cp -r examples/minimal articles/minimal

npm run publish:check -- --slug=minimal     # 34 machine checks
npm run verify:numbers -- --slug=minimal    # every decimal traced to facts.json
npm run derive -- --slug=minimal --only=zhihu
npm run render:zhihu -- --slug=minimal      # -> dist/zhihu/minimal.html
npm run publish:platform -- --slug=minimal  # manual driver: lists artifacts
```

`derive` for Xiaohongshu requires a model call; Zhihu derivation and all rendering are
rule-based and run offline.

## What the example does not cover

- **Real figures.** Production figures are extracted from the paper's PDF. These two
  are hand-drawn schematics.
- **Platform drafts.** No WeChat draft is created, and no Zhihu or Xiaohongshu editor is
  touched — those require credentials or a driver implementation.
- **Scale.** A production article is comparable in length but goes through several
  rounds of `critic`; this one has two low-severity findings and no rewrites.
