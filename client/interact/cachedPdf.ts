import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline";
import { extentFiles } from "@/client/data/files";
import { FileIds } from "@/client/data/fileIds";

const PDF_RANGE_SIZE = 64 * 1024;
const documents = new Map<string, Promise<PDFDocumentProxy>>();
let worker: Worker | null = null;

function ensurePdfWorker(): void {
  if (GlobalWorkerOptions.workerPort) return;
  // Delay worker startup until a cached PDF is opened. This keeps normal app
  // bootstrap independent of the relatively large PDF runtime.
  worker ??= new PdfWorker();
  GlobalWorkerOptions.workerPort = worker;
}

class ExtentPdfTransport extends PDFDataRangeTransport {
  constructor(
    private readonly fileId: string,
    size: number,
    initial: Uint8Array,
  ) {
    super(size, initial, true);
  }

  requestDataRange(begin: number, end: number): void {
    void extentFiles
      .read(this.fileId, begin, end - begin)
      .then((value) => this.onDataRange(begin, new Uint8Array(value)))
      .catch(() => this.onDataRange(begin, null));
  }
}

async function openDocument(articleId: string): Promise<PDFDocumentProxy> {
  ensurePdfWorker();
  const fileId = FileIds.articleBlob(articleId);
  const size = await extentFiles.size(fileId);
  if (size === null || size === 0) throw new Error("文章尚未保存到本机");
  const initial = new Uint8Array(
    await extentFiles.read(fileId, 0, Math.min(PDF_RANGE_SIZE, size)),
  );
  const range = new ExtentPdfTransport(fileId, size, initial);
  return getDocument({
    range,
    rangeChunkSize: PDF_RANGE_SIZE,
    useWorkerFetch: false,
    useWasm: false,
  }).promise;
}

async function documentFor(articleId: string): Promise<PDFDocumentProxy> {
  let document = documents.get(articleId);
  if (!document) {
    document = openDocument(articleId).catch((error) => {
      documents.delete(articleId);
      throw error;
    });
    documents.set(articleId, document);
  }
  return document;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PDF 页面编码失败"));
    }, "image/png");
  });
}

export async function renderCachedPdfPage(
  articleId: string,
  options: { page: number; width: number; height: number },
): Promise<{ blob: Blob; pages: number } | null> {
  if ((await extentFiles.size(FileIds.articleBlob(articleId))) === null) {
    return null;
  }
  const pdf = await documentFor(articleId);
  const pageNumber = Math.min(Math.max(1, options.page + 1), pdf.numPages);
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(
      options.width / base.width,
      options.height / base.height,
    );
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas, viewport }).promise;
    return { blob: await canvasBlob(canvas), pages: pdf.numPages };
  } finally {
    page.cleanup();
  }
}

export async function closeCachedPdf(articleId: string): Promise<void> {
  const current = documents.get(articleId);
  documents.delete(articleId);
  if (current) await (await current).cleanup();
}
