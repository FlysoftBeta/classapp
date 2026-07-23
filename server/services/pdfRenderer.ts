import path from "path";
import { existsSync } from "fs";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { readArticleBlob } from "@/server/infra/articleBlobs";
import { ServiceError } from "./errors";
import { fileURLToPath, pathToFileURL } from "url";

const DEFAULT_POOL_SIZE = 8;
const MAX_POOL_SIZE = 12;
const MAX_WORKERS_PER_ARTICLE = 2;
const RENDER_TIMEOUT_MS = 15_000;
const HMR_DISPOSE_KEY = "__classapp_pdf_hmr_dispose";
const HOOKS_KEY = "__classapp_pdf_hooks_registered";

interface PdfjsPaths {
  cMapUrl: string;
  standardFontDataUrl: string;
  workerSrc: string;
  wasmUrl: string;
}

let pdfjsPaths: PdfjsPaths | null = null;

function resolvePdfjsDir(): string {
  const candidates = [
    // Production bundles the PDF.js data files beside main.mjs.
    path.join(path.dirname(fileURLToPath(import.meta.url)), "pdfjs-dist"),
    path.join(process.cwd(), "node_modules", "pdfjs-dist"),
    path.join(process.cwd(), "current", "node_modules", "pdfjs-dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "legacy", "build", "pdf.mjs"))) {
      return dir;
    }
  }
  throw new ServiceError("pdfjs-dist 未安装", 500);
}

function getPdfjsPaths(): PdfjsPaths {
  if (pdfjsPaths) return pdfjsPaths;
  const pdfjsDir = resolvePdfjsDir();
  pdfjsPaths = {
    // Important notice! *Url-s don't accept file:// URIs; plus they need to include '/' to pass the directory check (even on Windows)
    cMapUrl: path.join(pdfjsDir, "cmaps") + "/",
    standardFontDataUrl: path.join(pdfjsDir, "standard_fonts") + "/",
    workerSrc: path.join(pdfjsDir, "legacy/build/pdf.worker.mjs"),
    wasmUrl: path.join(pdfjsDir, "wasm") + "/",
  };
  GlobalWorkerOptions.workerSrc = pdfjsPaths.workerSrc;
  return pdfjsPaths;
}

interface PdfRuntime {
  poolPromise: Promise<RenderWorkerPool> | null;
  shutdownPromise: Promise<void> | null;
}

const globalStore = globalThis as typeof globalThis & {
  __classappPdf?: PdfRuntime;
  [HOOKS_KEY]?: boolean;
  [HMR_DISPOSE_KEY]?: () => Promise<void>;
};

function runtime(): PdfRuntime {
  if (!globalStore.__classappPdf) {
    globalStore.__classappPdf = {
      poolPromise: null,
      shutdownPromise: null,
    };
  }
  return globalStore.__classappPdf;
}

export interface RenderArticlePageOptions {
  articleId: string;
  blobPath: string;
  page: number;
  width: number;
  height: number;
}

interface WorkerSlot {
  id: number;
  articleId: string | null;
  blobPath: string | null;
  pdf: PDFDocumentProxy | null;
  lastUsed: number;
  busy: boolean;
}

function renderErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clampPhysicalSize(width: number, height: number) {
  return {
    width: Math.max(320, Math.min(6000, Math.floor(width))),
    height: Math.max(320, Math.min(6000, Math.floor(height))),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ServiceError("渲染超时", 504)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function loadPdfDocument(blobPath: string): Promise<PDFDocumentProxy> {
  const paths = getPdfjsPaths();
  const data = new Uint8Array(await readArticleBlob(blobPath));
  const loadingTask = getDocument({
    data,
    cMapUrl: paths.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: paths.standardFontDataUrl,
    wasmUrl: paths.wasmUrl,
  });
  try {
    return await loadingTask.promise;
  } catch (error) {
    throw new ServiceError(`PDF 加载失败：${renderErrorMessage(error)}`, 400);
  }
}

interface NodeCanvasFactory {
  create(
    width: number,
    height: number,
  ): {
    canvas: { toBuffer(format: "image/png"): Buffer };
    context: CanvasRenderingContext2D;
  };
}

async function renderPdfPage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  readerWidth: number,
  readerHeight: number,
): Promise<Uint8Array> {
  const pageNumber = Math.min(Math.max(1, pageIndex + 1), pdf.numPages);
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const fitScale = Math.max(
      readerWidth / base.width,
      readerHeight / base.height,
    );
    const viewport = page.getViewport({ scale: fitScale });
    const canvasFactory = pdf.canvasFactory as NodeCanvasFactory | null;
    if (!canvasFactory) {
      throw new ServiceError("Canvas 渲染不可用", 500);
    }

    const canvasAndContext = canvasFactory.create(
      Math.max(1, Math.round(viewport.width)),
      Math.max(1, Math.round(viewport.height)),
    );
    await page.render({
      canvas: canvasAndContext.canvas as unknown as HTMLCanvasElement,
      canvasContext: canvasAndContext.context,
      viewport,
    }).promise;

    const body = new Uint8Array(canvasAndContext.canvas.toBuffer("image/png"));
    if (!body.byteLength) {
      throw new ServiceError("渲染结果为空", 500);
    }
    return body;
  } finally {
    page.cleanup();
  }
}

class RenderWorkerPool {
  private workers: WorkerSlot[] = [];
  private shuttingDown = false;
  private initPromise: Promise<void> | null = null;
  private nextWorkerId = 1;
  private claimLock: Promise<void> = Promise.resolve();

  async shutdown() {
    this.shuttingDown = true;
    const workers = this.workers;
    this.workers = [];
    this.initPromise = null;
    await Promise.all(
      workers.map(async (worker) => {
        worker.pdf = null;
      }),
    );
  }

  private async withClaimLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.claimLock;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.claimLock = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private findWorker(id: number): WorkerSlot | undefined {
    return this.workers.find((worker) => worker.id === id);
  }

  private isClaimable(worker: WorkerSlot): boolean {
    return !worker.busy;
  }

  private countArticleWorkers(articleId: string): number {
    return this.workers.filter((worker) => worker.articleId === articleId)
      .length;
  }

  private bindWorkerToArticle(worker: WorkerSlot, articleId: string) {
    if (worker.articleId !== articleId) {
      worker.articleId = articleId;
      worker.blobPath = null;
      worker.pdf = null;
    }
    worker.busy = true;
  }

  private tryClaimWorker(articleId: string): WorkerSlot | null {
    const sameArticle = this.workers.find(
      (worker) => worker.articleId === articleId && this.isClaimable(worker),
    );
    if (sameArticle) {
      sameArticle.busy = true;
      return sameArticle;
    }

    const articleWorkers = this.countArticleWorkers(articleId);
    if (articleWorkers >= MAX_WORKERS_PER_ARTICLE) {
      return null;
    }

    if (this.workers.length < MAX_POOL_SIZE) {
      const worker = this.spawnWorker();
      this.bindWorkerToArticle(worker, articleId);
      return worker;
    }

    let pick: WorkerSlot | null = null;
    let oldestUsed = Number.POSITIVE_INFINITY;
    for (const worker of this.workers) {
      if (!this.isClaimable(worker)) continue;
      if (worker.lastUsed < oldestUsed) {
        oldestUsed = worker.lastUsed;
        pick = worker;
      }
    }
    if (!pick) return null;

    this.bindWorkerToArticle(pick, articleId);
    return pick;
  }

  private createWorkerSlot(): WorkerSlot {
    return {
      id: this.nextWorkerId++,
      articleId: null,
      blobPath: null,
      pdf: null,
      lastUsed: 0,
      busy: false,
    };
  }

  private spawnWorker(): WorkerSlot {
    const worker = this.createWorkerSlot();
    this.workers.push(worker);
    return worker;
  }

