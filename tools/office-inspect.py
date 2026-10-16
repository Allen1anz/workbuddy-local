"""Inspect OOXML text and replace text runs in a new copy, without executing macros."""

import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED


def xml(blob):
    if b"<!DOCTYPE" in blob.upper() or b"<!ENTITY" in blob.upper():
        raise ValueError("XML entity declarations are not supported")
    return ET.fromstring(blob)


def inspect(archive, suffix):
    if suffix == ".docx":
        root = xml(archive.read("word/document.xml"))
        return {"paragraphs": ["".join(n.text or "" for n in p.findall(".//{*}t")) for p in root.findall(".//{*}p")]}
    if suffix == ".pptx":
        names = [n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
        names.sort(key=lambda n: int(re.search(r"slide(\d+)\.xml", n).group(1)))
        return {"slides": [{"part": name, "paragraphs": ["".join(n.text or "" for n in p.findall(".//{*}t")) for p in xml(archive.read(name)).findall(".//{*}p")]} for name in names]}
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = ["".join(n.text or "" for n in item.findall(".//{*}t")) for item in xml(archive.read("xl/sharedStrings.xml")).findall("{*}si")]
    sheets = []
    names = [n for n in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)]
    names.sort(key=lambda n: int(re.search(r"sheet(\d+)\.xml", n).group(1)))
    for name in names:
        cells = []
        for cell in xml(archive.read(name)).findall(".//{*}c"):
            value = cell.findtext("{*}v", "")
            if cell.attrib.get("t") == "s":
                value = shared[int(value)]
            elif cell.attrib.get("t") == "inlineStr":
                value = "".join(n.text or "" for n in cell.findall(".//{*}t"))
            cells.append({"cell": cell.attrib.get("r"), "value": value, "formula": cell.findtext("{*}f")})
        sheets.append({"part": name, "cells": cells[:10000], "truncated": len(cells) > 10000})
    return {"sheets": sheets}


def replace_runs(blob, replacements, counts):
    xml(blob)
    source = blob.decode("utf-8")
    pattern = r"(<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>)([^<]*)(</(?:[A-Za-z_][\w.-]*:)?t>)"
    def patch(match):
        decoded = xml(("<root>" + match.group(2) + "</root>").encode()).text or ""
        for index, item in enumerate(replacements):
            counts[index] += decoded.count(item["from"])
            decoded = decoded.replace(item["from"], item["to"])
        return match.group(1) + escape(decoded) + match.group(3)
    return re.sub(pattern, patch, source).encode("utf-8")


def main():
    spec = json.load(sys.stdin)
    source = Path(sys.argv[1])
    if source.suffix.lower() not in (".docx", ".xlsx", ".pptx"):
        raise ValueError("Only docx, xlsx, and pptx files are supported")
    with ZipFile(source) as archive:
        if len(archive.infolist()) > 10000 or sum(p.file_size for p in archive.infolist()) > 64_000_000:
            raise ValueError("Document expands beyond the 64 MB limit")
        if spec.get("operation") == "inspect":
            result = inspect(archive, source.suffix.lower())
        elif spec.get("operation") == "replace":
            replacements = spec.get("replacements")
            if not isinstance(replacements, list) or not 1 <= len(replacements) <= 100:
                raise ValueError("Provide 1 to 100 text replacements")
            for item in replacements:
                if not isinstance(item.get("from"), str) or not item["from"] or not isinstance(item.get("to"), str):
                    raise ValueError("Each replacement requires a nonempty from and a string to")
            counts = [0] * len(replacements)
            output = Path(sys.argv[2])
            if output.resolve() == source.resolve():
                raise ValueError("Output must be a new copy")
            with ZipFile(output, "w", ZIP_DEFLATED) as target:
                for part in archive.infolist():
                    blob = archive.read(part.filename)
                    if part.filename.endswith(".xml") and (part.filename.startswith(("word/", "ppt/slides/", "xl/worksheets/")) or part.filename == "xl/sharedStrings.xml"):
                        blob = replace_runs(blob, replacements, counts)
                    target.writestr(part, blob)
            result = {"counts": counts, "unmatched": [replacements[i]["from"] for i, count in enumerate(counts) if not count], "limitation": "Matches within an XML text run; text spanning multiple formatting runs is not changed. Original package parts and layout are retained."}
        else:
            raise ValueError("operation must be inspect or replace")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
