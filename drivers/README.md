# Publish drivers

Put `drivers/<id>.mjs` here and `npm run publish:platform -- --to=<id>` will load it.
No change to the pipeline is required.

Interface reference: [../docs/drivers.md](../docs/drivers.md).

Ready-made Zhihu and Xiaohongshu drivers (requiring the browser-skill `bsk` CLI) live in
[../examples/drivers/](../examples/drivers/):

```bash
cp examples/drivers/*.mjs drivers/
```