  private replenishToDefault() {
    if (this.shuttingDown) return;
    if (this.initPromise) return;
    this.initPromise = (async () => {
      while (!this.shuttingDown && this.workers.length < DEFAULT_POOL_SIZE) {
        this.spawnWorker();
      }
    })().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async ensureReady() {
    if (this.workers.length > 0) return;
    if (!this.initPromise) {
      this.initPromise = this.bootstrapPool();
    }
    await this.initPromise;
  }

  private async bootstrapPool() {
    if (this.workers.length === 0) {
      this.spawnWorker();
    }
    void this.replenishToDefault();
  }

  private async acquireBoundWorker(articleId: string): Promise<WorkerSlot> {
    for (;;) {
      await this.ensureReady();

      const worker = await this.withClaimLock(() =>
        this.tryClaimWorker(articleId),
      );

      if (worker) return worker;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private release(worker: WorkerSlot) {
    worker.lastUsed = Date.now();
    worker.busy = false;
  }

  private async ensureDocumentLoaded(
    worker: WorkerSlot,
    options: RenderArticlePageOptions,
  ): Promise<PDFDocumentProxy> {
    const needsLoad =
      worker.articleId !== options.articleId ||
      worker.blobPath !== options.blobPath ||
      !worker.pdf;

    if (needsLoad) {
      worker.pdf = await loadPdfDocument(options.blobPath);
      worker.articleId = options.articleId;
      worker.blobPath = options.blobPath;
    }

    if (!worker.pdf) {
      throw new ServiceError("PDF 未加载", 500);
    }
    return worker.pdf;
  }

  private async renderOnWorker(
    worker: WorkerSlot,
    options: RenderArticlePageOptions,
  ): Promise<{ body: Uint8Array; numPages: number }> {
    if (!worker.busy) {
      throw new ServiceError("Worker 未锁定，拒绝并发渲染", 500);
    }

    const viewport = clampPhysicalSize(options.width, options.height);
    const pdf = await this.ensureDocumentLoaded(worker, options);
    const body = await renderPdfPage(
      pdf,
      options.page,
      viewport.width,
      viewport.height,
    );
    return { body, numPages: pdf.numPages };
  }

  async renderPage(
    options: RenderArticlePageOptions,
  ): Promise<{ body: Uint8Array; numPages: number }> {
    await this.ensureReady();
    const worker = await this.acquireBoundWorker(options.articleId);
    const workerId = worker.id;
    try {
      return await withTimeout(
        this.renderOnWorker(worker, options),
        RENDER_TIMEOUT_MS,
      );
    } catch (error) {
      const current = this.findWorker(workerId);
      if (current) {
        current.articleId = null;
        current.blobPath = null;
        current.pdf = null;
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(`渲染失败：${renderErrorMessage(error)}`, 500);
    } finally {
      const current = this.findWorker(workerId);
      if (current) this.release(current);
    }
  }
}

function getPool() {
  const state = runtime();
  if (!state.poolPromise) {
    state.poolPromise = Promise.resolve(new RenderWorkerPool());
  }
  return state.poolPromise;
}

export async function renderArticlePage(
  options: RenderArticlePageOptions,
): Promise<{ body: Uint8Array; numPages: number }> {
  const pool = await getPool();
  return pool.renderPage(options);
}

export async function shutdownPdfRenderer(): Promise<void> {
  const state = runtime();
  if (state.shutdownPromise) return state.shutdownPromise;

  state.shutdownPromise = (async () => {
    const pool = state.poolPromise
      ? await state.poolPromise.catch(() => null)
      : null;
    state.poolPromise = null;
    await pool?.shutdown();
  })().finally(() => {
    state.shutdownPromise = null;
  });

  return state.shutdownPromise;
}

function registerShutdownHooks() {
  if (globalStore[HOOKS_KEY]) return;
  globalStore[HOOKS_KEY] = true;

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void shutdownPdfRenderer();
    });
  }
}

function registerHmrDispose() {
  if (process.env.NODE_ENV !== "development") return;
  void globalStore[HMR_DISPOSE_KEY]?.();
  globalStore[HMR_DISPOSE_KEY] = shutdownPdfRenderer;
}

registerHmrDispose();
registerShutdownHooks();
