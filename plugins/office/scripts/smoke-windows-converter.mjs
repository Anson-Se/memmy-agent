/** Build-time test with a trusted generated document; never used for user files. */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

export async function smokeWindowsConverter(executable) {
  const root = await mkdtemp(join(tmpdir(), "office-converter-smoke-"));
  try {
    const input = join(root, "smoke.docx"), output = join(root, "output"), profile = join(root, "profile");
    await mkdir(output); await mkdir(join(profile, "user"), { recursive: true });
    await writeFile(join(profile, "user/registrymodifications.xcu"), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    const doc = new JSZip();
    doc.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    doc.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    doc.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office renderer smoke test</w:t></w:r></w:p></w:body></w:document>');
    await writeFile(input, await doc.generateAsync({ type: "nodebuffer" }));
    const env = {};
    for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
    env.MEMMY_OFFICE_TRACE = "1";
    const result = spawnSync(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--convert-to", "pdf", "--outdir", output, input], { cwd: root, env, encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    console.log(result.stderr);
    if (result.error || result.status !== 0) throw new Error(`Windows renderer build smoke failed (${result.status}): ${result.error?.message ?? result.stderr}`);
    if (!(await readFile(join(output, "smoke.pdf"))).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Windows renderer smoke did not produce a PDF");
    console.log("Windows renderer build smoke passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}
