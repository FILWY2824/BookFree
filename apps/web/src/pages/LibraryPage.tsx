/*
 * LibraryPage.tsx 是“书架页面”。
 *
 * 用户登录后进入 /library 时，看到的主要就是这个页面：
 * - 从后端加载当前用户的书籍列表；
 * - 显示每本书的卡片；
 * - 提供“上传书籍”入口；
 * - 提供删除书籍的确认弹窗；
 * - 处理加载中、空书架、错误提示等页面状态。
 *
 * 对初学者来说，这个页面很适合用来理解 React 常见模式：
 * 1. useState：保存页面状态；
 * 2. useEffect：页面打开时自动请求数据；
 * 3. useCallback：缓存 reload 函数，避免不必要的重复执行；
 * 4. 条件渲染：根据 loading/error/books 显示不同 UI；
 * 5. 子组件通信：UploadButton 上传成功后调用 onUploaded 触发刷新。
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import DashboardChrome from '../components/DashboardChrome';
import BookCard, { type BookCardData } from '../components/BookCard';
import UploadButton from '../components/UploadButton';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

/*
 * 默认导出的 React 页面组件。
 *
 * App.tsx 中的路由会把 /library 映射到 <LibraryPage />。
 */
export default function LibraryPage() {
  /*
   * books 保存书架中的书籍列表。
   *
   * BookCardData 是 BookCard 组件需要的数据形状。
   * 这里用数组，因为书架页面要渲染多本书。
   */
  const [books, setBooks] = useState<BookCardData[]>([]);

  /*
   * loading 表示是否正在加载书籍列表。
   *
   * 初始值是 true，因为页面首次打开时会立刻请求 /api/books。
   */
  const [loading, setLoading] = useState(true);

  /*
   * error 保存加载书架失败时的错误文案。
   *
   * - null：没有错误；
   * - string：有错误，需要在页面上显示。
   */
  const [error, setError] = useState<string | null>(null);

  /*
   * pendingDelete 表示“用户正准备删除哪本书”。
   *
   * - null：没有打开删除确认框；
   * - BookCardData：打开确认框，并显示这本书的标题。
   *
   * 这样设计比单独保存 boolean 更好，因为确认框需要知道要删除哪本书。
   */
  const [pendingDelete, setPendingDelete] = useState<BookCardData | null>(null);

  /*
   * useToast() 提供全局提示能力。
   *
   * 删除成功/失败时，页面通过 toast.success / toast.error 给用户反馈。
   */
  const { toast } = useToast();

  /*
   * reload 负责重新加载书架列表。
   *
   * 它会请求后端：
   *   GET /api/books
   *
   * 后端成功返回后，前端把 books 保存到 state，
   * React 会自动重新渲染书架网格。
   *
   * useCallback 的作用：
   * - 让 reload 在依赖不变时保持同一个函数引用；
   * - 这样 useEffect([reload]) 和 UploadButton 的 onUploaded 不会因为每次渲染都拿到新函数而产生额外行为。
   */
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      /*
       * api.get 的泛型表示成功响应 data 的形状：
       *
       *   { books: BookCardData[] }
       *
       * 也就是说，后端 JSON 信封里的 data 应该包含 books 数组。
       */
      const r = await api.get<{ books: BookCardData[] }>('/api/books');
      setBooks(r.books);
      setError(null);
    } catch (e) {
      /*
       * 请求失败时保存错误消息。
       *
       * 这里没有直接 toast.error，是因为书架列表加载失败属于页面级错误，
       * 更适合稳定显示在页面区域里，而不是只弹出一条短暂提示。
       */
      setError((e as Error).message);
    } finally {
      // 无论成功或失败，都表示本次加载结束。
      setLoading(false);
    }
  }, []);

  /*
   * 页面首次挂载时自动加载一次书架。
   *
   * useEffect 可以理解成“当组件出现到页面上之后，执行一些副作用”。
   * 请求后端、订阅事件、设置定时器都属于副作用。
   */
  useEffect(() => { reload(); }, [reload]);

  /*
   * confirmDelete 在用户点击确认弹窗里的“删除”后执行。
   *
   * 删除流程：
   * 1. 如果没有 pendingDelete，说明当前没有选中要删除的书，直接返回；
   * 2. 记录要删除的 id；
   * 3. 先关闭确认弹窗；
   * 4. 调用后端 DELETE /api/books/{id}；
   * 5. 成功后从本地 books 数组中移除这本书；
   * 6. 失败时显示错误 toast。
   */
  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await api.delete(`/api/books/${id}`);
      toast.success('已删除');

      /*
       * 这里没有重新请求整个书架，而是直接在前端本地删除对应项。
       *
       * prev => prev.filter(...) 是 React state 更新的函数式写法：
       * - prev 是更新前的 books；
       * - filter 会创建一个新数组；
       * - b.id !== id 表示保留所有不是被删除目标的书。
       */
      setBooks(prev => prev.filter(b => b.id !== id));
    } catch (e) {
      toast.error('删除失败：' + (e as Error).message);
    }
  }

  /*
   * DashboardChrome 是登录后页面的通用外壳。
   *
   * 它通常负责：
   * - 页面标题；
   * - 侧边栏或顶部导航；
   * - 右上角操作区；
   * - 统一的页面间距和背景。
   *
   * actions 表示页面右上角操作按钮。
   *
   * UploadButton 上传完成后会调用 onUploaded，
   * 这里传入 reload，表示“上传成功后重新加载书架列表”。
   */
  return (
    <DashboardChrome
      title="书架"
      bare
      actions={<UploadButton onUploaded={reload} />}
    >
      {/*
       * 条件渲染：只有 loading=true 且当前没有任何 books 时，才显示首次加载提示。
       *
       * 如果 books 已经有内容，再触发 reload，就不会把整个列表替换成加载文案，
       * 可以减少页面闪烁。
       */}
      {loading && books.length === 0 && (
        <div className="text-center py-20 text-ink-500">正在加载书架…</div>
      )}

      {/* 如果加载书架失败，显示页面级错误提示。 */}
      {error && (
        <div className="text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {/*
       * 加载完成且书籍数量为 0，显示空状态。
       *
       * 注意这里要求 !loading，避免首次请求还没回来时就闪现“书架还是空的”。
       */}
      {!loading && books.length === 0 && (
        <EmptyState />
      )}

      {/*
       * 有书籍时显示网格。
       *
       * Tailwind 的 grid-cols-2 / sm:grid-cols-3 等类表示响应式列数：
       * - 小屏幕两列；
       * - 屏幕越宽列数越多。
       */}
      {books.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {books.map(b => (
            /*
             * key 是 React 渲染列表时必须提供的稳定标识。
             *
             * onDelete 传给 BookCard：
             * - BookCard 内部点击删除按钮；
             * - 调用这个函数；
             * - 父组件把 pendingDelete 设置为当前书；
             * - ConfirmDialog 因 open=true 显示出来。
             */
            <BookCard
              key={b.id}
              book={b}
              onDelete={() => setPendingDelete(b)}
            />
          ))}
        </div>
      )}

      {/*
       * 删除确认弹窗。
       *
       * open={!!pendingDelete}：
       * - pendingDelete 为 null 时 !!null 是 false，弹窗关闭；
       * - pendingDelete 有书籍对象时 !!object 是 true，弹窗打开。
       */}
      <ConfirmDialog
        open={!!pendingDelete}
        title="删除这本书？"
        message={pendingDelete ? `「${pendingDelete.title}」将被永久删除，包含其笔记、高亮与阅读进度。此操作不可恢复。` : ''}
        confirmLabel="删除"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardChrome>
  );
}

/*
 * EmptyState 是书架为空时显示的组件。
 *
 * 它拆成单独函数的原因：
 * - LibraryPage 主逻辑更清晰；
 * - 空状态 UI 可以独立维护；
 * - 以后如果要给空书架增加示例图、引导按钮，可以主要改这里。
 */
function EmptyState() {
  return (
    <div className="text-center py-24">
      <div className="inline-block text-ink-400 mb-4">
        {/*
         * 这里直接写 SVG 图标，避免额外引入图标依赖。
         *
         * 对低内存/轻部署项目来说，少依赖可以减少构建体积和维护成本。
         */}
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
        </svg>
      </div>
      <h2 className="font-serif text-xl text-ink-700">书架还是空的</h2>
      <p className="text-sm text-ink-500 mt-2 mb-6">
        点击右上角「上传书籍」开始建立你的私有书房。<br />
        支持 EPUB、PDF、TXT；其它格式会被存储但暂不可阅读。
      </p>
    </div>
  );
}
