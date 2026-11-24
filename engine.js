// Compila Ordini - motore (tutto nel browser: i file non lasciano il computer)
import * as pdfjsLib from "./pdf.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.js", import.meta.url).href;

const SIZE_RE = /^\d{1,2}([.,]5)?$/;
const INT_RE = /^\d{1,4}$/;
export function refFromCode(code) {
  const parts = code.split("_").map((x) => x.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : code;
  const m = last.match(/[A-Z0-9]+$/i);
  return (m ? m[0] : last).toUpperCase();
}

export class Report {
  constructor() { this.errors = []; this.warnings = []; this.info = []; }
  err(m) { this.errors.push(m); }
  warn(m) { this.warnings.push(m); }
  ok(m) { this.info.push(m); }
}

export function norm(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim().toUpperCase();
}

export function normSize(s) {
  const t = String(s).trim().replace(",", ".");
  const f = Number(t);
  if (t !== "" && !Number.isNaN(f)) return Number.isInteger(f) ? String(f) : String(f);
  return t.toUpperCase();
}

const center = (w) => (w.x0 + w.x1) / 2;

// ------------------------------------------------------------------ PDF
async function pdfWords(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const words = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(t[2], t[3]) || 8;
    const x = t[4], base = t[5];
    const w = (it.width || 0) * vp.scale;
    const cw = it.str.length ? w / it.str.length : 0;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str))) {
      const w = { text: m[0], x0: x + m.index * cw, x1: x + (m.index + m[0].length) * cw, top: base - fh };
      // alcuni PDF scrivono lo stesso testo 2-4 volte sovrapposto (finto grassetto): lo tengo una volta sola
      if (words.some((o) => o.text === w.text && Math.abs(o.x0 - w.x0) < 2 && Math.abs(o.top - w.top) < 2)) continue;
      words.push(w);
    }
  }
  return words;
}

function groupLines(words, tol = 5.0) {
  const lines = [];
  const sorted = [...words].sort((a, b) => (Math.round(a.top * 10) - Math.round(b.top * 10)) || (a.x0 - b.x0));
  for (const w of sorted) {
    const ln = lines.find((l) => Math.abs(l.top - w.top) <= tol);
    if (ln) ln.words.push(w); else lines.push({ top: w.top, words: [w] });
  }
  for (const l of lines) l.words.sort((a, b) => a.x0 - b.x0);
  lines.sort((a, b) => a.top - b.top);
  return lines;
}

function findSizeHeader(line) {
  const ws = line.words;
  const sizes = [];
  for (let i = ws.length - 1; i >= 0; i--) {
    if (SIZE_RE.test(ws[i].text)) sizes.unshift(ws[i]); else break;
  }
  if (sizes.length < 3) return null;
  const gapsAll = sizes.slice(1).map((s, i) => s.x0 - sizes[i].x0).sort((a, b) => a - b);
  const med = gapsAll[Math.floor(gapsAll.length / 2)];
  while (sizes.length > 3 && sizes[1].x0 - sizes[0].x0 > 2.5 * med) sizes.shift();
  const vals = sizes.map((w) => Number(w.text.replace(",", ".")));
  for (let i = 1; i < vals.length; i++) if (vals[i] <= vals[i - 1]) return null;
  const prod = ws.filter((w) => w.x1 < sizes[0].x0);
  if (!prod.length || !prod.some((w) => w.text === "-")) return null;
  return { prod, sizes };
}

const isTableHeader = (line) => {
  const t = line.words.map((w) => w.text).join(" ").toUpperCase();
  return t.includes("CODICE") && t.includes("PRODOTTO");
};

