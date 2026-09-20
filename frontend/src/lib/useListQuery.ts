import { useSearchParams } from 'react-router';

export function useListQuery() {
  const [params, setParams] = useSearchParams();
  const update = (values: Record<string, string | null>, replace = false) => {
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace });
  };
  const filter = (key: string, value: string, replace = false) => {
    update({ [key]: value, page: null }, replace);
  };
  const requestedSize = Number(params.get('page_size'));
  const pageSize = [25, 50, 100].includes(requestedSize) ? requestedSize : 50;
  const requestedPage = Number(params.get('page') ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return { params, update, filter, pageSize, page };
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / pageSize)));
  return { page: currentPage, items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize) };
}
