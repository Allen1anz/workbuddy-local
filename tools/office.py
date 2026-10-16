"""Create small, valid OOXML documents from a JSON specification on stdin."""

import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

NS = "http://schemas.openxmlformats.org"
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


def rels(items):
    body = "".join('<Relationship Id="%s" Type="%s" Target="%s"/>' %
                   (escape(i), escape(t), escape(p)) for i, t, p in items)
    return XML + '<Relationships xmlns="%s/package/2006/relationships">%s</Relationships>' % (NS, body)


def types(overrides):
    body = "".join('<Override PartName="/%s" ContentType="%s"/>' %
                   (escape(p), escape(t)) for p, t in overrides)
    return XML + '<Types xmlns="%s/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>%s</Types>' % (NS, body)


def text(value):
    return escape(str(value)).replace("\x00", "")


def word(spec):
    paragraphs = spec.get("paragraphs", [])
    if not isinstance(paragraphs, list):
        raise ValueError("paragraphs must be an array")
    blocks = []
    for index, item in enumerate([spec.get("title", "文档")] + paragraphs):
        style = '<w:pPr><w:pStyle w:val="Title"/></w:pPr>' if index == 0 else ""
        runs = '<w:r><w:t xml:space="preserve">' + text(item) + '</w:t></w:r>'
        blocks.append('<w:p>' + style + runs + '</w:p>')
    document = XML + '<w:document xmlns:w="%s/wordprocessingml/2006/main"><w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>' % (NS, "".join(blocks))
    styles = XML + '<w:styles xmlns:w="%s/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style></w:styles>' % NS
    return {
        "[Content_Types].xml": types([("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"), ("word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml")]),
        "_rels/.rels": rels([("rId1", NS + "/officeDocument/2006/relationships/officeDocument", "word/document.xml")]),
        "word/document.xml": document,
        "word/styles.xml": styles,
        "word/_rels/document.xml.rels": rels([("rId1", NS + "/officeDocument/2006/relationships/styles", "styles.xml")]),
    }


def column(index):
    result = ""
    while index:
        index, rem = divmod(index - 1, 26)
        result = chr(65 + rem) + result
    return result


def workbook(spec):
    rows = spec.get("rows", [])
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError("rows must be an array with at most 10000 rows")
    sheet_rows = []
    for rindex, row in enumerate(rows, 1):
        if not isinstance(row, list) or len(row) > 1000:
            raise ValueError("each row must be an array with at most 1000 cells")
        cells = []
        for cindex, value in enumerate(row, 1):
            ref = column(cindex) + str(rindex)
            if isinstance(value, bool):
                cell = '<c r="%s" t="b"><v>%s</v></c>' % (ref, int(value))
            elif isinstance(value, (float, int)):
                cell = '<c r="%s"><v>%s</v></c>' % (ref, value)
            else:
                # Strings stay strings, including text beginning with "=".
                cell = '<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, text("" if value is None else value))
            cells.append(cell)
        sheet_rows.append('<row r="%s">%s</row>' % (rindex, "".join(cells)))
    name = str(spec.get("sheetName", "Sheet1"))[:31]
    for char in '[]:*?/\\':
        name = name.replace(char, "_")
    name = escape(name or "Sheet1", {'"': "&quot;"})
    return {
        "[Content_Types].xml": types([("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"), ("xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")]),
        "_rels/.rels": rels([("rId1", NS + "/officeDocument/2006/relationships/officeDocument", "xl/workbook.xml")]),
        "xl/workbook.xml": XML + '<workbook xmlns="%s/spreadsheetml/2006/main" xmlns:r="%s/officeDocument/2006/relationships"><sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>' % (NS, NS, name),
        "xl/_rels/workbook.xml.rels": rels([("rId1", NS + "/officeDocument/2006/relationships/worksheet", "worksheets/sheet1.xml")]),
        "xl/worksheets/sheet1.xml": XML + '<worksheet xmlns="%s/spreadsheetml/2006/main"><sheetData>%s</sheetData></worksheet>' % (NS, "".join(sheet_rows)),
    }