export async function parsePdf(file, rep) {
  const name = file.name;
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdf = await task.promise;
  const npages = pdf.numPages;
  let grandTotal = null;
  const stream = [];
  for (let pno = 1; pno <= npages; pno++) {
    const page = await pdf.getPage(pno);
    const lines = groupLines(await pdfWords(page));
    lines.forEach((ln, i) => {
      if (ln.words.some((w) => w.text.includes("PZ/PAIA"))) {
        for (const nxt of lines.slice(i + 1, i + 4)) {
          const nums = nxt.words.filter((w) => INT_RE.test(w.text));
          if (nums.length) { grandTotal = Number(nums[0].text); break; }
        }
      }
    });
    const start = lines.findIndex(isTableHeader);
    if (start < 0) continue;
    for (const ln of lines.slice(start + 1)) { ln.page = pno; stream.push(ln); }
    stream.push({ page: pno, words: [], pageEnd: true, top: 0 });
  }
  await task.destroy();

  const heads = [];
  stream.forEach((ln, idx) => {
    const h = ln.words.length ? findSizeHeader(ln) : null;
    if (h) heads.push({ idx, ...h });
  });

  const items = [];
  heads.forEach((h, k) => {
    const pno = stream[h.idx].page;
    const end = k + 1 < heads.length ? heads[k + 1].idx : stream.length;
    const texts = h.prod.map((w) => w.text);
    const dash = texts.indexOf("-");
    const code = texts.slice(0, dash).join(" ").trim();
    const desc = texts.slice(dash + 1).join(" ").trim();
    const ref = refFromCode(code);
    const sizes = h.sizes;
    const gaps = sizes.slice(1).map((s, i) => s.x0 - sizes[i].x0);
    const step = gaps.length ? Math.min(...gaps) : 20;
    const lo = sizes[0].x0 - step / 2, hi = sizes[sizes.length - 1].x1 + step / 2;
    const qty = {};
    let totalPdf = null, packsPdf = null, qpage = null, breaks = 0;
    for (const ln of stream.slice(h.idx + 1, end)) {
      if (ln.pageEnd) { breaks++; if (breaks > 1) break; continue; }
      const inside = ln.words.filter((w) => center(w) >= lo && center(w) <= hi);
      const nums = inside.filter((w) => INT_RE.test(w.text));
      if (!nums.length || nums.length !== inside.length) continue;
      if (qpage !== null) { rep.warn(`${name} pag.${ln.page}, ${code}: trovata una seconda riga di quantità, ignorata.`); continue; }
      qpage = ln.page;
      for (const w of nums) {
        const cx = center(w);
        let best = sizes[0];
        for (const s of sizes) if (Math.abs(center(s) - cx) < Math.abs(center(best) - cx)) best = s;
        if (Math.abs(center(best) - cx) > step * 0.6) {
          rep.err(`${name} pag.${qpage}, ${code}: quantità ${w.text} non allineata a nessuna taglia.`);
          continue;
        }
        const sz = normSize(best.text);
        qty[sz] = (qty[sz] || 0) + Number(w.text);
      }
      const right = ln.words.filter((w) => w.x0 > hi && INT_RE.test(w.text));
      if (right.length) {
        totalPdf = Number(right[0].text);
        const after = ln.words[ln.words.indexOf(right[0]) + 1];
        const pm = after && /^\((\d+)\)$/.exec(after.text);
        if (pm) packsPdf = Number(pm[1]);
      }
    }
    const pageTxt = qpage === null || qpage === pno ? `${pno}` : `${pno}-${qpage}`;
    items.push({ code, ref, desc, qty, total: totalPdf, packs: packsPdf, page: pageTxt });
    const sum = Object.values(qty).reduce((a, b) => a + b, 0);
    if (!Object.keys(qty).length) rep.err(`${name} pag.${pageTxt}, ${code}: nessuna quantità trovata sotto le taglie.`);
    else if (totalPdf !== null && sum !== totalPdf)
      rep.err(`${name} pag.${pageTxt}, ${code}: somma taglie ${sum} diversa dalla quantità totale ${totalPdf} del PDF.`);
  });
  const pagesWith = [...new Set(heads.map((h) => stream[h.idx].page))].sort((a, b) => a - b);
  return { items, grandTotal, npages, pagesWith };
}

