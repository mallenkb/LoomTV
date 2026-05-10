import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Download, Film, Home, RefreshCw, Settings, Tv } from 'lucide-react';
import { motion } from 'motion/react';
import { useLibrary } from '@/contexts/LibraryContext';
import { desktopApi, UpdateState } from '@/lib/desktopApi';
import { cn } from '@/lib/utils';
import LoomLogo from '@/components/LoomLogo';

type SidebarNavItemId = 'anime' | 'tv' | 'movies';
type NavItemId = 'home' | SidebarNavItemId;

const defaultSidebarNavOrder: SidebarNavItemId[] = ['anime', 'tv', 'movies'];
const navItemHeight = 40;
const navItemGap = 4;

const homeNavItem = { id: 'home', path: '/', label: 'Home', icon: Home };

const sidebarNavItems: Record<SidebarNavItemId, { id: SidebarNavItemId; path: string; label: string; icon: React.ComponentType<{ className?: string }> }> = {
  anime: { id: 'anime', path: '/anime', label: 'Anime', icon: AnimeIcon },
  tv: { id: 'tv', path: '/tv', label: 'TV Shows', icon: Tv },
  movies: { id: 'movies', path: '/movies', label: 'Movies', icon: Film },
};

function getActiveNavItemId(pathname: string, fromPath?: string): NavItemId | null {
  const detailRoute = pathname.startsWith('/movie/') || pathname.startsWith('/tv/') || pathname.startsWith('/anime/');
  const activePath = detailRoute && fromPath ? fromPath : pathname;

  if (activePath === '/' || activePath.startsWith('/?')) return 'home';
  if (activePath === '/movies' || activePath.startsWith('/movies/') || activePath.startsWith('/movie/')) return 'movies';
  if (activePath === '/tv' || activePath.startsWith('/tv/')) return 'tv';
  if (activePath === '/anime' || activePath.startsWith('/anime/')) return 'anime';

  if (pathname.startsWith('/movie/')) return 'movies';
  if (pathname.startsWith('/tv/')) return 'tv';
  if (pathname.startsWith('/anime/')) return 'anime';
  return null;
}

function normalizeSidebarNavOrder(order?: string[]): SidebarNavItemId[] {
  const savedOrder = Array.isArray(order) ? order : [];
  const uniqueSavedOrder = Array.from(new Set(savedOrder));
  return [
    ...uniqueSavedOrder.filter((item): item is SidebarNavItemId => defaultSidebarNavOrder.includes(item as SidebarNavItemId)),
    ...defaultSidebarNavOrder.filter((item) => !uniqueSavedOrder.includes(item)),
  ];
}

function AnimeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <g fill="none" fillRule="evenodd">
        <path d="m12.593 23.258-.011.002-.071.035-.02.004-.014-.004-.071-.035q-.016-.005-.024.005l-.004.01-.017.428.005.02.01.013.104.074.015.004.012-.004.104-.074.012-.016.004-.017-.017-.427q-.004-.016-.017-.018m.265-.113-.013.002-.185.093-.01.01-.003.011.018.43.005.012.008.007.201.093q.019.005.029-.008l.004-.014-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014-.034.614q.001.018.017.024l.015-.002.201-.093.01-.008.004-.011.017-.43-.003-.012-.01-.01z" />
        <path
          fill="currentColor"
          d="M21.778 3.372a1 1 0 0 1 .116 1.075l-2 4a1 1 0 0 1-.777.546q-1.557.178-3.117.306v1.366a58 58 0 0 0 3.797-.644a1 1 0 0 1 .406 1.958q-.6.122-1.203.23V18a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2v-5.095c-.692.059-1.374.095-2 .095s-1.308-.037-2-.095V18a1 1 0 1 1 0 2H5a1 1 0 0 1 0-2v-5.79a51 51 0 0 1-1.203-.23a1 1 0 0 1 .406-1.96c1.258.258 2.525.47 3.797.645V9.299a100 100 0 0 1-3.116-.306a1.01 1.01 0 0 1-.778-.546l-2-4a1 1 0 0 1 1.143-1.415l.47.117l.952.224l.856.191l.642.137l.337.069q.398.08.81.158l.83.15c1.392.24 2.798.422 3.854.422s2.462-.181 3.853-.421l.83-.15l.81-.16l.98-.205l.856-.19l.482-.113q.471-.11.939-.23a1 1 0 0 1 1.028.34ZM17 18v-5.459l-.66.096l-.34.046V18zM7 12.541v5.46h1v-5.318l-.675-.094zm7-1.644v-1.46l-.827.04c-.407.014-.803.023-1.173.023s-.766-.009-1.173-.024L10 9.438v1.459c.703.063 1.387.103 2 .103c.49 0 1.026-.025 1.581-.068zm4.349-3.83l.801-1.604l-1.175.256c-1.967.42-3.972.781-5.975.781s-4.008-.361-5.975-.78L4.85 5.462l.801 1.603c2.107.226 4.23.434 6.349.434c1.817 0 3.636-.153 5.445-.339l.904-.095Z"
        />
      </g>
    </svg>
  );
}

