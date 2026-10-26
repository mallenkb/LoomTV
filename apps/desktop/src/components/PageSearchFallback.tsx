import { useEffect, useState } from 'react';
import { useLocation } from '@/lib/navigation';
import { PAGE_SEARCH_EVENT, pageSearchFilter } from '@/lib/pageSearch';
import LocalTitleSearch from '@/components/LocalTitleSearch';

/** Detail pages without their own search keep the current route as context. */
export default function PageSearchFallback() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const handle = (event: Event) => {
      queueMicrotask(() => { if (!event.defaultPrevented) setOpen(true); });
    };
    window.addEventListener(PAGE_SEARCH_EVENT, handle);
    return () => window.removeEventListener(PAGE_SEARCH_EVENT, handle);
  }, []);
  return open ? <LocalTitleSearch key={location.pathname} open onOpenChange={setOpen}
    query={query} onQueryChange={setQuery} initialFilter={pageSearchFilter(location.pathname)} /> : null;
}
