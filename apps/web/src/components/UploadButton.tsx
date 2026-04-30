/*
 * UploadButton 是“上传书籍 / 导入书籍”的按钮组件。
 *
 * 它不只是一个普通按钮，而是封装了完整的前端导入流程：
 *
 *   1. 用户点击“上传书籍”按钮；
 *   2. 代码触发隐藏的 <input type="file">，打开系统文件选择器；
 *   3. 用户选择 TXT / EPUB / PDF 等文件；
 *   4. 前端把原始文件流式上传到后端 /api/books/upload；
 *   5. 后端保存原始文件，并在 books 表中创建一条书籍记录；
 *   6. 前端根据后端返回的 format 判断是否需要解析；
 *   7. 对 TXT / EPUB / FB2 / MOBI / CBZ 等可解析格式，前端调用 parseFile；
 *   8. 前端把解析出的章节、文本块、目录等结构 POST 到 /api/books/{id}/ingest；
 *   9. 如果解析失败，则调用 /api/books/{id}/ingest/fail，让书架能显示失败状态。
 *
 * 为什么解析放在前端？
 * - 浏览器端解析可以减少 Go 后端常驻内存压力；
 * - 后端只负责保存原始文件、保存解析结果、提供 API；
 * - 大文件解析不常驻在服务端进程里，更符合 BookFree “轻量 Go 后端、50MB 内存约束”的目标；
 * - 后续 Android 客户端也可以复用同样的后端 ingest API：客户端解析后提交结构化结果。
 *
 * 为什么封装成独立组件？
 * - LibraryPage 可以直接复用；
 * - 未来阅读页拖拽上传、空状态上传也可以复用；
 * - 上传中的 loading、toast、错误处理集中在一个地方，避免重复代码。
 */

import { useRef, useState } from 'react';
import { api, ApiException } from '../lib/api';
import { parseFile, type ParsedFormat } from '../parsers';
import { useToast } from './Toast';

/*
 * Props 是父组件传给 UploadButton 的参数。
 *
 * onUploaded：
 * - 上传或导入流程结束后调用；
 * - LibraryPage 会把 reload 传进来，从而刷新书架列表；
 * - 注意：失败后也可能调用 onUploaded，因为后端可能已经创建了一本“失败状态”的书。
 *
 * variant：
 * - 控制按钮视觉样式；
 * - primary：主按钮；
 * - secondary：次级按钮。
 */
interface Props {
  onUploaded?: () => void;
  variant?: 'primary' | 'secondary';
}

/*
 * UploadResult 对应后端 /api/books/upload 返回的数据。
 *
 * 这个接口只描述 data 内部的字段。
 * 外层 { ok, data, error } 已经被 lib/api.ts 中的 apiRequest 解包了。
 */
interface UploadResult {
  bookId: string;
  format: string;
  sizeBytes: number;
  status: string;
}

/*
 * ACCEPT 控制浏览器文件选择器允许选择哪些扩展名。
 *
 * 重要：这里必须和后端 server/internal/books/upload.go 里的 SupportedFormats 保持同步。
 * 原因：
 * - 前端 accept 只是用户体验层面的限制，用户仍可能绕过；
 * - 后端 SupportedFormats 才是真正的安全校验；
 * - 如果前端允许而后端不允许，用户会看到上传失败；
 * - 如果后端允许而前端不允许，用户在 UI 中无法选择该格式。
 *
 * 当前策略：
 * - PDF：上传后直接由 pdf.js 从原始文件渲染；
 * - TXT/EPUB/FB2/MOBI/CBZ 等：上传后由前端 parser 解析章节；
 * - 其他格式如未来新增，需要同时更新 parser、后端支持列表和阅读器分发逻辑。
 */
const ACCEPT = '.epub,.pdf,.txt,.fb2,.fbz,.mobi,.azw,.azw3,.cbz';

/*
 * PARSED_FORMATS 表示“前端有解析器”的格式。
 *
 * 注意 PDF 不在这里：
 * - PDF 文件不需要被 parseFile 拆成章节；
 * - 阅读时 PdfReader 直接请求 /api/books/{id}/file；
 * - PDF 只需要调用 ingest 把书籍状态从 uploaded 推进到 ready。
 */
const PARSED_FORMATS: ParsedFormat[] = ['txt', 'epub', 'fb2', 'fbz', 'mobi', 'azw', 'azw3', 'cbz'];

/*
 * isParsedFormat 是一个 TypeScript 类型保护函数。
 *
 * 返回值写成 f is ParsedFormat 的意思是：
 * - 如果函数返回 true；
 * - TypeScript 就可以在后续代码里把 f 当作 ParsedFormat；
 * - 这样调用 parseFile(file, format) 时不会出现类型错误。
 */
