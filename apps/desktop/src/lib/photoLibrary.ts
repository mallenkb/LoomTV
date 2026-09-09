import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi } from './desktopApi';

export function usePhotoLibrary() {
  const { activeProfile } = useProfiles();
  const queryClient = useQueryClient();
  const api = activeProfile?.type === 'owner' && !desktopApi.isRemoteLibraryMode() ? window.desktopApi?.photos : undefined;
  const canRead = activeProfile?.type === 'owner' && !desktopApi.isRemoteLibraryMode();
  const query = useQuery({
    queryKey: ['photo-roots', activeProfile?.id],
    queryFn: () => desktopApi.getPhotoRoots(),
    enabled: canRead,
    refetchInterval: (current) => current.state.data?.some((root) => root.scanning) ? 1500 : 3000,
    refetchOnWindowFocus: 'always',
  });
  return {
    api,
    roots: canRead ? query.data || [] : [],
    loading: canRead && query.isPending,
    error: query.error,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['photo-roots'] }),
  };
}
