import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateOffice } from "./office.mjs";

const execute = promisify(execFile);

test("generated Word, Excel and PowerPoint have valid XML, links and literal spreadsheet cells", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-office-"));
  const specs = [
    { format: "docx", title: "中文 <标题>", paragraphs: ["段落 & 内容", "第二段"] },
    {
      format: "xlsx",
      title: "报表",
      sheetName: 'Sales "A"',
      rows: [
        ["姓名", "值"],
        ["中文", 42],
        ['=HYPERLINK("evil")', true],
      ],
    },
    {
      format: "pptx",
      title: "介绍",
      slides: [
        { title: "第一张", body: ["正文 & 数据"] },
        { title: "第二张", body: ["总结"] },
      ],
    },
  ];
  for (const spec of specs) {
    const result = await generateOffice(spec, dir);
    assert.ok(result.bytes > 500);
    assert.equal((await readFile(join(dir, result.filename))).subarray(0, 2).toString(), "PK");
    const { stdout } = await execute("python3", [
      "-c",
      `
import sys,zipfile,posixpath
from xml.etree import ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for name in z.namelist():
  ET.fromstring(z.read(name))
  if name.endswith('.rels'):
   base='' if name=='_rels/.rels' else posixpath.dirname(posixpath.dirname(name))
   for rel in ET.fromstring(z.read(name)):
    if rel.attrib.get('TargetMode')!='External':
     assert posixpath.normpath(posixpath.join(base,rel.attrib['Target'])) in z.namelist()
 if sys.argv[1].endswith('.xlsx'):
  root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
  assert not root.findall('.//{*}f')
print('valid')`,
      join(dir, result.filename),
    ]);
    assert.equal(stdout.trim(), "valid");
  }
});

test("office generator rejects unsupported types and malformed slide/row inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbuddy-office-validation-"));
  await assert.rejects(generateOffice({ format: "exe", title: "bad" }, dir));
  await assert.rejects(generateOffice({ format: "pptx", title: "empty", slides: [] }, dir));
  await assert.rejects(
    generateOffice({ format: "xlsx", title: "bad rows", rows: ["string"] }, dir),
  );
});
