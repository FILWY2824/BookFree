/*
 * BookCard 是书架页中“一本书”的卡片组件。
 *
 * 对初学者来说，可以把它理解成：
 * - 输入：父组件传进来的 book 数据；
 * - 输出：一个可点击的卡片 UI；
 * - 行为：
 *   1. 点击卡片主体，跳转到 /book/:id 阅读页；
 *   2. 如果父组件提供了 onDelete，就在悬停时显示删除按钮；
 *   3. 根据 book.status 显示“待解析 / 就绪 / 失败”等状态标签。
 *
 * 为什么这里不用额外请求后端？
 * - BookCard 只是展示组件，不负责加载数据；
 * - 书籍列表由 LibraryPage 从 /api/books 获取；
 * - 删除动作也交给 LibraryPage 统一处理确认弹窗和 API 调用；
 * - 这样组件更容易复用和测试，也不会让 UI 卡片承担太多业务逻辑。
 *
 * 视觉设计说明：
 * - 目前没有真正展示封面图片；
 * - 对没有封面的书，使用标题 hash 生成稳定颜色；
 * - 同一本书标题每次都会得到相同颜色，书架看起来更有辨识度；
 * - 这比为每本书生成/缓存封面更轻量，也符合 BookFree 后端低内存、低复杂度约束。
 */

import { Link } from 'react-router-dom';
import { formatBytes, stringHashColor, truncate } from '../lib/format';

/*
 * BookCardData 描述 BookCard 需要的最小书籍数据。
 *
 * 字段来源通常是后端 books 表经过 API 转换后的 JSON：
 * - id：书籍唯一 ID，用于拼出 /book/:id 路由；
 * - title：书名；
 * - authors：作者数组，可能为空；
 * - format：文件格式，例如 txt、epub、pdf；
 * - sizeBytes：文件大小，单位是字节；
 * - status：导入状态，例如 uploaded、ready、failed；
 * - coverStorageKey：封面在存储中的 key，目前本组件没有直接使用；
 * - error：解析失败时的错误信息，目前本组件只显示失败标签，详细错误可在后续页面扩展。
 */
export interface BookCardData {
  id: string;
  title: string;
  authors?: string[];
  format: string;
  sizeBytes: number;
  status: string;
  coverStorageKey?: string | null;
  error?: string | null;
}

/*
 * Props 是 React 组件的“入参类型”。
 *
 * book 是必需的，因为没有书籍数据就无法渲染卡片。
 * onDelete 是可选的：
 * - 如果传入，卡片右上角显示删除按钮；
 * - 如果不传，BookCard 就只是一个只读跳转卡片。
 */
interface Props {
  book: BookCardData;
  onDelete?: (id: string) => void;
}

/*
 * STATUS_COPY 把后端状态码映射成前端可读的中文文案和样式。
 *
 * Record<string, { label: string; tone: string }> 是 TypeScript 写法：
 * - key 是字符串，例如 "ready"；
 * - value 是一个对象，包含 label 和 tone；
 * - label 用于页面显示；
 * - tone 是 Tailwind CSS class，用于控制颜色。
 *
 * 二次修改提示：
 * 如果后端新增了书籍状态，例如 "archived"、"syncing"，
 * 可以在这里添加对应中文显示，而不用改 JSX 主体结构。
 */
const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  uploaded: { label: '待解析', tone: 'bg-amber-100 text-amber-800' },
  parsing: { label: '解析中', tone: 'bg-amber-100 text-amber-800' },
  chunking: { label: '处理中', tone: 'bg-amber-100 text-amber-800' },
  indexing: { label: '建立索引', tone: 'bg-amber-100 text-amber-800' },
  ready: { label: '就绪', tone: 'bg-emerald-100 text-emerald-800' },
  failed: { label: '失败', tone: 'bg-rose-100 text-rose-800' },
};

