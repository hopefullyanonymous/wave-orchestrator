#!/usr/bin/env python
"""Read-only, independent validation of the synthetic Orders workbook.

Usage: python tests/fixtures/smoke-inputs/validate-orders.py <workbook.xlsx> <requirements.json>
Requires openpyxl; reads formulas and cached values separately, never recalculates
or saves either input, and never imports the generator. Requirements are the
reviewable source of expected cell values, formulas, cached results and formats.
"""

import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile


class RequirementFailure(Exception):
    pass


def require(condition, name, expected, actual):
    if not condition:
        raise RequirementFailure(f"{name}: expected {expected!r}; found {actual!r}")


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def check_value(cell, expected, name):
    kind = expected["type"]
    actual = cell.value
    value = expected.get("value")
    if kind == "text":
        valid = cell.data_type == "s" and type(actual) is str and actual == value
    elif kind in ("number", "integer"):
        valid = cell.data_type == "n" and numeric(actual) and actual == value
        if kind == "integer":
            valid = valid and actual == int(actual)
    elif kind == "boolean":
        valid = cell.data_type == "b" and type(actual) is bool and actual is value
    elif kind == "empty":
        valid = cell.data_type == "n" and actual is None
    elif kind == "date":
        valid = (cell.data_type == "d" and cell.is_date and
                 isinstance(actual, datetime) and actual == datetime.fromisoformat(value))
    else:
        raise RequirementFailure(f"{name}.type: unknown declared type {kind!r}")
    require(valid, name + "." + kind, value, actual)


def read_requirements(path):
    with path.open("r", encoding="utf-8") as source:
        spec = json.load(source)
    require(spec.get("schemaVersion") == 1, "requirements.schemaVersion", 1, spec.get("schemaVersion"))
    names = ["Orders", "Summary", "Types"]
    require(spec.get("sheetOrder") == names, "requirements.sheetOrder", names, spec.get("sheetOrder"))
    require(set(spec["sheets"]) == set(names), "requirements.sheets", names, list(spec["sheets"]))
    for flag in ("noMacros", "noExternalLinks", "noErrors"):
        require(spec.get(flag) is True, "requirements." + flag, True, spec.get(flag))
    # Reject accidentally incomplete requirement files instead of validating nothing.
    for name, columns, rows in (("Orders", "ABCDEFG", 5), ("Summary", "AB", 3), ("Types", "ABC", 2)):
        sheet = spec["sheets"][name]
        addresses = {f"{column}{row}" for column in columns for row in range(1, rows + 1)}
        require(sheet["range"] == f"A1:{columns[-1]}{rows}", "requirements." + name + ".range",
                f"A1:{columns[-1]}{rows}", sheet["range"])
        require(set(sheet["cells"]) == addresses, "requirements." + name + ".cells",
                sorted(addresses), sorted(sheet["cells"]))
        for address, cell in sheet["cells"].items():
            label = f"requirements.{name}!{address}"
            kind = cell["type"]
            require(kind in ("text", "integer", "number", "formula", "date", "boolean", "empty"),
                    label + ".type", "known logical type", kind)
            fields = {"type", "format", "formula", "cached"} if kind == "formula" else {"type", "format", "value"}
            require(set(cell) == fields, label + ".fields", sorted(fields), sorted(cell))
            require(type(cell["format"]) is str, label + ".format", "string", cell["format"])
            value = cell.get("value")
            valid = {
                "text": lambda: type(value) is str,
                "integer": lambda: type(value) is int,
                "number": lambda: numeric(value),
                "formula": lambda: (type(cell["formula"]) is str and cell["formula"].startswith("=") and numeric(cell["cached"])),
                "date": lambda: type(value) is str and datetime.fromisoformat(value).isoformat() == value + "T00:00:00",
                "boolean": lambda: type(value) is bool,
                "empty": lambda: value is None,
            }[kind]()
            require(valid, label + ".value", "value matching logical type", cell)
    return spec


