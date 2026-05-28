#!/usr/bin/env python3
# md-to-gchat — Convert Markdown to Google Chat message format
#
# Google Chat markup vs Markdown:
#   Bold:          **text**   →  *text*
#   Strikethrough: ~~text~~   →  ~text~
#   Bullets:       * / -      →  •
#   H1:            # Title    →  *TITLE*
#   H2:            ## Title   →  *Title*
#   H3:            ### Title  →  • *Title*
#   Links:         [t](url)   →  t (url)
#   Hr:            ---        →  (blank)
#   Code fence:    ```lang    →  ``` (language hint stripped)
#
# Usage:
#   echo "# Hello **world**" | ./tools/md-to-gchat.sh
#   ./tools/md-to-gchat.sh file.md
#   ./tools/md-to-gchat.sh < file.md
#
import re, sys


def inline(text):
    """Apply inline Markdown → Google Chat conversions."""
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)   # links
    text = re.sub(r"\*\*\*([^*]+)\*\*\*", r"*_\1_*", text)        # bold+italic
    text = re.sub(r"\*\*([^*]+)\*\*", r"*\1*", text)              # bold
    text = re.sub(r"~~([^~]+)~~", r"~\1~", text)                  # strikethrough
    return text


def convert(text):
    lines = text.split("\n")
    out = []
    in_code = False
    prev_blank = False

    for line in lines:
        # Code fence — strip language hint, pass content through unchanged
        if re.match(r"^```", line):
            in_code = not in_code
            out.append("```")
            prev_blank = False
            continue
        if in_code:
            out.append(line)
            prev_blank = False
            continue

        # Horizontal rule → blank line
        if re.match(r"^[-*_]{3,}\s*$", line):
            if not prev_blank:
                out.append("")
                prev_blank = True
            continue

        # H1 → *TITLE*
        m = re.match(r"^#\s+(.*)", line)
        if m:
            out.append(f"*{inline(m.group(1)).upper()}*")
            prev_blank = False
            continue

        # H2 → *Title*
        m = re.match(r"^##\s+(.*)", line)
        if m:
            out.append(f"*{inline(m.group(1))}*")
            prev_blank = False
            continue

        # H3 → • *Title*
        m = re.match(r"^###\s+(.*)", line)
        if m:
            out.append(f"• *{inline(m.group(1))}*")
            prev_blank = False
            continue

        # Bullets: "* " or "- " at line start → "• "
        line = re.sub(r"^\s*[*-]\s+", "• ", line)

        # Apply inline formatting to body text
        line = inline(line)

        # Collapse consecutive blank lines
        if line.strip() == "":
            if not prev_blank:
                out.append("")
                prev_blank = True
            continue

        out.append(line)
        prev_blank = False

    return "\n".join(out).strip()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        with open(sys.argv[1]) as f:
            text = f.read()
    else:
        text = sys.stdin.read()
    print(convert(text))