// ------------------------------------------------------------------ XLSX
const colToNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const numToCol = (n) => { let s = ""; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const splitRef = (r) => { const m = /^([A-Z]+)(\d+)$/.exec(r); return [m[1], Number(m[2])]; };
const parseXml = (str) => new DOMParser().parseFromString(str.replace(/^\uFEFF/, ""), "application/xml");
const byLocal = (doc, name) => Array.from(doc.getElementsByTagNameNS("*", name));

export async function loadWorkbook(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = async (p) => parseXml(await zip.file(p).async("string"));
  const shared = [];
  if (zip.file("xl/sharedStrings.xml")) {
    for (const si of byLocal(await xml("xl/sharedStrings.xml"), "si"))
      shared.push(Array.from(si.getElementsByTagNameNS("*", "t")).map((t) => t.textContent).join(""));
  }
  const wb = await xml("xl/workbook.xml");
  const rels = await xml("xl/_rels/workbook.xml.rels");
  const rmap = {};
  for (const r of byLocal(rels, "Relationship")) rmap[r.getAttribute("Id")] = r.getAttribute("Target");
  const sheets = byLocal(wb, "sheet").map((s) => {
    const rid = s.getAttribute("r:id") || Array.from(s.attributes).find((a) => a.localName === "id")?.value;
    let t = (rmap[rid] || "").replace(/^\//, "");
    if (!t.startsWith("xl/")) t = "xl/" + t;
    return { name: s.getAttribute("name"), path: t };
  });
  return { zip, shared, sheets, file };
}

async function readCells(wbk, path) {
  const f = wbk.zip.file(path);
  if (!f) throw new Error(`foglio ${path} non trovato nel file Excel`);
  const doc = parseXml(await f.async("string"));
  const cells = {};
  for (const c of byLocal(doc, "c")) {
    const r = c.getAttribute("r"), t = c.getAttribute("t");
    const v = c.getElementsByTagNameNS("*", "v")[0];
    let val = null;
    if (t === "s" && v) val = wbk.shared[Number(v.textContent)];
    else if (t === "inlineStr") val = Array.from(c.getElementsByTagNameNS("*", "t")).map((x) => x.textContent).join("");
    else if (v) val = v.textContent;
    if (val !== null && val !== undefined) cells[r] = val;
  }
  const merges = byLocal(doc, "mergeCell").map((m) => m.getAttribute("ref"));
  return { cells, merges };
}

export async function buildModel(wbk, rep) {
  for (const sh of wbk.sheets) {
    const { cells, merges } = await readCells(wbk, sh.path);
    let hdrRow = null, refCol = null, nameCol = null;
    for (const [r, v] of Object.entries(cells))
      if (["PRODUCT REF.", "PRODUCT REF"].includes(norm(v))) [refCol, hdrRow] = splitRef(r);
    if (!hdrRow) continue;
    for (const [r, v] of Object.entries(cells)) {
      const [c, rr] = splitRef(r);
      if (rr === hdrRow && norm(v) === "PRODUCT NAME") nameCol = c;
    }
    let solid = null;
    for (const [r, v] of Object.entries(cells)) {
      if (norm(v) !== "SOLID") continue;
      const c1 = colToNum(splitRef(r)[0]);
      let c2 = c1;
      for (const m of merges) { const [a, b] = m.split(":"); if (a === r) c2 = colToNum(splitRef(b)[0]); }
      solid = [c1, c2];
    }
    if (!solid) { rep.err(`Foglio '${sh.name}': non trovo l'intestazione SOLID.`); return null; }
    const sizeCols = {};
    for (let n = solid[0]; n <= solid[1]; n++) {
      const v = cells[`${numToCol(n)}${hdrRow}`];
      if (v !== undefined && v !== "") sizeCols[normSize(v)] = numToCol(n);
    }
    const byRef = {}, byName = {};
    for (const [r, v] of Object.entries(cells)) {
      const [c, rr] = splitRef(r);
      if (rr <= hdrRow || !String(v).trim()) continue;
      if (c === refCol) (byRef[String(v).trim()] ||= []).push(rr);
      if (nameCol && c === nameCol) (byName[norm(v)] ||= []).push(rr);
    }
    for (const k in byRef) byRef[k].sort((a, b) => a - b);
    return { sheet: sh.name, path: sh.path, hdrRow, sizeCols, byRef, byName, cells, nameCol };
  }
  rep.err("Nell'Excel non trovo la colonna 'Product Ref.'.");
  return null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function writeXlsx(wbk, sheetPath, values) {
  let xml = await wbk.zip.file(sheetPath).async("string");
  const p = (/<(\w+:)?worksheet\b/.exec(xml)[1]) || "";
  const P = esc(p);
  const byRow = {};
  for (const [ref, val] of Object.entries(values)) (byRow[splitRef(ref)[1]] ||= {})[ref] = val;
  for (const [rownumS, rowvals] of Object.entries(byRow)) {
    const rownum = Number(rownumS);
    const rre = new RegExp(`<${P}row\\b[^>]*\\br="${rownum}"[^>]*?(\\/>|>([\\s\\S]*?)<\\/${P}row>)`);
    const rm = rre.exec(xml);
    if (!rm) throw new Error(`riga ${rownum} non trovata nel foglio`);
    const rowOpen = new RegExp(`^<${P}row\\b[^>]*?(?=\\/?>)`).exec(rm[0])[0];
    const body = rm[2] || "";
    const cells = body.match(new RegExp(`<${P}c\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${P}c>)`, "g")) || [];
    const parsed = cells.map((cx) => { const ref = /\br="([A-Z]+\d+)"/.exec(cx)[1]; return [colToNum(splitRef(ref)[0]), ref, cx]; });
    const existing = new Set(parsed.map((x) => x[1]));
    for (const ref of Object.keys(rowvals)) if (!existing.has(ref)) parsed.push([colToNum(splitRef(ref)[0]), ref, null]);
    parsed.sort((a, b) => a[0] - b[0]);
    const out = parsed.map(([, ref, cx]) => {
      if (!(ref in rowvals)) return cx;
      const sm = cx ? /\bs="(\d+)"/.exec(cx) : null;
      return `<${p}c r="${ref}"${sm ? ` s="${sm[1]}"` : ""}><${p}v>${rowvals[ref]}</${p}v></${p}c>`;
    });
    xml = xml.slice(0, rm.index) + rowOpen + ">" + out.join("") + `</${p}row>` + xml.slice(rm.index + rm[0].length);
  }
  // tolgo i risultati salvati delle formule: Excel, Numbers e LibreOffice le ricalcolano all'apertura
  xml = xml.replace(new RegExp(`(<${P}f\\b[^>]*\\/>|<\\/${P}f>)<${P}v>[^<]*<\\/${P}v>`, "g"), "$1");
  const zip = await JSZip.loadAsync(await wbk.file.arrayBuffer());
  zip.file(sheetPath, xml);
  // le formule (totali paia, importi) vengono ricalcolate da Excel/Numbers all'apertura
  let wbx = await zip.file("xl/workbook.xml").async("string");
  const cm = /<(\w+:)?calcPr\b([^>]*?)(\/?)>/.exec(wbx);
  if (cm) {
    if (!/fullCalcOnLoad=/.test(cm[2])) wbx = wbx.replace(cm[0], `<${cm[1] || ""}calcPr${cm[2]} fullCalcOnLoad="1"${cm[3]}>`);
  }
  zip.file("xl/workbook.xml", wbx);
  const macro = /\.xlsm$/i.test(wbk.file.name);
  return zip.generateAsync({ type: "blob", compression: "DEFLATE",
    mimeType: macro ? "application/vnd.ms-excel.sheet.macroEnabled.12"
                    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ------------------------------------------------------------------ PROCESSO
export async function processOrder(pdfFile, xlsxFile, rep) {
  const pdfName = pdfFile.name;
  const res = { pdfName, rows: [], blob: null, outName: null, filled: 0, total: 0, pieces: 0 };
  let parsed;
  try { parsed = await parsePdf(pdfFile, rep); }
  catch (e) { rep.err(`Impossibile leggere il PDF ${pdfName}: ${e.message || e}`); return res; }
  const { items, grandTotal, npages, pagesWith } = parsed;
  rep.ok(`${pdfName}: ${npages} pagine controllate, articoli trovati nelle pagine ${pagesWith.join(", ") || "-"}.`);
  if (!items.length) { rep.err(`${pdfName}: non ho trovato nessun articolo (righe "CODICE - DESCRIZIONE" con le taglie).`); return res; }
  res.total = items.length;
  const totRead = items.reduce((a, it) => a + Object.values(it.qty).reduce((x, y) => x + y, 0), 0);
  if (grandTotal !== null && grandTotal !== totRead)
    rep.err(`${pdfName}: totale pezzi letti ${totRead} diverso dal TOT. PZ/PAIA del PDF (${grandTotal}).`);

  const wbk = await loadWorkbook(xlsxFile);
  const model = await buildModel(wbk, rep);
  if (!model) return res;
  const values = {};
  for (const it of items) {
    const row = { ...it, excelRow: null, status: "ok", note: "" };
    res.rows.push(row);
    let rows = model.byRef[it.ref], how = "ref";
    if (!rows) { rows = model.byName[norm(it.desc)]; how = "name"; }
    if (!rows) {
      row.status = "err"; row.note = "Non presente nell'Excel";
      rep.err(`Articolo ${it.code} - ${it.desc} (pag.${it.page}): NON presente nell'Excel, non compilato.`);
      continue;
    }
    if (rows.length > 1) rep.warn(`Articolo ${it.ref} compare ${rows.length} volte nell'Excel: uso la riga ${rows[0]}.`);
    const r = rows[0];
    row.excelRow = r;
    if (how === "name") row.note = "Abbinato per nome";
    if (model.nameCol && how === "ref") {
      const xname = model.cells[`${model.nameCol}${r}`] || "";
      if (norm(xname) !== norm(it.desc)) {
        rep.warn(`Articolo ${it.ref}: nome PDF "${it.desc}" / nome Excel "${xname}" (abbinato per codice).`);
        row.note = `Nome in Excel: ${xname}`;
      }
    }
    let okItem = true;
    for (const [sz, n] of Object.entries(it.qty)) {
      const col = model.sizeCols[sz];
      if (!col) {
        rep.err(`Articolo ${it.ref}: taglia ${sz} non esiste nelle colonne SOLID dell'Excel (${n} pz non riportati).`);
        okItem = false; continue;
      }
      const ref = `${col}${r}`;
      if (ref in values) rep.warn(`Articolo ${it.ref} taglia ${sz} presente più volte nel PDF: quantità sommate.`);
      values[ref] = (values[ref] || 0) + n;
    }
    if (!okItem) { row.status = "err"; row.note = "Taglia non presente in Excel"; }
    else if (!Object.keys(it.qty).length) { row.status = "err"; row.note = "Quantità non trovate"; }
    else res.filled++;
  }
  if (!Object.keys(values).length) { rep.err(`${pdfName}: nessun valore da scrivere nell'Excel.`); return res; }
  const blob = await writeXlsx(wbk, model.path, values);
  // verifica: rileggo il file generato
  const chk = await loadWorkbook(new File([blob], "chk.xlsx"));
  const { cells } = await readCells(chk, model.path);
  const bad = Object.entries(values).filter(([r, v]) => String(cells[r]) !== String(v)).map(([r]) => r);
  if (bad.length) rep.err(`Verifica fallita sulle celle: ${bad.join(", ")}`);
  res.pieces = Object.values(values).reduce((a, b) => a + b, 0);
  res.blob = blob;
  res.outName = `COMPILATO_${pdfName.replace(/\.pdf$/i, "").replace(/[^\w\-]+/g, "_")}.xlsx`;
  rep.ok(`${pdfName}: compilati ${res.filled} articoli su ${items.length}, ${res.pieces} pezzi scritti → ${res.outName}`);
  return res;
}

// ================================================================== VERITA (order form)
// Excel con due sezioni: PACK ORDER (n. pacchi per WOMAN/MAN: PACK 12, XL P12, PACK 8)
// e UNIT ORDER (paia per taglia, WOMAN e MAN separati). La composizione dei pacchi
// e' nella tabella "PACK SIZE" in alto.
export const packKey = (s) => norm(s).replace(/\s+/g, "").replace("PACK", "P");   // "XL PACK 12"/"XL P12" -> "XLP12"
const genderOf = (s) => { const t = norm(s).split(/[^A-Z]+/); return t.includes("WOMAN") ? "WOMAN" : t.includes("MAN") ? "MAN" : null; };
const packOfDesc = (s) => { const m = /(XL\s*)?PACK\s*(\d+)/.exec(norm(s)); return m ? packKey(m[0]) : null; };
const pairsOfPack = (k) => Number((/(\d+)$/.exec(k) || [0, 0])[1]);

export async function buildVeritaModel(wbk, rep) {
  for (const sh of wbk.sheets) {
    const { cells, merges } = await readCells(wbk, sh.path);
    const find = (txt) => Object.entries(cells).filter(([, v]) => norm(v) === txt).map(([r]) => r);
    const po = find("PACK ORDER")[0], uo = find("UNIT ORDER")[0];
    if (!po || !uo) continue;
    const span = (ref) => {
      const c = colToNum(splitRef(ref)[0]); let c2 = c;
      for (const m of merges) { const [a, b] = m.split(":"); if (a === ref) c2 = colToNum(splitRef(b)[0]); }
      return [c, c2];
    };
    const poSpan = span(po), uoSpan = span(uo), topRow = splitRef(po)[1];
    // riga dei sottotitoli (PACK 12 / XL P12 / taglie) e riga SKU
    let hdrRow = null, skuCol = null;
    for (const [r, v] of Object.entries(cells)) {
      const [c, rr] = splitRef(r);
      if (norm(v) === "SKU" && rr >= topRow && (hdrRow === null || rr > hdrRow)) { hdrRow = rr; skuCol = c; }
    }
    if (!hdrRow) { rep.err(`Foglio '${sh.name}': non trovo la colonna SKU.`); return null; }
    // colonne per genere: celle WOMAN/MAN (anche unite) tra la riga PACK ORDER e quella delle taglie
    const packCols = { WOMAN: {}, MAN: {} }, unitCols = { WOMAN: {}, MAN: {} };
    for (const [r, v] of Object.entries(cells)) {
      const g = norm(v), [, rr] = splitRef(r);
      if (!(g === "WOMAN" || g === "MAN") || rr <= topRow || rr >= hdrRow) continue;
      const [c1, c2] = span(r);
      for (let n = c1; n <= c2; n++) {
        const col = numToCol(n), h = cells[`${col}${hdrRow}`];
        if (h === undefined || h === "") continue;
        if (n >= poSpan[0] && n <= poSpan[1]) packCols[g][packKey(h)] = col;
        else if (n >= uoSpan[0] && n <= uoSpan[1]) unitCols[g][normSize(h)] = col;
      }
    }
    // composizione dei pacchi (tabella PACK SIZE)
    const packDef = { WOMAN: {}, MAN: {} };
    const ps = Object.entries(cells).find(([, v]) => norm(v).startsWith("PACK SIZE"));
    if (ps) {
      const [pc, pr] = splitRef(ps[0]); const [c1, c2] = span(ps[0]);
      const sizeAt = {};
      for (let n = c2 + 1; n <= c2 + 40; n++) { const v = cells[`${numToCol(n)}${pr}`]; if (v !== undefined && v !== "") sizeAt[n] = normSize(v); }
      let g = null;
      for (let rr = pr + 1; rr < pr + 20 && rr < topRow; rr++) {
        const gv = genderOf(cells[`${pc}${rr}`] || ""); if (gv) g = gv;
        const name = cells[`${numToCol(c2)}${rr}`];
        if (!g || !name) continue;
        const def = {};
        for (const [n, sz] of Object.entries(sizeAt)) { const q = Number(cells[`${numToCol(Number(n))}${rr}`] || 0); if (q) def[sz] = q; }
        packDef[g][packKey(name)] = def;
      }
    }
    const bySku = {};
    for (const [r, v] of Object.entries(cells)) {
      const [c, rr] = splitRef(r);
      if (c === skuCol && rr > hdrRow && String(v).trim()) (bySku[String(v).trim().toUpperCase()] ||= []).push(rr);
    }
    const nameCols = ["STYLE", "COLOR"].map((t) => { const e = Object.entries(cells).find(([r, v]) => splitRef(r)[1] === hdrRow && norm(v) === t); return e ? splitRef(e[0])[0] : null; });
    return { sheet: sh.name, path: sh.path, hdrRow, packCols, unitCols, packDef, bySku, cells, nameCols };
  }
  rep.err("Nell'Excel non trovo le sezioni PACK ORDER / UNIT ORDER del modulo d'ordine.");
  return null;
}

const sameQty = (a, b) => {
  const ka = Object.keys(a).filter((k) => a[k]), kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

export async function processVerita(pdfFile, xlsxFile, rep, mode = "pack") {
  const pdfName = pdfFile.name;
  const res = { pdfName, rows: [], blob: null, outName: null, filled: 0, total: 0, pieces: 0 };
  let parsed;
  try { parsed = await parsePdf(pdfFile, rep); }
  catch (e) { rep.err(`Impossibile leggere il PDF ${pdfName}: ${e.message || e}`); return res; }
  const { items, grandTotal, npages, pagesWith } = parsed;
  rep.ok(`${pdfName}: ${npages} pagine controllate, articoli trovati nelle pagine ${pagesWith.join(", ") || "-"}.`);
  if (!items.length) { rep.err(`${pdfName}: non ho trovato nessun articolo (righe "CODICE - DESCRIZIONE" con le taglie).`); return res; }
  res.total = items.length;
  const totRead = items.reduce((a, it) => a + Object.values(it.qty).reduce((x, y) => x + y, 0), 0);
  if (grandTotal !== null && grandTotal !== totRead)
    rep.err(`${pdfName}: totale paia lette ${totRead} diverso dal TOT. PZ/PAIA del PDF (${grandTotal}).`);

  const wbk = await loadWorkbook(xlsxFile);
  const m = await buildVeritaModel(wbk, rep);
  if (!m) return res;
  const values = {};
  const put = (ref, n, it) => {
    const old = m.cells[ref];
    if (old !== undefined && old !== "" && Number(old)) rep.warn(`Cella ${ref} era già compilata (${old}): sovrascritta per ${it.ref}.`);
    if (ref in values) rep.warn(`${it.ref}: cella ${ref} usata da più righe del PDF, quantità sommate.`);
    values[ref] = (values[ref] || 0) + n;
  };
  for (const it of items) {
    const sum = Object.values(it.qty).reduce((a, b) => a + b, 0);
    const g = genderOf(it.desc), pk = packOfDesc(it.desc);
    const row = { ...it, gender: g, excelRow: null, status: "ok", note: "", how: "" };
    res.rows.push(row);
    const fail = (msg, note) => { row.status = "err"; row.note = note; rep.err(msg); };
    const rows = m.bySku[it.ref];
    if (!rows) { fail(`Articolo ${it.code} - ${it.desc} (pag.${it.page}): SKU ${it.ref} NON presente nell'Excel, non compilato.`, "SKU non presente nell'Excel"); continue; }
    if (rows.length > 1) rep.warn(`SKU ${it.ref} compare ${rows.length} volte nell'Excel: uso la riga ${rows[0]}.`);
    const r = rows[0]; row.excelRow = r;
    row.model = m.nameCols.map((c) => (c ? m.cells[`${c}${r}`] : "")).filter(Boolean).join(" · ");
    if (!g) { fail(`Articolo ${it.code} (pag.${it.page}): nel PDF non c'è WOMAN o MAN, non so in quali colonne scriverlo.`, "Manca WOMAN/MAN"); continue; }
    if (!sum) { fail(`Articolo ${it.code} (pag.${it.page}): nessuna quantità trovata.`, "Quantità non trovate"); continue; }

    let done = false;
    if (mode === "pack" && pk) {
      const col = m.packCols[g][pk], def = m.packDef[g][pk];
      const per = def ? Object.values(def).reduce((a, b) => a + b, 0) : pairsOfPack(pk);
      const n = it.packs ?? (per ? sum / per : NaN);
      if (!col) rep.warn(`${it.ref} ${g}: nell'Excel non c'è la colonna pacchi ${pk} per ${g}, uso le taglie singole.`);
      else if (!Number.isInteger(n) || n <= 0 || n * per !== sum) rep.warn(`${it.ref} ${g}: ${sum} paia non corrispondono a un numero intero di pacchi ${pk}, uso le taglie singole.`);
      else {
        const expect = {}; if (def) for (const [s, q] of Object.entries(def)) expect[s] = q * n;
        if (def && !sameQty(expect, it.qty)) rep.warn(`${it.ref} ${g}: le taglie del PDF non sono quelle del pacco ${pk} dell'Excel, uso le taglie singole.`);
        else {
          put(`${col}${r}`, n, it);
          row.how = `${g} · ${m.cells[`${col}${m.hdrRow}`] || pk} × ${n}`;
          done = true;
        }
      }
    }
    if (!done) {
      const missing = Object.keys(it.qty).filter((s) => !m.unitCols[g][s]);
      if (missing.length) { fail(`Articolo ${it.ref} ${g}: taglie ${missing.join(", ")} non presenti nelle colonne ${g} dell'Excel, non compilato.`, `Taglie ${missing.join(", ")} assenti per ${g}`); continue; }
      for (const [s, q] of Object.entries(it.qty)) put(`${m.unitCols[g][s]}${r}`, q, it);
      row.how = `${g} · taglie singole`;
    }
    if (it.total !== null && it.total !== sum) rep.err(`${it.ref} ${g}: somma taglie ${sum} diversa dal totale ${it.total} del PDF.`);
    res.filled++;
  }
  if (!Object.keys(values).length) { rep.err(`${pdfName}: nessun valore da scrivere nell'Excel.`); return res; }
  const blob = await writeXlsx(wbk, m.path, values);
  const chk = await loadWorkbook(new File([blob], wbk.file.name));
  const { cells } = await readCells(chk, m.path);
  const bad = Object.entries(values).filter(([ref, v]) => String(cells[ref]) !== String(v)).map(([ref]) => ref);
  if (bad.length) rep.err(`Verifica fallita sulle celle: ${bad.join(", ")}`);
  // controllo paia totali come la formula TOTAL PAIRS dell'Excel
  let pairs = 0;
  for (const [ref, v] of Object.entries(values)) {
    const col = splitRef(ref)[0];
    let k = null; for (const g of ["WOMAN", "MAN"]) for (const [pk, c] of Object.entries(m.packCols[g])) if (c === col) k = pk;
    pairs += k ? v * (Object.values(m.packDef.WOMAN[k] || m.packDef.MAN[k] || {}).reduce((a, b) => a + b, 0) || pairsOfPack(k)) : v;
  }
  const okPairs = res.rows.filter((r) => r.status === "ok").reduce((a, r) => a + Object.values(r.qty).reduce((x, y) => x + y, 0), 0);
  if (pairs !== okPairs) rep.err(`Controllo paia: nell'Excel risulterebbero ${pairs} paia invece di ${okPairs}.`);
  res.pieces = pairs;
  const ext = /\.xlsm$/i.test(xlsxFile.name) ? "xlsm" : "xlsx";
  res.blob = blob;
  res.outName = `COMPILATO_${pdfName.replace(/\.pdf$/i, "").replace(/[^\w\-]+/g, "_")}.${ext}`;
  rep.ok(`${pdfName}: compilati ${res.filled} articoli su ${items.length}, ${pairs} paia → ${res.outName}`);
  return res;
}
