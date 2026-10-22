# Third-party notices

Zcode-WE 基于 zcode-beautify-for-wallpaper-engine 项目，并采用自研窗口合成方法。项目源码采用 MIT License；以下第三方版权与许可仍须保留。

## zcode-beautify-for-wallpaper-engine

Source: https://github.com/sorrowKnight123/zcode-beautify-for-wallpaper-engine

The semantic surface-token mapping in `appearance.cjs` is adapted from
`src/core/tokens.ts` (`buildTransparencyOverrides`). The adaptation retains
ZCode's light/dark theme, foreground, status, and accent colors, and adds
adjustable surface opacity and a background dim overlay. The independent
native renderer and local MediaStream composition are developed for Zcode-WE.

MIT License

Copyright (c) 2026 Logocceai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Newtonsoft.Json 13.0.3

Source: https://github.com/JamesNK/Newtonsoft.Json

License source: https://github.com/JamesNK/Newtonsoft.Json/blob/13.0.3/LICENSE.md

The native build retrieves the pinned 13.0.3 package from the official NuGet
service and verifies the dependency before use. The source repository does
not track the downloaded DLL. The following license applies to the library
and must accompany distributed builds that include it.

The MIT License (MIT)

Copyright (c) 2007 James Newton-King

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ZCode, Wallpaper Engine and wallpaper content

Zcode-WE invokes locally installed ZCode and Wallpaper Engine and reads local
wallpaper projects. This repository does not distribute their executables,
application packages, or wallpaper assets. Names and content remain the
property of their respective owners. This project is not an official product
of, and does not imply endorsement by, those owners.