export default function BookCard({ book, onDelete }: Props) {
  /*
   * authors 是可选数组，所以这里用 ?. 安全访问第一个作者：
   * - book.authors?.[0] 表示“如果 authors 存在，就取第 0 个”；
   * - 如果没有作者，就使用“未知作者”兜底。
   */
  const author = book.authors?.[0] ?? '未知作者';

  /*
   * stringHashColor 会根据书名生成固定颜色。
   *
   * 这样做的好处：
   * - 不需要后端额外保存封面颜色；
   * - 不需要前端缓存；
   * - 刷新页面后颜色仍然稳定；
   * - 对大量书籍列表来说非常轻量。
   */
  const colors = stringHashColor(book.title);

  /*
   * 如果 book.status 不在 STATUS_COPY 中，就直接显示原始状态字符串。
   * 这是一种兼容策略：后端即使先新增状态，前端也不会崩溃。
   */
  const status = STATUS_COPY[book.status] ?? { label: book.status, tone: 'bg-paper-200 text-ink-600' };

  return (
    /*
     * group 是 Tailwind 的分组选择器。
     * 子元素可以使用 group-hover:flex 等 class，在父容器 hover 时改变自身样式。
     * 本文件里删除按钮默认 hidden，鼠标移到整张卡片上时显示。
     */
    <div className="group relative">
      {/*
       * Link 来自 react-router-dom。
       * 它不会让浏览器整页刷新，而是在 SPA 内部切换路由。
       *
       * to={`/book/${book.id}`} 会进入阅读页：
       * - App.tsx 中定义了 /book/:id；
       * - ReaderPage 会通过 useParams 读取这个 id；
       * - 然后请求 /api/books/{id} 加载书籍。
       */}
      <Link
        to={`/book/${book.id}`}
        className="block rounded-xl bg-white border border-paper-300/70 shadow-card hover:shadow-elev transition-shadow"
      >
        <div
          className="relative aspect-[2/3] rounded-t-xl overflow-hidden book-card-spine flex items-end p-4"
          style={{
            /*
             * 这里给 CSS 变量赋值。
             *
             * .book-card-spine 在 styles.css 中会读取：
             * - --card-spine：书脊或背景色；
             * - --card-cover：封面渐变/前景色。
             *
             * TypeScript 默认不认识自定义 CSS 变量名，
             * 所以这里使用 ['--card-spine' as never] 这种写法绕过类型限制。
             */
            ['--card-spine' as never]: colors.bg,
            ['--card-cover' as never]: colors.fg,
          }}
        >
          <div className="text-white/95 drop-shadow">
            <div className="font-serif text-base leading-tight">
              {/*
               * truncate 用于截断过长书名，避免长标题把卡片撑坏。
               * 这里最多显示约 38 个字符。
               */}
              {truncate(book.title, 38)}
            </div>
            <div className="text-xs text-white/80 mt-1">{author}</div>
          </div>
        </div>

        {/*
         * 卡片底部展示文件格式和大小。
         * formatBytes 会把字节数转换成人类可读格式，例如 1536000 -> 1.5 MB。
         */}
        <div className="px-3 py-2.5 text-xs text-ink-500 flex items-center justify-between">
          <span className="uppercase tracking-wide">{book.format}</span>
          <span>{formatBytes(book.sizeBytes)}</span>
        </div>
      </Link>

      {/*
       * 左上角状态标签。
       * 它放在 Link 外面，但使用 absolute 覆盖到卡片上方。
       */}
      <div className="absolute top-2 left-2 flex flex-col gap-1">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${status.tone}`}>
          {status.label}
        </span>
      </div>

      {/*
       * 删除按钮是可选能力。
       *
       * 注意：
       * - 删除按钮在 Link 外层同级；
       * - 点击删除按钮时调用 e.preventDefault()；
       * - 这样可以阻止点击事件触发卡片跳转；
       * - 真正的删除确认弹窗和 API 调用由父组件 LibraryPage 完成。
       */}
      {onDelete && (
        <button
          aria-label="删除"
          title="删除"
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            onDelete(book.id);
          }}
          className="absolute top-2 right-2 hidden group-hover:flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-ink-600 hover:bg-white hover:text-rose-600 shadow-card"
        >
          {/*
           * 这是一个内联 SVG 图标。
           * 好处是无需引入额外图标库，减少依赖体积。
           */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
      )}
    </div>
  );
}