def check_package(path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "package.members", "unique ZIP member names", names)
        require(not any("vbaproject" in name.lower() or name.startswith("xl/macrosheets/") for name in names),
                "noMacros", "no VBA or macro sheets", names)
        require(not any(name.startswith("xl/externalLinks/") for name in names),
                "noExternalLinks", "no external-link parts", names)
        types = archive.read("[Content_Types].xml").decode("utf-8")
        require("macroenabled" not in types.lower() and "vba" not in types.lower(),
                "noMacros.contentTypes", "ordinary XLSX content types", types)
        for name in names:
            if name.endswith(".rels"):
                for rel in ET.fromstring(archive.read(name)):
                    require(rel.get("TargetMode", "Internal") != "External", "noExternalLinks." + name,
                            "internal relationships", dict(rel.attrib))


def validate(path, spec, openpyxl):
    check_package(path)
    # Normal (non-read-only) mode exposes complete cell bounds and types, while
    # the program remains read-only: there is deliberately no save/write call.
    formulas = openpyxl.load_workbook(path, data_only=False, keep_links=True)
    cached = None
    try:
        cached = openpyxl.load_workbook(path, data_only=True, keep_links=True)
        for workbook in (formulas, cached):
            require(workbook.sheetnames == spec["sheetOrder"], "sheetOrder", spec["sheetOrder"], workbook.sheetnames)
            require(not workbook._external_links, "noExternalLinks", [], workbook._external_links)
            require(workbook.epoch == datetime(1899, 12, 30), "dateSystem", "Excel 1900", workbook.epoch)
        count = 0
        formula_count = 0
        for name, sheet_spec in spec["sheets"].items():
            sheet = formulas[name]
            values = cached[name]
            require(sheet.sheet_state == "visible", name + ".visibility", "visible", sheet.sheet_state)
            require(not sheet.merged_cells.ranges, name + ".mergedCells", [], list(sheet.merged_cells.ranges))
            for observed_sheet in (sheet, values):
                require(observed_sheet.calculate_dimension() == sheet_spec["range"], name + ".range",
                        sheet_spec["range"], observed_sheet.calculate_dimension())
            for address, expected in sheet_spec["cells"].items():
                label = name + "!" + address
                cell = sheet[address]
                cache = values[address]
                for observed in (cell, cache):
                    require(observed.number_format == expected["format"], label + ".format",
                            expected["format"], observed.number_format)
                if expected["type"] == "formula":
                    require(cell.data_type == "f" and cell.value == expected["formula"],
                            label + ".formula", expected["formula"], cell.value)
                    require(cache.data_type == "n" and numeric(cache.value) and cache.value == expected["cached"],
                            label + ".cached", expected["cached"], cache.value)
                    formula_count += 1
                else:
                    check_value(cell, expected, label)
                    check_value(cache, expected, label + ".dataOnly")
                count += 1
            for observed_sheet in (sheet, values):
                for row in observed_sheet:
                    for cell in row:
                        require(cell.data_type != "e", name + "!" + cell.coordinate + ".noErrors",
                                "no spreadsheet errors", cell.value)
                        require(cell.value is None or cell.coordinate in sheet_spec["cells"],
                                name + "!" + cell.coordinate + ".declared", "only declared populated cells", cell.value)
        return count, formula_count
    finally:
        formulas.close()
        if cached is not None:
            cached.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("requirements", type=Path)
    args = parser.parse_args()
    try:
        import openpyxl
    except ImportError:
        print("FAIL environment.openpyxl: openpyxl is required for independent Excel validation", file=sys.stderr)
        return 2
    try:
        spec = read_requirements(args.requirements)
        count, formulas = validate(args.workbook, spec, openpyxl)
    except RequirementFailure as error:
        print(f"FAIL requirement {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        print(f"FAIL workbook/requirements readable and well-formed: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        # Includes invalid/corrupt archives and parser-specific openpyxl failures.
        print(f"FAIL workbook readable by openpyxl: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.workbook}: 3 sheets, {count} declared cells, {formulas} formulas and numeric caches")
    print("PASS leading-zero text IDs; numeric zero/negative/discount edges; Unicode; date; boolean; empty cells")
    print("PASS Summary!B2 cached total 23.50; Summary!B3 cached order count 4; no macros/external links/errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
