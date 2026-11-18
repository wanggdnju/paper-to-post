# Browser-automation drivers (optional)

Working Zhihu and Xiaohongshu drivers, built on [browser-skill](https://github.com/)\'s
`bsk` CLI. **They are not part of the default pipeline** and are not installed
automatically — they require a tool most users will not have.

## Why they live here rather than in `scripts/drivers/`

`bsk` drives a real browser: it needs the CLI installed, a browser profile where you
are logged in, and a debugging port. Shipping it as a built-in driver would mean every
user needs that same setup before `npm run publish:platform` works at all.

Keeping them in `examples/` means:

- the default pipeline stays dependency-free (`manual` and `wechat` work out of the box)
- the working implementation is still available to anyone who wants full automation
- the location itself signals "you need to opt in"

## Setup

```bash
# 1. Install bsk, then log in to each platform once in the browser it drives.
#    The installer puts the binary in ~/.local/bin, which is usually not on PATH;
#    the drivers look there explicitly.

# 2. Copy the drivers into the project.
mkdir -p drivers
cp examples/drivers/*.mjs drivers/

# 3. Run them.
npm run publish:platform -- --slug=<slug> --to=zhihu
npm run publish:platform -- --slug=<slug> --to=xiaohongshu
```

If `bsk` is missing, `preflight` fails immediately with an explanation rather than
half-filling an editor.

## What they automate

| Driver | Automated | Still manual |
| --- | --- | --- |
| `zhihu` | Title, body paste, images, figure captions, formulas, sidebar TOC, topic chips, draft URL writeback, refresh-and-verify | Reviewing layout, pressing publish |
| `xiaohongshu` | Image upload, title, body, hashtags, save-draft | Pressing publish |

Xiaohongshu used to be body-only. The upload step turned out to be reliable once the
two gotchas were handled: there are two identically named "上传图文" tabs and only the
second one responds, and all six images must go in a single `upload` call — uploading
them one at a time silently drops everything after the first.

**Neither driver presses publish.** Both stop at a saved draft.

## What is in these files

| File | Role |
| --- | --- |
| `zhihu.mjs` / `xiaohongshu.mjs` | Driver adapters implementing the interface in `scripts/drivers/index.mjs` |
| `xhs-prepare.mjs` | Xiaohongshu: switch to image mode, upload all slides, set the title |
| `bsk-retry.mjs` | Thin bsk wrapper: re-syncs before every action, retries transient failures |
| `zhihu-fill.mjs` | Fills the Draft.js editor: text as HTML paste, images as file paste |
| `zhihu-verify.mjs` | Forces a reload, then compares the editor against `dist/zhihu/<slug>.html` |
| `xhs-fill.mjs` | Writes body and hashtags into the ProseMirror editor, then saves the draft |

Read `zhihu.mjs` first — it shows the whole shape of a driver: preflight, session
lifecycle, delegation to a script, verification, and cleanup of the session in a
`finally` block.

## Three things that will bite you

**`bsk` may not be on PATH.** The official installer writes to `~/.local/bin`. The
drivers resolve the binary once and pass it to child scripts via `BSK_BIN`, because
otherwise the parent finds it and the child fails with `spawnSync bsk ENOENT`.

**Sessions are browser tabs.** If a driver throws between starting a session and
stopping it, tabs are left open. Both adapters start the session inside the `try` and
stop it in `finally`. If you copy this structure, keep that ordering.

**A write can succeed while its reply is lost.** After uploading images, the editor
keeps processing them and CDP starts answering `Previous operation is still settling`.
A write issued in that window may land, but bsk never receives confirmation, so it
records the operation as `UNKNOWN` and freezes the tab — every later action fails with
`a prior action has an unconfirmed side effect`.

Observed once: the script reported "body is 0 characters" while the editor actually held
414 characters and all hashtags. Before rewriting, sync and read the editor:

```bash
bsk ledger status  --session <s>                              # find the UNKNOWN op
bsk ledger resolve --session <s> --operation-id <op>          # reconcile, then continue
```

Rewriting is the wrong recovery: ProseMirror accepts one write, and the first one may
already have been correct.

## The behaviours these encode

The scripts are mostly a record of things that did not work:

- Zhihu no longer uploads `data:` URI images pasted as HTML — eight images become the
  same broken placeholder. Images must be pasted as files (`DataTransfer` + `File`).
- Formulas are written by `render:zhihu` as `data-eeimg="2"` blocks, so they arrive
  centred. The old path (toolbar formula card) produced left-aligned inline formulas
  and left two empty paragraphs each time.
- Figure captions live in the `alt` attribute and get typed into the editor's
  `figcaption`, because `<img><br>caption` degrades into a plain paragraph.
- The Xiaohongshu editor is ProseMirror: a single bulk insertion is classified as
  non-human input, control is handed back, and it does not recover. The body is written
  once, last, after images and title.
- Verification must reload the page first. Reading the current DOM proves nothing —
  both editors hold their content in memory.

Details and more failure modes: [../docs/drivers.md](../../docs/drivers.md) and
[../docs/browser-automation.md](../../docs/browser-automation.md).
