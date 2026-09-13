# Worksheet Chinese typography

Noto Sans HK is hosted locally under the SIL Open Font License in OFL.txt.
Source: https://github.com/google/fonts/tree/main/ofl/notosanshk
The WOFF2 subsets were obtained from the Google Fonts CSS API (v35).
Refresh with `python scripts/vendor-worksheet-font.py` from the repository root.

The private CSS family `Worksheet Chinese` is restricted to CJK characters and
punctuation. It precedes the existing Latin font stack, so English retains its
existing font. This family is only loaded by the worksheet editor, viewer and
print report, not RolePlayScene. Weight range: 400–700.

Unicode-range subsets let the browser request only files needed for visible
characters. The complete collection is about 5.3 MB; it is not downloaded in
full on every visit. `font-display: swap` keeps text visible during downloads.
No runtime Google Fonts requests are required. Offline uncached HTML falls
back to system fonts; printed PDFs retain the appearance captured at printing.
