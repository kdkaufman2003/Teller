/** Shared list pagination helpers (Phase 17D). */

export const DEFAULT_LIST_PAGE_SIZE = 100;
export const MAX_LIST_PAGE_SIZE = 500;

export type ListPaginationParams = {
  page: number;
  pageSize: number;
  offset: number;
  limit: number;
};

export function parseListPagination(
  searchParams: URLSearchParams,
  defaults?: { pageSize?: number },
): ListPaginationParams {
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const requested = Number(searchParams.get("pageSize") ?? searchParams.get("limit") ?? "");
  const pageSize = Math.min(
    MAX_LIST_PAGE_SIZE,
    Math.max(10, requested > 0 ? requested : (defaults?.pageSize ?? DEFAULT_LIST_PAGE_SIZE)),
  );
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

export function paginationMeta(page: number, pageSize: number, totalCount: number | null) {
  const total = totalCount ?? 0;
  return {
    page,
    pageSize,
    totalCount: total,
    hasMore: totalCount == null ? null : page * pageSize < total,
  };
}
