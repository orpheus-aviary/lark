# ffmpeg stub

Not an ffmpeg. Two scripts that answer `-version` and the inventory flags, so
`just package-fixture` can exercise the packaging MECHANISM — extraResources
copying, the `LARK_MEDIA_TOOLS_DIR` injection, the resolver's bundle level, the
NOTICE staging choice — without a four-minute toolchain build.

It is deliberately incapable of transcoding, and `just fetch-ffmpeg`'s
verification rejects it at the first gate (not a Mach-O binary). `just package
bundled` runs that verification before every build, so this can never reach
`release/bundled/`. Its output goes to `release/fixture/`, which the release
gate never reads.
