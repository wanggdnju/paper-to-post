# Writing a publish driver

The pipeline renders artifacts and hands them to a driver. A driver moves them
into a platform. All platform-specific behaviour lives behind this interface.

## Rationale

The three target platforms are not comparable:

| Platform | Interface available | Automation ceiling |
| --- | --- | --- |
| WeChat MP | Official HTTP API | Create, update, read back and delete drafts — fully automatable |
| Zhihu | Web editor only | Requires browser automation |
| Xiaohongshu | Web editor only (ProseMirror) | Requires browser automation and is sensitive to synthetic input |

Browser automation depends on a specific tool. Embedding one tool's integration in
the pipeline would force every user to install it, so those two platforms ship as an
interface rather than an implementation.

## Interface

Create `drivers/<id>.mjs` in the project root and export a default object:

```js
export default {
  id: 'zhihu',
  label: 'Zhihu',
  requires: [],            // env vars that must be present; checked before publish
  needsRendered: 'zhihu',  // expects dist/zhihu/<slug>.html; null if not applicable

  async preflight(ctx) {
    // Validate credentials, artifacts and cover image. Call ctx.fail() on any
    // problem so it surfaces before the first write operation.
  },

  async publish(ctx) {
    // Perform the publish. Stop at the draft / prefilled editor stage.
    return {
      url: 'https://zhuanlan.zhihu.com/p/xxx',  // optional
      message: 'Loaded into the editor; awaiting manual submit',
      ok: true,
    };
  },
};
```

`--to=zhihu` loads it automatically. No change to `scripts/drivers/index.mjs` is
required.

## The `ctx` object

| Field | Description |
| --- | --- |
| `root` | Absolute path to the project root |
| `slug` | Article slug |
| `articleDir` | `articles/<slug>/`, containing `article.yaml`, `article.md`, `assets/` |
| `meta` | Parsed `article.yaml`: `title`, `digest`, `arxiv_id`, `platforms`, … |
| `args` | Parsed `--key=value` arguments, including driver-specific ones |
| `log(msg)` | Print a progress line |
| `fail(msg)` | Abort with a user-facing error; the CLI prints it and exits non-zero |

## Available artifacts

The render stage produces these; a driver only consumes them:

| Path | Contents |
| --- | --- |
| `dist/zhihu/<slug>.html` | Zhihu body HTML. Formulas are emitted as centred display blocks (`data-eeimg="2"`); images are local paths |
| `dist/wechat/<slug>.html` | WeChat body. Images are `@@IMG:` placeholders until uploaded and rewritten |
| `dist/html/<slug>.html` | Self-contained long-form page (KaTeX fonts inlined) |
| `dist/xhs/<slug>-00..NN.png` | Xiaohongshu slides, 780×1040; `-00-cover` is the cover |
| `articles/<slug>/xhs.md` | Short-form copy and hashtags |

## Reference implementation

`scripts/drivers/wechat.mjs` is a complete example. The patterns worth copying:

1. **Validate everything in `preflight`.** Missing cover, absent title, an author name
   that will be truncated — all of it should fail before any network write.
2. **Be idempotent.** The draft ID is stored in `article.yaml`; an existing draft is
   updated in place rather than duplicated. Five identically titled drafts in a queue
   are indistinguishable to the operator.
3. **Verify by reading back.** Re-fetch the published draft and compare it field by
   field. Platforms rewrite submitted HTML, so a clean local file proves nothing.
4. **Never press publish.** Drafts only.

## Notes for browser automation

The following apply to any tool — Playwright, Puppeteer, or a CDP client:

- **Editors are in-memory state.** The Zhihu Draft.js and Xiaohongshu ProseMirror
  editors do not reflect their content in the DOM. Closing the page discards unsaved
  content; a draft must be saved explicitly.
- **Setting `value` or `innerText` does not work** on rich-text editors: it does not
  fire the framework's input events. Use real keyboard events or a paste gesture.
- **Single large insertions can suspend control.** Some editors classify a bulk
  programmatic write as non-human input and hand control back to the user without
  recovering. The symptom is a caret that no longer responds.
- **Set the title at creation time.** Editing it afterwards can be overwritten by a
  stale snapshot.
- **Platforms strip outbound links.** WeChat removes `<a>` entirely from article
  bodies (readback reports `anchors=0`). This is a platform constraint, not a
  formatting bug: use QR codes, a "read original" link, or numbered sections instead,
  and state the limitation to readers.
- **Verify after a reload.** Reading state from the current DOM is not verification.

## Prior implementation

The author maintains a working Zhihu/Xiaohongshu implementation built on a browser
automation CLI, but it is not included here: it requires that specific tool and a
matching browser profile. Anyone replicating it should implement the interface above;
the rendered artifacts and contracts already line up.
