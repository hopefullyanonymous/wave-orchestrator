#!/usr/bin/env python
"""Create the fixed synthetic Orders fixture, including formula caches.

Usage: python tests/fixtures/smoke-inputs/generate-orders.py <new-output.xlsx>
Standard library only. No existing file is overwritten; no other file is written.
ZIP_STORED and fixed metadata make bytes independent of time and zlib versions.
The independent validator reads orders.requirements.json, never this module.
"""

import argparse
from datetime import date
import io
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
from zipfile import ZIP_STORED, ZipFile, ZipInfo


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
ET.register_namespace("", MAIN)


def element(parent, name, **attrs):
    return ET.SubElement(parent, "{" + MAIN + "}" + name, attrs)


def sheet_xml(rows, widths, dimension):
    root = ET.Element("{" + MAIN + "}worksheet")
    element(root, "dimension", ref=dimension)
    views = element(root, "sheetViews")
    view = element(views, "sheetView", workbookViewId="0")
    element(view, "pane", ySplit="1", topLeftCell="A2", activePane="bottomLeft", state="frozen")
    cols = element(root, "cols")
    for index, width in enumerate(widths, 1):
        element(cols, "col", min=str(index), max=str(index), width=str(width), customWidth="1")
    data = element(root, "sheetData")
    for row_index, values in enumerate(rows, 1):
        row = element(data, "row", r=str(row_index))
        for column, (kind, value, style, cache) in enumerate(values, 1):
            if kind == "empty":
                continue  # A missing cell is genuinely empty, not an empty string.
            cell = element(row, "c", r=chr(64 + column) + str(row_index), s=str(style))
            if kind == "text":
                cell.set("t", "inlineStr")
                element(element(cell, "is"), "t").text = value
            elif kind == "formula":
                element(cell, "f").text = value
                element(cell, "v").text = str(cache)
            else:
                if kind == "boolean":
                    cell.set("t", "b")
                    value = int(value)
                element(cell, "v").text = str(value)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def text(value, style=0):
    return ("text", value, style, None)


def number(value, style=0):
    return ("number", value, style, None)


def formula(value, cache, style=4):
    return ("formula", value, style, cache)


def workbook_bytes():
    # All data are synthetic examples from the approved smoke-test specification.
    empty = ("empty", None, 0, None)
    orders = [[text(v, 1) for v in
               ("OrderID", "Item", "Quantity", "UnitPrice", "DiscountRate", "LineTotal", "Note")]]
    inputs = [
        ("0001", "Widget", 2, 12.5, 0.1, 22.5, "ordinary"),
        ("0002", "Zero quantity", 0, 10, 0, 0, None),
        ("0003", "Return", -1, 8, 0, -8, "return"),
        ("0004", "Café", 3, 4, 0.25, 9, "Unicode"),
    ]
    for n, (order_id, item, quantity, unit_price, discount, cache, note) in enumerate(inputs, 2):
        orders.append([text(order_id, 2), text(item), number(quantity, 3),
                       number(unit_price, 4), number(discount, 5),
                       formula(f"ROUND(C{n}*D{n}*(1-E{n}),2)", cache),
                       text(note) if note is not None else empty])
    summary = [[text("Metric", 1), text("Value", 1)],
               [text("Net total"), formula("SUM(Orders!F2:F5)", 23.5)],
               [text("Order count"), formula("COUNTA(Orders!A2:A5)", 4, 3)]]
    # Excel's 1900 date system includes its historical leap-day offset.
    serial = (date(2026, 9, 18) - date(1899, 12, 30)).days
    types = [[text("SampleDate", 1), text("IsActive", 1), text("Empty", 1)],
             [number(serial, 6), ("boolean", True, 0, None), empty]]
    parts = {
        "[Content_Types].xml": '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>''',
        "_rels/.rels": '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>''',
        "xl/workbook.xml": '''<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView/></bookViews><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Types" sheetId="3" r:id="rId3"/></sheets><calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1"/></workbook>''',
        "xl/_rels/workbook.xml.rels": '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''',
        "xl/styles.xml": '''<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF24476B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>''',
        "xl/worksheets/sheet1.xml": sheet_xml(orders, [13, 20, 12, 14, 16, 14, 18], "A1:G5"),
        "xl/worksheets/sheet2.xml": sheet_xml(summary, [20, 16], "A1:B3"),
        "xl/worksheets/sheet3.xml": sheet_xml(types, [18, 14, 14], "A1:C2"),
    }
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_STORED) as archive:
        for name in sorted(parts):
            entry = ZipInfo(name, date_time=(2026, 9, 18, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o600 << 16
            entry.compress_type = ZIP_STORED
            data = parts[name]
            archive.writestr(entry, data.encode("utf-8") if isinstance(data, str) else data)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        data = workbook_bytes()
        with args.output.open("xb") as output:
            output.write(data)
    except FileExistsError:
        print(f"FAIL output must be new; refusing to overwrite: {args.output}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"FAIL output: {error}", file=sys.stderr)
        return 1
    print(f"Created synthetic Orders workbook: {args.output} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
