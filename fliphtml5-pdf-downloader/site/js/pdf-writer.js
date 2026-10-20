// Minimal PDF writer: one JPEG per page, no dependencies.
// JPEG data goes in as-is (DCTDecode), so page quality is exactly what
// FlipHTML5 served.

const encoder = new TextEncoder();

const IMAGE_DPI = 150; // a 1240 px wide page image becomes an A4-wide page
const MAX_PAGE_POINTS = 14400; // PDF viewers cap a page at 200 inches

// "%PDF-1.4", then a comment of high-bit bytes so tools treat the file as binary.
const HEADER = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
]);

/** Page size in PDF points for an image of the given pixel size. */
export function pageSizeFor(widthPx, heightPx) {
  let width = (widthPx * 72) / IMAGE_DPI;
  let height = (heightPx * 72) / IMAGE_DPI;
  const overshoot = Math.max(width, height) / MAX_PAGE_POINTS;
  if (overshoot > 1) {
    width /= overshoot;
    height /= overshoot;
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

const number = (n) => String(Math.round(n * 100) / 100);

// PDF text string as UTF-16BE hex, so any title survives.
function textString(value) {
  let hex = 'FEFF';
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

function pdfDate(date) {
  return `D:${date.toISOString().slice(0, 19).replace(/[-:T]/g, '')}Z`;
}

// Collects output chunks while tracking byte offsets for the xref table.
class Output {
  parts = [];
  offset = 0;
  objectOffsets = [];

  bytes(chunk) {
    this.parts.push(chunk);
    this.offset += chunk.length;
  }

  text(value) {
    this.bytes(encoder.encode(value));
  }

  object(id, body) {
    this.objectOffsets[id] = this.offset;
    this.text(`${id} 0 obj\n${body}\nendobj\n`);
  }

  stream(id, dictionary, data) {
    this.objectOffsets[id] = this.offset;
    this.text(`${id} 0 obj\n<< ${dictionary} /Length ${data.length} >>\nstream\n`);
    this.bytes(data);
    this.text('\nendstream\nendobj\n');
  }
}

export class PdfDocument {
  #pages = [];
  #info;

  constructor({ title = '', subject = '', producer = 'FlipHTML5 to PDF' } = {}) {
    this.#info = { title, subject, producer };
  }

  get pageCount() {
    return this.#pages.length;
  }

  /** @param {{bytes: Uint8Array, width: number, height: number, components: number}} image */
  addJpegPage(image) {
    this.#pages.push({ ...pageSizeFor(image.width, image.height), image });
  }

  addBlankPage(width, height) {
    this.#pages.push({ width, height, image: null });
  }

  toBlob() {
    // Object ids: 1 catalog, 2 page tree, 3 info, then page / contents / image per page.
    let nextId = 4;
    const ids = this.#pages.map((page) => ({
      page: nextId++,
      contents: nextId++,
      image: page.image ? nextId++ : 0,
    }));
    const objectCount = nextId;

    const out = new Output();
    out.bytes(HEADER);
    out.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    out.object(
      2,
      `<< /Type /Pages /Count ${ids.length} /Kids [${ids.map((id) => `${id.page} 0 R`).join(' ')}] >>`,
    );
    out.object(
      3,
      `<< /Title ${textString(this.#info.title)} /Subject ${textString(this.#info.subject)} ` +
        `/Producer ${textString(this.#info.producer)} /CreationDate (${pdfDate(new Date())}) >>`,
    );

    this.#pages.forEach((page, index) => {
      const id = ids[index];
      const width = number(page.width);
      const height = number(page.height);
      const resources = page.image ? `/XObject << /Im0 ${id.image} 0 R >>` : '';
      out.object(
        id.page,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
          `/Resources << ${resources} >> /Contents ${id.contents} 0 R >>`,
      );
      const drawing = page.image ? `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q` : '';
      out.stream(id.contents, '', encoder.encode(drawing));
      if (page.image) {
        const colorSpace = page.image.components === 1 ? 'DeviceGray' : 'DeviceRGB';
        out.stream(
          id.image,
          `/Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} ` +
            `/ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode`,
          page.image.bytes,
        );
      }
    });

    const xrefOffset = out.offset;
    let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
    for (let id = 1; id < objectCount; id++) {
      xref += `${String(out.objectOffsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    out.text(xref);
    out.text(
      `trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    );
    return new Blob(out.parts, { type: 'application/pdf' });
  }
}
