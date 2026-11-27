// TEXT_KEPT and headOf from Fei-Craft/DS-Bot d104d9ca18d69a35460f14e15dff4d553181433a.
// Copyright 2026 Fei2411 and the DS Bot contributors. Apache-2.0 (see ported/NOTICE).

export const TEXT_KEPT = 2000
export const headOf = (text, max) => (text.length <= max ? text : text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max))
