export type PaginatedQueryError = { message: string };

type PageResult<T> = {
  data: T[] | null;
  error: PaginatedQueryError | null;
};

export async function fetchAllRows<T>(
  loadPage: (from: number, to: number) => Promise<PageResult<T>>,
  pageSize = 500,
): Promise<PageResult<T>> {
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const result = await loadPage(from, from + pageSize - 1);
    if (result.error) return { data: null, error: result.error };

    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}