def textbox(ident, name, x, y, width, height, lines, size, color):
    paragraphs = "".join('<a:p><a:r><a:rPr lang="zh-CN" sz="%s"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:rPr><a:t>%s</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>' % (size, color, text(line)) for line in lines)
    return '<p:sp><p:nvSpPr><p:cNvPr id="%s" name="%s"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="%s" y="%s"/><a:ext cx="%s" cy="%s"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>%s</p:txBody></p:sp>' % (ident, name, x, y, width, height, paragraphs)


def presentation(spec):
    slides = spec.get("slides", [])
    if not isinstance(slides, list) or not 1 <= len(slides) <= 100:
        raise ValueError("slides must contain 1 to 100 items")
    pns = NS + "/presentationml/2006/main"
    ans = NS + "/drawingml/2006/main"
    rns = NS + "/officeDocument/2006/relationships"
    group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    namespace = 'xmlns:p="%s" xmlns:a="%s" xmlns:r="%s"' % (pns, ans, rns)
    parts = {}
    overrides = [("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"), ("ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"), ("ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml")]
    ids, links = [], []
    for index, slide in enumerate(slides, 1):
        if not isinstance(slide, dict):
            raise ValueError("each slide must be an object")
        body = slide.get("body", [])
        if isinstance(body, str):
            body = body.splitlines()
        if not isinstance(body, list):
            raise ValueError("slide body must be an array or string")
        content = textbox(2, "Title", 609600, 457200, 10972800, 914400, [slide.get("title", "")], 3200, "1C2841")
        content += textbox(3, "Body", 609600, 1676400, 10972800, 4419600, body, 2000, "364152")
        path = "ppt/slides/slide%s.xml" % index
        parts[path] = XML + '<p:sld %s><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FAF9F6"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>%s%s</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>' % (namespace, group, content)
        parts["ppt/slides/_rels/slide%s.xml.rels" % index] = rels([("rId1", rns + "/slideLayout", "../slideLayouts/slideLayout1.xml")])
        ids.append('<p:sldId id="%s" r:id="rId%s"/>' % (255 + index, index))
        links.append(("rId%s" % index, rns + "/slide", "slides/slide%s.xml" % index))
        overrides.append((path, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"))
    master_id = "rId%s" % (len(slides) + 1)
    links.append((master_id, rns + "/slideMaster", "slideMasters/slideMaster1.xml"))
    parts["ppt/presentation.xml"] = XML + '<p:presentation %s><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="%s"/></p:sldMasterIdLst><p:sldIdLst>%s</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>' % (namespace, master_id, "".join(ids))
    parts["ppt/_rels/presentation.xml.rels"] = rels(links)
    parts["ppt/slideMasters/slideMaster1.xml"] = XML + '<p:sldMaster %s><p:cSld><p:spTree>%s</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>' % (namespace, group)
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels([("rId1", rns + "/slideLayout", "../slideLayouts/slideLayout1.xml")])
    parts["ppt/slideLayouts/slideLayout1.xml"] = XML + '<p:sldLayout %s type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>%s</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>' % (namespace, group)
    parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = rels([("rId1", rns + "/slideMaster", "../slideMasters/slideMaster1.xml")])
    parts["[Content_Types].xml"] = types(overrides)
    parts["_rels/.rels"] = rels([("rId1", rns + "/officeDocument", "ppt/presentation.xml")])
    return parts


def main():
    spec = json.load(sys.stdin)
    format_name = spec.get("format")
    builders = {"docx": word, "xlsx": workbook, "pptx": presentation}
    if format_name not in builders:
        raise ValueError("format must be docx, xlsx, or pptx")
    parts = builders[format_name](spec)
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content.encode("utf-8"))
    print(json.dumps({"format": format_name, "bytes": output.stat().st_size}))


if __name__ == "__main__":
    main()