export default function Sidebar() {
  const location = useLocation();
  const { state, scanLibrary } = useLibrary();
  const isSettingsActive = location.pathname === '/settings';
  const sourceRoute = (location.state as { from?: string } | null)?.from;
  const activeNavItemId = getActiveNavItemId(location.pathname, sourceRoute);
  const [navOrder, setNavOrder] = useState<SidebarNavItemId[]>(defaultSidebarNavOrder);

  useEffect(() => {
    let mounted = true;

    desktopApi.getSettings().then((settings) => {
      if (mounted) {
        setNavOrder(normalizeSidebarNavOrder(settings.sidebarNavOrder));
      }
    });

    const handleSidebarOrderChanged = (event: Event) => {
      const nextOrder = (event as CustomEvent<string[]>).detail;
      setNavOrder(normalizeSidebarNavOrder(nextOrder));
    };

    window.addEventListener('loomtv:sidebar-order-changed', handleSidebarOrderChanged);

    return () => {
      mounted = false;
      window.removeEventListener('loomtv:sidebar-order-changed', handleSidebarOrderChanged);
    };
  }, []);

  const navItems = useMemo(
    () => [
      homeNavItem,
      ...navOrder.map((itemId) => sidebarNavItems[itemId]),
    ],
    [navOrder],
  );
  const activeNavIndex = navItems.findIndex((item) => item.id === activeNavItemId);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let mounted = true;
    desktopApi.getUpdateState().then((nextState) => {
      if (mounted) setUpdateState(nextState);
    });
    const unsubscribe = desktopApi.onUpdateState((nextState) => {
      setUpdateState(nextState);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const showUpdateButton = updateState?.status === 'downloaded' || updateState?.status === 'downloading';
  const updateButtonLabel = updateState?.status === 'downloaded' ? 'Update' : 'Updating';

  return (
    <aside className="w-48 bg-[var(--loom-sidebar)] h-full flex flex-col border-r border-[var(--loom-border)]">
      <div className="p-4 border-b border-[var(--loom-border)]">
        <Link to="/" className="inline-flex h-10 items-center transition-opacity hover:opacity-85" aria-label="LoomTV home">
          <LoomLogo className="h-8 w-auto" />
        </Link>
      </div>
      <nav className="flex-1 p-3 flex flex-col">
        <div className="relative">
          {activeNavIndex >= 0 && (
            <motion.span
              className="pointer-events-none absolute left-0 right-0 top-0 h-10 rounded-lg bg-[var(--loom-surface-3)]"
              initial={false}
              animate={{ y: activeNavIndex * (navItemHeight + navItemGap) }}
              transition={{ type: 'spring', stiffness: 420, damping: 40, mass: 0.9 }}
            />
          )}
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeNavItemId === item.id;

            return (
              <Link
                key={item.path}
                to={item.path}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative z-10 mb-1 flex h-10 items-center gap-3 rounded-lg px-3 transition-colors',
                  isActive
                    ? 'text-white'
                    : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)]/55 hover:text-[var(--loom-text)]',
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>

        <div className="mt-auto flex items-center gap-1">
          {showUpdateButton && (
            <button
              type="button"
              onClick={() => {
                if (updateState?.status === 'downloaded') void desktopApi.installUpdate();
              }}
              disabled={updateState?.status !== 'downloaded'}
              className="mb-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white shadow-sm shadow-blue-950/20 transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:bg-blue-600/70"
              title={updateState?.message || 'Update LoomTV'}
            >
              <Download className={cn('h-4 w-4', updateState?.status === 'downloading' && 'animate-pulse')} />
              <span>{updateButtonLabel}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Link
            to="/settings"
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 rounded-lg transition-colors',
              isSettingsActive
                ? 'bg-[var(--loom-surface-3)] text-[var(--loom-text)]'
                : 'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]',
            )}
          >
            <Settings className="w-5 h-5 shrink-0" />
            <span className="truncate text-sm font-medium">Settings</span>
          </Link>
          <button
            type="button"
            onClick={() => void scanLibrary()}
            disabled={state.isScanning}
            aria-label="Refresh library"
            title="Refresh library"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)] disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={cn('h-5 w-5', state.isScanning && 'animate-spin')} />
          </button>
        </div>
      </nav>
    </aside>
  );
}