function isParsedFormat(f: string): f is ParsedFormat {
  return (PARSED_FORMATS as string[]).includes(f);
}

export default function UploadButton({ onUploaded, variant = 'primary' }: Props) {
  /*
   * inputRef 指向隐藏的 <input type="file">。
   *
   * React 里不能直接用 document.querySelector 找元素更改状态，
   * 更推荐使用 useRef 保存 DOM 引用。
   */
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * busy 表示当前是否正在上传/解析/索引。
   *
   * null：空闲状态，按钮显示“上传书籍”；
   * { name, phase }：忙碌状态，按钮禁用并显示 “上传中：xxx.txt”。
   */
  const [busy, setBusy] = useState<{ name: string; phase: string } | null>(null);

  /*
   * toast 是全局提示工具。
   * 这里用于展示上传成功、失败、解析失败、索引失败等结果。
   */
  const { toast } = useToast();

  /*
   * open 会模拟点击隐藏的文件输入框。
   *
   * 这样做的原因：
   * - 原生 file input 很难统一样式；
   * - 我们把 input 隐藏；
   * - 用自定义 button 控制视觉；
   * - 点击 button 时再触发 inputRef.current?.click()。
   */
  function open() {
    inputRef.current?.click();
  }

  /*
   * onPick 在用户选中文件后触发。
   *
   * e.target.files?.[0]：
   * - files 可能为空；
   * - 当前只处理第一个文件；
   * - 如果未来要支持批量上传，可以从这里改成遍历 files。
   *
   * e.target.value = '' 很重要：
   * - 浏览器默认认为“连续选择同一个文件”不是变化；
   * - 清空 value 后，用户再次选择同一个文件也会触发 onChange；
   * - 这对测试和失败后重试很有用。
   */
  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    await upload(f);
  }

  /*
   * upload 是完整导入流程的主函数。
   *
   * 它按阶段更新 busy.phase：
   * - 上传中：把原始文件发给后端保存；
   * - 解析中：浏览器端解析章节；
   * - 建立索引：把解析结果交给后端入库、建立搜索索引。
   *
   * 这里使用 async/await：
   * - await 会等待 Promise 完成；
   * - try/catch 可以捕获异步错误；
   * - 比连续 .then().catch() 更接近同步代码阅读方式。
   */
  async function upload(file: File) {
    setBusy({ name: file.name, phase: '上传中' });

    /*
     * bookId 和 format 需要定义在 try 外面，
     * 因为后续 PDF 特殊处理、解析、ingest 都会用到它们。
     */
    let bookId = '';
    let format = '';

    try {
      /*
       * putRaw 用于上传 Blob/File 原始字节。
       *
       * 注意：
       * - 不要把文件 JSON.stringify；
       * - 文件名通过 query/header 传给后端；
       * - 后端会保存原始文件到 storage，并写入 books/book_assets/ingestion_jobs。
       */
      const r = await api.putRaw<UploadResult>('/api/books/upload', file, file.name);
      bookId = r.bookId;
      format = r.format;
    } catch (err) {
      /*
       * ApiException 是 lib/api.ts 对后端错误信封的包装。
       * 如果不是 ApiException，就按普通 Error 处理。
       */
      const m = err instanceof ApiException ? err.message : (err as Error).message;
      toast.error('上传失败：' + m);
      setBusy(null);
      return;
    }

    /*
     * PDF 特殊处理：
     *
     * PDF 不走 parseFile，因为：
     * - PDF 解析章节和文本成本较高；
     * - 当前阅读器 PdfReader 直接按 byte range 请求原始文件；
     * - pdf.js 可以在浏览器里按页渲染；
     * - 后端只需要把这本书标记成 ready，让书架可以进入阅读。
     *
     * 如果 ingest 失败，要调用 ingest/fail，
     * 避免书籍永远停留在“待解析”状态。
     */
    if (format === 'pdf') {
      try {
        await api.post(`/api/books/${bookId}/ingest`, {
          title: stripExt(file.name),
          chapters: [],
          chunks: [],
        });
      } catch (err) {
        const m = err instanceof ApiException ? err.message : (err as Error).message;
        toast.error('PDF 入库失败：' + m);
        try {
          await api.post(`/api/books/${bookId}/ingest/fail`, { error: m });
        } catch {
          /*
           * 这里故意忽略二次失败：
           * - 用户已经看到了 PDF 入库失败；
           * - ingest/fail 只是为了尽量更新后端状态；
           * - 没必要再弹出第二个错误干扰用户。
           */
        }
        setBusy(null);
        onUploaded?.();
        return;
      }

      toast.success(`已添加：${file.name}`);
      setBusy(null);
      onUploaded?.();
      return;
    }

    /*
     * 如果格式被后端允许，但前端没有解析器：
     * - 原始文件已经保存；
     * - 书架会显示 uploaded / 待解析；
     * - 当前无法进入完整阅读体验；
     * - 未来实现对应 parser 后再补齐。
     */
    if (!isParsedFormat(format)) {
      toast.info(`已上传 ${format.toUpperCase()}（暂不支持解析，文件已保存）`);
      setBusy(null);
      onUploaded?.();
      return;
    }

    /*
     * 进入前端解析阶段。
     *
     * parseFile 会根据 format 分发到不同解析器：
     * - txt.ts；
     * - foliate/epub 相关解析；
     * - cbz 等格式解析。
     *
     * 解析结果通常包含：
     * - title；
     * - chapters；
     * - chunks；
     * - toc。
     */
    setBusy({ name: file.name, phase: '解析中' });
    let parsed;
    try {
      parsed = await parseFile(file, format);
    } catch (err) {
      const m = (err as Error).message ?? '未知错误';
      toast.error('解析失败：' + m);
      try {
        await api.post(`/api/books/${bookId}/ingest/fail`, { error: m });
      } catch {
        /*
         * 与 PDF 分支一样：
         * ingest/fail 是“尽力而为”的状态更新，不影响前端继续收尾。
         */
      }
      setBusy(null);
      onUploaded?.();
      return;
    }

    /*
     * 建立索引 / 入库阶段。
     *
     * 名字叫“建立索引”，但它通常不只做搜索索引：
     * - 后端会保存章节；
     * - 保存 chunks；
     * - 更新书籍标题/目录/状态；
     * - 写入 FTS 搜索表；
     * - 把 ingestion job 标记完成。
     */
    setBusy({ name: file.name, phase: '建立索引' });
    try {
      await api.post(`/api/books/${bookId}/ingest`, parsed);
    } catch (err) {
      const m = err instanceof ApiException ? err.message : (err as Error).message;
      toast.error('索引失败：' + m);
      setBusy(null);
      onUploaded?.();
      return;
    }

    /*
     * parsed.title 优先，因为解析器可能从书籍元数据里拿到更准确的标题；
     * 如果解析结果没有标题，则回退到文件名。
     */
    toast.success(`已添加：${parsed.title || file.name}`);
    setBusy(null);
    onUploaded?.();
  }

  /*
   * 根据 variant 选择按钮样式。
   *
   * baseBtn 只保存差异部分；
   * 通用布局样式在下面 className 中统一拼接。
   */
  const baseBtn =
    variant === 'primary'
      ? 'bg-accent hover:bg-accent-dark text-white'
      : 'bg-paper-100 hover:bg-paper-200 text-ink-700 border border-paper-300/70';

  return (
    <>
      {/*
       * 真正的文件选择控件。
       *
       * className="hidden" 表示它不可见；
       * 但它仍然存在于 DOM 中，可以通过 inputRef.current?.click() 打开文件选择器。
       */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        onChange={onPick}
        className="hidden"
      />

      {/*
       * 用户看到并点击的是这个 button。
       *
       * disabled={busy !== null}：
       * - 上传过程中禁止重复点击；
       * - 避免同一本书重复上传；
       * - 也避免多个导入流程并发竞争 UI 状态。
       */}
      <button
        onClick={open}
        disabled={busy !== null}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${baseBtn} disabled:opacity-60`}
      >
        {busy ? (
          <>
            <Spinner />
            <span>
              {busy.phase}：{busy.name}
            </span>
          </>
        ) : (
          <>
            {/*
             * 内联上传图标。
             * 使用 SVG 而不是图标库，可以减少额外依赖和打包体积。
             */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>上传书籍</span>
          </>
        )}
      </button>
    </>
  );
}

/*
 * Spinner 是上传/解析时显示的小转圈图标。
 *
 * animate-spin 是 Tailwind 提供的动画 class。
 */
function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/*
 * stripExt 去掉文件扩展名，用于从文件名推测书名。
 *
 * 示例：
 * - "三体.pdf" -> "三体"
 * - "README" -> "README"
 *
 * dot <= 0 的判断用于处理：
 * - 没有扩展名；
 * - ".gitignore" 这种以点开头但不应被视为普通扩展名的文件名。
 */
function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}
