// Public metadata: keep ordinary RTL text, combining marks, ZWJ/ZWNJ and emoji.
// Reject terminal controls, direction overrides and hidden separators. This is
// a display-content contract, not HTML sanitization or identifier normalization.
export const UNSAFE_PUBLIC_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
