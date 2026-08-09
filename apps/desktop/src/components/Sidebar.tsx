import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Check, Compass, Download, LockKeyhole, Plus, RefreshCw, Search, UsersRound } from 'lucide-react';
import { FolderNavIcon, FolderNavSolidIcon } from '@/components/LoomIcons';
import { libraryMutationMessage, useLibrary } from '@/contexts/LibraryContext';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi, UpdateState } from '@/lib/desktopApi';
import { cn } from '@/lib/utils';
import LoomLogo from '@/components/LoomLogo';
import ProfileAvatar from '@/components/profiles/ProfileAvatar';
import { useTheme } from '@/components/ThemeProvider';
import SharedListHighlight from '@/components/SharedListHighlight';
import { useToast } from '@/components/ToastProvider';

type SidebarNavItemId = 'anime' | 'tv' | 'movies' | 'others';
type NavItemId = 'home' | 'discover' | SidebarNavItemId | 'settings';
type SidebarIcon = React.ComponentType<{ className?: string }>;
type SidebarNavItem = { id: NavItemId; path: string; label: string; icon: SidebarIcon; activeIcon?: SidebarIcon };

const defaultSidebarNavOrder: SidebarNavItemId[] = ['anime', 'tv', 'movies', 'others'];
const modernCategoryItems = [
  { label: 'Home', path: '/', routePrefix: '/', folderKey: null },
  { label: 'Anime', path: '/anime', routePrefix: '/anime', folderKey: 'anime' },
  { label: 'TV Shows', path: '/tv', routePrefix: '/tv', folderKey: 'tvShows' },
  { label: 'Movies', path: '/movies', routePrefix: '/movie', folderKey: 'movies' },
  { label: 'Others', path: '/others', routePrefix: '/others', folderKey: 'others' },
] as const;

const homeNavItem: SidebarNavItem = { id: 'home', path: '/', label: 'Home', icon: HomeSmileIcon, activeIcon: HomeSmileSolidIcon };
const discoverNavItem: SidebarNavItem = { id: 'discover', path: '/discover', label: 'Discover', icon: Compass };
const settingsNavItem: SidebarNavItem = { id: 'settings', path: '/settings', label: 'Settings', icon: SettingsNavExactIcon, activeIcon: SettingsNavSolidExactIcon };

const sidebarNavItems: Record<SidebarNavItemId, SidebarNavItem> = {
  anime: { id: 'anime', path: '/anime', label: 'Anime', icon: AnimeIcon, activeIcon: AnimeSolidIcon },
  tv: { id: 'tv', path: '/tv', label: 'TV Shows', icon: TVNavIcon, activeIcon: TVNavSolidIcon },
  movies: { id: 'movies', path: '/movies', label: 'Movies', icon: FilmNavIcon, activeIcon: FilmNavSolidExactIcon },
  others: { id: 'others', path: '/others', label: 'Others', icon: FolderNavIcon, activeIcon: FolderNavSolidIcon },
};

function hasLinkedLibraryFolder(folders: readonly unknown[] | undefined): boolean {
  return Boolean(folders?.some((folder) => typeof folder === 'string' && folder.trim().length > 0));
}

function getActiveNavItemId(pathname: string, fromPath?: string): NavItemId | null {
  const detailRoute = pathname.startsWith('/movie/') || pathname.startsWith('/tv/') || pathname.startsWith('/anime/');
  const activePath = detailRoute && fromPath ? fromPath : pathname;

  if (activePath === '/' || activePath.startsWith('/?')) return 'home';
  if (activePath === '/discover' || activePath.startsWith('/discover/')) return 'discover';
  if (activePath === '/movies' || activePath.startsWith('/movies/') || activePath.startsWith('/movie/')) return 'movies';
  if (activePath === '/tv' || activePath.startsWith('/tv/')) return 'tv';
  if (activePath === '/anime' || activePath.startsWith('/anime/')) return 'anime';
  if (activePath === '/others' || activePath.startsWith('/others/')) return 'others';
  if (activePath === '/settings') return 'settings';

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

function ModernCategoryPill({ pathname }: { pathname: string }) {
  const { state } = useLibrary();
  const visibleCategories = modernCategoryItems.filter((category) => !category.folderKey
    || hasLinkedLibraryFolder(state.libraryFolderGroups[category.folderKey]));
  const activeCategory = visibleCategories.find((category) => category.path === '/'
    ? pathname === '/'
    : pathname === category.path || pathname.startsWith(`${category.routePrefix}/`));

  return (
    <header className="loom-modern-header loom-no-drag fixed inset-x-0 top-5 z-50 flex justify-center px-5">
      <nav
        className="loom-modern-category-pill loom-no-drag h-12 rounded-full border p-1 backdrop-blur-2xl"
        aria-label="Library categories"
      >
        <SharedListHighlight
          activeId={activeCategory?.path}
          followPointer={false}
          className="loom-shared-highlight-category flex h-full items-center"
        >
          {visibleCategories.map((category) => {
            const isActive = category.path === activeCategory?.path;
            return (
              <Link
                key={category.path}
                to={category.path}
                aria-current={isActive ? 'page' : undefined}
                aria-pressed={isActive}
                data-shared-highlight-item
                data-shared-highlight-id={category.path}
                className={cn(
                  'relative z-10 inline-flex h-full items-center rounded-full px-5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]',
                  isActive ? 'loom-modern-category-active' : 'loom-modern-category-idle',
                )}
              >
                {category.label}
              </Link>
            );
          })}
        </SharedListHighlight>
      </nav>
    </header>
  );
}

function AnimeIcon({ className, solid = false }: { className?: string; solid?: boolean }) {
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
          fillRule={solid ? 'nonzero' : 'evenodd'}
          d="M21.778 3.372a1 1 0 0 1 .116 1.075l-2 4a1 1 0 0 1-.777.546q-1.557.178-3.117.306v1.366a58 58 0 0 0 3.797-.644a1 1 0 0 1 .406 1.958q-.6.122-1.203.23V18a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2v-5.095c-.692.059-1.374.095-2 .095s-1.308-.037-2-.095V18a1 1 0 1 1 0 2H5a1 1 0 0 1 0-2v-5.79a51 51 0 0 1-1.203-.23a1 1 0 0 1 .406-1.96c1.258.258 2.525.47 3.797.645V9.299a100 100 0 0 1-3.116-.306a1.01 1.01 0 0 1-.778-.546l-2-4a1 1 0 0 1 1.143-1.415l.47.117l.952.224l.856.191l.642.137l.337.069q.398.08.81.158l.83.15c1.392.24 2.798.422 3.854.422s2.462-.181 3.853-.421l.83-.15l.81-.16l.98-.205l.856-.19l.482-.113q.471-.11.939-.23a1 1 0 0 1 1.028.34ZM17 18v-5.459l-.66.096l-.34.046V18zM7 12.541v5.46h1v-5.318l-.675-.094zm7-1.644v-1.46l-.827.04c-.407.014-.803.023-1.173.023s-.766-.009-1.173-.024L10 9.438v1.459c.703.063 1.387.103 2 .103c.49 0 1.026-.025 1.581-.068zm4.349-3.83l.801-1.604l-1.175.256c-1.967.42-3.972.781-5.975.781s-4.008-.361-5.975-.78L4.85 5.462l.801 1.603c2.107.226 4.23.434 6.349.434c1.817 0 3.636-.153 5.445-.339l.904-.095Z"
        />
      </g>
    </svg>
  );
}

function AnimeSolidIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <g fill="none" fillRule="evenodd">
        <path d="m12.593 23.258-.011.002-.071.035-.02.004-.014-.004-.071-.035q-.016-.005-.024.005l-.004.01-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113-.013.002-.185.093-.01.01-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093q.019-.005.029-.024l.017-.43l-.003-.012l-.01-.01z" />
        <path fill="currentColor" d="M21.778 3.372a1 1 0 0 1 .116 1.075l-2 4a1 1 0 0 1-.777.546q-1.557.178-3.117.306v1.366a58 58 0 0 0 3.797-.644a1 1 0 0 1 .406 1.958q-.6.122-1.203.23V18a1 1 0 1 1 0 2h-5a1 1 0 1 1 0-2v-5.095c-.692.059-1.374.095-2 .095s-1.308-.037-2-.095V18a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2v-5.79a51 51 0 0 1-1.203-.23a1 1 0 0 1 .406-1.96c1.258.258 2.525.47 3.797.645V9.299a100 100 0 0 1-3.116-.306a1.01 1.01 0 0 1-.778-.546l-2-4a1 1 0 0 1 1.143-1.415l.47.117l.952.224l.856.191l.642.137l.337.069q.398.08.81.158l.83.15c1.392.24 2.798.422 3.854.422s2.462-.181 3.853-.421l.83-.15l.81-.16l.98-.205l.856-.19l.482-.113q.471-.11.939-.23a1 1 0 0 1 1.028.34ZM14 10.897v-1.46l-.827.04c-.407.014-.803.023-1.173.023s-.766-.009-1.173-.024L10 9.438v1.459c.703.063 1.387.103 2 .103c.49 0 1.026-.025 1.581-.068z" />
      </g>
    </svg>
  );
}

function HomeSmileIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true"><path d="M8.12602 14C8.57006 15.7252 10.1362 17 12 17C13.8638 17 15.4299 15.7252 15.874 14M11.0177 2.764L4.23539 8.03912C3.78202 8.39175 3.55534 8.56806 3.39203 8.78886C3.24737 8.98444 3.1396 9.20478 3.07403 9.43905C3 9.70352 3 9.9907 3 10.5651V17.8C3 18.9201 3 19.4801 3.21799 19.908C3.40973 20.2843 3.71569 20.5903 4.09202 20.782C4.51984 21 5.07989 21 6.2 21H17.8C18.9201 21 19.4802 21 19.908 20.782C20.2843 20.5903 20.5903 20.782 20.782 19.908C21 19.4801 21 18.9201 21 17.8V10.5651C21 9.9907 21 9.70352 20.926 9.43905C20.8604 9.20478 20.7526 8.98444 20.608 8.78886C20.4447 8.56806 20.218 8.39175 19.7646 8.03913L12.9823 2.764C12.631 2.49075 12.4553 2.35412 12.2613 2.3016C12.0902 2.25526 11.9098 2.25526 11.7387 2.3016C11.5447 2.35412 11.369 2.49075 11.0177 2.764Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function HomeSmileSolidIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true"><path d="M12.5227 1.33636C12.1804 1.24368 11.8196 1.24368 11.4773 1.33636C11.0799 1.44395 10.7454 1.7066 10.4784 1.91623L10.4037 1.97465L3.54373 7.31012C3.1671 7.6024 2.83529 7.85991 2.58803 8.19421C2.37104 8.48759 2.20939 8.8181 2.11103 9.1695C1.99895 9.56992 1.9994 9.98993 1.99992 10.4667L1.99999 17.8385C1.99997 18.3657 1.99995 18.8204 2.03056 19.195C2.06286 19.5904 2.13417 19.9836 2.32697 20.362C2.61459 20.9264 3.07353 21.3854 3.63802 21.673C4.0164 21.8658 4.40961 21.9371 4.80496 21.9694C5.17953 22 5.63428 22 6.16142 22H17.8386C18.3657 22 18.8204 22 19.195 21.9694C19.5904 21.9371 19.9836 21.8658 20.362 21.673C20.9264 21.3854 21.3854 20.9264 21.673 20.362C21.8658 19.9836 21.8658 19.5904 21.9694 19.195C22 18.8204 22 18.3657 22 17.8386L22.0001 10.4667C22.0006 9.98993 22.001 9.56992 21.8889 9.1695C21.7906 8.8181 21.6289 8.48759 21.4119 8.19421C21.1647 7.8599 20.8329 7.6024 20.4562 7.31011L13.5962 1.97465L13.5216 1.91623C13.2546 1.7066 12.92 1.44395 12.5227 1.33636ZM9.09444 13.7507C8.95678 13.2159 8.4116 12.8939 7.87675 13.0316C7.34189 13.1692 7.01991 13.7144 7.15757 14.2493C7.71257 16.4056 9.66882 18 12 18C14.3312 18 16.2874 16.4056 16.8424 14.2493C16.9801 13.7144 16.6581 13.1692 16.1232 13.0316C15.5884 12.8939 15.0432 13.2156 14.9055 13.7507C14.5724 15.0449 13.3965 16 12 16C10.6035 16 9.42753 15.0449 9.09444 13.7507Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" /></svg>;
}

function FilmNavIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true"><path d="M2 12H22M2 7H7M17 7H22M2 17H7M17 17H22M7 22V2M17 22V2M6.8 22H17.2C18.8802 22 19.7202 22 20.362 21.673C20.9265 21.3854 21.3854 20.9265 21.673 20.362C22 19.7202 22 18.8802 22 17.2V6.8C22 5.11984 22 4.27976 21.673 3.63803C21.3854 3.07354 20.9265 2.6146 20.362 2.32698C19.7202 2 18.8802 2 17.2 2H6.8C5.11984 2 4.27976 2 3.63803 2.32698C3.07354 2.6146 2.6146 3.07354 2.32698 3.63803C2 4.27976 2 5.11984 2 6.8V17.2C2 18.8802 2 19.7202 2.32698 20.362C2.6146 20.9265 3.07354 21.3854 3.63803 21.673C4.27976 22 5.11984 22 6.8 22Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function TVNavIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true"><path d="M17 3L12 7L7 3M6.8 21H17.2C18.8802 21 19.7202 21 20.362 20.673C20.9265 20.3854 21.3854 19.9265 21.673 19.362C22 18.7202 22 17.8802 22 16.2V11.8C22 10.1198 22 9.27976 21.673 8.63803C21.3854 8.07354 20.9265 7.6146 20.362 7.32698C19.7202 7 18.8802 7 17.2 7H6.8C5.11984 7 4.27976 7 3.63803 7.32698C3.07354 7.6146 2.6146 8.07354 2.32698 8.63803C2 9.27976 2 10.1198 2 11.8V16.2C2 17.8802 2 18.7202 2.32698 19.362C2.6146 19.9265 3.07354 20.3854 3.63803 20.673C4.27984 21 5.11984 21 6.8 21Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function TVNavSolidIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true"><path d="M7.625 2.219a1 1 0 1 0-1.25 1.562L9.149 6H6.759C3 6 1 8 1 11.759v4.482C1 20 3 22 6.759 22h10.482C21 22 23 20 23 16.241v-4.482C23 8 21 6 17.241 6h-2.39l2.774-2.219a1 1 0 1 0-1.25-1.562L12 5.719 7.625 2.219Z" fill="currentColor" /></svg>;
}

function FilmNavSolidExactIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M6.7587 1C5.95374 0.999988 5.28937 0.999978 4.74818 1.04419C4.18608 1.09012 3.66937 1.18868 3.18404 1.43598C2.43139 1.81947 1.81947 2.43139 1.43598 3.18404C1.18868 3.66937 1.09012 4.18608 1.04419 4.74818C0.999978 5.28937 0.999988 5.95372 1 6.75869V17.2413C0.999988 18.0463 0.999978 18.7106 1.04419 19.2518C1.09012 19.8139 1.18868 20.3306 1.43598 20.816C1.81947 21.5686 2.43139 22.1805 3.18404 22.564C3.66937 22.8113 4.18608 22.9099 4.74818 22.9558C5.28937 23 5.95372 23 6.75868 23H17.2413C18.0463 23 18.7106 23 19.2518 22.9558C19.8139 22.9099 20.3306 22.8113 20.816 22.564C21.5686 22.1805 22.1805 21.5686 22.564 20.816C22.8113 20.3306 22.9099 19.8139 22.9558 19.2518C23 18.7106 23 18.0463 23 17.2413V6.75868C23 5.95372 23 5.28937 22.9558 4.74818C22.9099 4.18608 22.8113 3.66937 22.564 3.18404C22.1805 2.43139 21.5686 1.81947 20.816 1.43598C20.3306 1.18868 19.8139 1.09012 19.2518 1.04419C18.7106 0.999978 18.0463 0.999988 17.2413 1H6.7587ZM18 6V3.00176C18.4455 3.00489 18.7954 3.01357 19.089 3.03755C19.5274 3.07337 19.7516 3.1383 19.908 3.21799C20.2843 3.40973 20.5903 3.7157 20.782 4.09202C20.8617 4.24842 20.9266 4.47262 20.9624 4.91104C20.9864 5.20463 20.9951 5.55447 20.9982 6H18ZM18 8V11H21V8H18ZM18 16V13H21V16H18ZM18 18V20.9982C18.4455 20.9951 18.7954 20.9864 19.089 20.9624C19.5274 20.9266 19.7516 20.8617 19.908 20.782C20.2843 20.5903 20.5903 20.2843 20.782 19.908C20.8617 19.7516 20.9266 19.5274 20.9624 19.089C20.9864 18.7954 20.9951 18.4455 20.9982 18H18ZM4.91104 3.03755C5.20463 3.01357 5.55447 3.00489 6 3.00176V6H3.00176C3.00489 5.55447 3.01357 5.20463 3.03755 4.91104C3.07337 4.47262 3.1383 4.24842 3.21799 4.09202C3.40973 3.7157 3.7157 3.40973 4.09202 3.21799C4.24842 3.1383 4.47262 3.07337 4.91104 3.03755ZM3 8H6V11H3V8ZM3 13H6V16H3V13ZM3.00176 18H6V20.9982C5.55447 20.9951 5.20463 20.9864 4.91104 20.9624C4.47262 20.9266 4.24842 20.8617 4.09202 20.782C3.7157 20.5903 3.40973 20.2843 3.21799 19.908C3.1383 19.7516 3.07337 19.5274 3.03755 19.089C3.01357 18.7954 3.00489 18.4455 3.00176 18Z" fillRule="evenodd" clipRule="evenodd" fill="currentColor" />
  </svg>;
}

function SettingsNavExactIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.7273 14.7273C18.6063 15.0015 18.5702 15.3056 18.6236 15.6005C18.6771 15.8954 18.8177 16.1676 19.0273 16.3818L19.0818 16.4364C19.2509 16.6052 19.385 16.8057 19.4765 17.0265C19.568 17.2472 19.6151 17.4838 19.6151 17.7227C19.6151 17.9617 19.568 18.1983 19.4765 18.419C19.385 18.6397 19.2509 18.8402 19.0818 19.0091C18.913 19.1781 18.7124 19.3122 18.4917 19.4037C18.271 19.4952 18.0344 19.5423 17.7955 19.5423C17.5565 19.5423 17.3199 19.4952 17.0992 19.4037C16.8785 19.3122 16.678 19.1781 16.5091 19.0091L16.4545 18.9545C16.2403 18.745 15.9682 18.6044 15.6733 18.5509C15.3784 18.4974 15.0742 18.5335 14.8 18.6545C14.5311 18.7698 14.3018 18.9611 14.1403 19.205C13.9788 19.4489 13.8921 19.7347 13.8909 20.0273V20.1818C13.8909 20.664 13.6994 21.1265 13.3584 21.4675C13.0174 21.8084 12.5549 22 12.0727 22C11.5905 22 11.1281 21.8084 10.7871 21.4675C10.4461 21.1265 10.2545 20.664 10.2545 20.1818V20.1C10.2475 19.7991 10.1501 19.5073 9.97501 19.2625C9.79991 19.0176 9.55521 18.8312 9.27273 18.7273C8.99853 18.6063 8.69437 18.5702 8.39947 18.6236C8.10456 18.6771 7.83244 18.8177 7.61818 19.0273L7.56364 19.0818C7.39478 19.2509 7.19425 19.385 6.97353 19.4765C6.7528 19.568 6.51621 19.6151 6.27727 19.6151C6.03834 19.6151 5.80174 19.568 5.58102 19.4765C5.36029 19.385 5.15977 19.2509 4.99091 19.0818C4.82186 18.913 4.68775 18.7124 4.59626 18.4917C4.50476 18.271 4.45766 18.0344 4.45766 17.7955C4.45766 17.5565 4.50476 17.3199 4.59626 17.0992C4.68775 16.8785 4.82186 16.678 4.99091 16.5091L5.04545 16.4545C5.25503 16.2403 5.39562 15.9682 5.4491 15.6733C5.50257 15.3784 5.46647 15.0742 5.34545 14.8C5.23022 14.5311 5.03887 14.3018 4.79497 14.1403C4.55107 13.9788 4.26526 13.8921 3.97273 13.8909H3.81818C3.33597 13.8909 2.87351 13.6994 2.53253 13.3584C2.19156 13.0174 2 12.5549 2 12.0727C2 11.5905 2.19156 11.1281 2.53253 10.7871C2.87351 10.4461 3.33597 10.2545 3.81818 10.2545H3.9C4.2009 10.2475 4.49273 10.1501 4.73754 9.97501C4.98236 9.79991 5.16883 9.55521 5.27273 9.27273C5.39374 8.99853 5.42984 8.69437 5.37637 8.39947C5.3229 8.10456 5.18231 7.83244 4.97273 7.61818L4.91818 7.56364C4.74913 7.39478 4.61503 7.19425 4.52353 6.97353C4.43203 6.7528 4.38493 6.51621 4.38493 6.27727C4.38493 6.03834 4.43203 5.80174 4.52353 5.58102C4.61503 5.36029 4.74913 5.15977 4.91818 4.99091C5.08704 4.82186 5.28757 4.68775 5.50829 4.59626C5.72901 4.50476 5.96561 4.45766 6.20455 4.45766C6.44348 4.45766 6.68008 4.50476 6.9008 4.59626C7.12152 4.68775 7.32205 4.82186 7.49091 4.99091L7.54545 5.04545C7.75971 5.25503 8.03183 5.39562 8.32674 5.4491C8.62164 5.50257 8.9258 5.46647 9.2 5.34545H9.27273C9.54161 5.23022 9.77093 5.03887 9.93245 4.79497C10.094 4.55107 10.1807 4.26526 10.1818 3.97273V3.81818C10.1818 3.33597 10.3734 2.87351 10.7144 2.53253C11.0553 2.19156 11.5178 2 12 2C12.4822 2 12.9447 2.19156 13.2856 2.53253C13.6266 2.87351 13.8182 3.33597 13.8182 3.81818V3.9C13.8193 4.19253 13.906 4.47834 14.0676 4.72224C14.2291 4.96614 14.4584 5.15749 14.7273 5.27273C15.0015 5.39374 15.3056 5.42984 15.6005 5.37637C15.8954 5.3229 16.1676 5.18231 16.3818 4.97273L16.4364 4.91818C16.6052 4.74913 16.8057 4.61503 17.0265 4.52353C17.2472 4.43203 17.4838 4.38493 17.7227 4.38493C17.9617 4.38493 18.1983 4.43203 18.419 4.52353C18.6397 4.61503 18.8402 4.74913 19.0091 4.91818C19.1781 5.08704 19.3122 5.28757 19.4037 5.50829C19.4952 5.72901 19.5423 5.96561 19.5423 6.20455C19.5423 6.44348 19.4952 6.68008 19.4037 6.9008C19.3122 7.12152 19.1781 7.32205 19.0091 7.49091L18.9545 7.54545C18.745 7.75971 18.6044 8.03183 18.5509 8.32674C18.4974 8.62164 18.5335 8.9258 18.6545 9.2V9.27273C18.7698 9.54161 18.9611 9.77093 19.205 9.93245C19.4489 10.094 19.7347 10.1807 20.0273 10.1818H20.1818C20.664 10.1818 21.1265 10.3734 21.4675 10.7144C21.8084 11.0553 22 11.5178 22 12C22 12.4822 21.8084 12.9447 21.4675 13.2856C21.1265 13.6266 20.664 13.8182 20.1818 13.8182H20.1C19.8075 13.8193 19.5217 13.906 19.2778 14.0676C19.0339 14.2291 18.8425 14.4584 18.7273 14.7273Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function SettingsNavSolidExactIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M19.286 15.9606C19.2272 15.6362 19.2669 15.3016 19.4 15C19.5268 14.7042 19.7372 14.452 20.0055 14.2743C20.2738 14.0966 20.5882 14.0013 20.91 14H21C21.5304 14 22.0391 13.7893 22.4142 13.4142C22.7893 13.0391 23 12.5304 23 12C23 11.4696 22.7893 10.9609 22.4142 10.5858C22.0391 10.2107 21.5304 10 21 10H20.83C20.5082 9.99872 20.1938 9.90337 19.9255 9.72569C19.6572 9.54802 19.4468 9.29577 19.32 9V8.92C19.1869 8.61838 19.1472 8.28381 19.206 7.95941C19.2648 7.63502 19.4195 7.33568 19.65 7.1L19.71 7.04C19.896 6.85425 20.0435 6.63368 20.1441 6.39088C20.2448 6.14808 20.2966 5.88783 20.2966 5.625C20.2966 5.36217 20.2448 5.10192 20.1441 4.85912C20.0435 4.61632 19.896 4.39575 19.71 4.21C19.5243 4.02405 19.3037 3.87653 19.0609 3.77588C18.8181 3.67523 18.5578 3.62343 18.295 3.62343C18.0322 3.62343 17.7719 3.67523 17.5291 3.77588C17.2863 3.87653 17.0657 4.02405 16.88 4.21L16.82 4.27C16.5843 4.50054 16.285 4.65519 15.9606 4.714C15.6362 4.77282 15.3016 4.73312 15 4.6C14.7042 4.47324 14.452 4.26276 14.2743 3.99447C14.0966 3.72618 14.0013 3.41179 14 3.09V3C14 2.46957 13.7893 1.96086 13.4142 1.58579C13.0391 1.21071 12.5304 1 12 1C11.4696 1 10.9609 1.21071 10.5858 1.58579C10.2107 1.96086 10 2.46957 10 3V3.17C9.99872 3.49179 9.90337 3.80618 9.72569 4.07447C9.54802 4.34276 9.29577 4.55324 9 4.68H8.92C8.61838 4.81312 8.28381 4.85282 7.95941 4.794C7.63502 4.73519 7.33568 4.58054 7.1 4.35L7.04 4.29C6.85425 4.10405 6.63368 3.95653 6.39088 3.85588C6.14808 3.75523 5.88783 3.70343 5.625 3.70343C5.36217 3.70343 5.10192 3.75523 4.85912 3.85588C4.61632 3.95653 4.39575 4.10405 4.21 4.29C4.02405 4.47575 3.87653 4.69632 3.77588 4.93912C3.67523 5.18192 3.62343 5.44217 3.62343 5.705C3.62343 5.96783 3.67523 6.22808 3.77588 6.47088C3.87653 6.71368 4.02405 6.93425 4.21 7.12L4.27 7.18C4.50054 7.41568 4.65519 7.71502 4.714 8.03941C4.77282 8.36381 4.73312 8.69838 4.6 9C4.48572 9.31074 4.28059 9.5799 4.0113 9.77251C3.742 9.96512 3.42099 10.0723 3.09 10.08H3C2.46957 10.08 1.96086 10.2907 1.58579 10.6658C1.21071 11.0409 1 11.5496 1 12.08C1 12.6104 1.21071 13.1191 1.58579 13.4942C1.96086 13.8693 2.46957 14.08 3 14.08H3.17C3.49179 14.0813 3.80618 14.1766 4.07447 14.3543C4.34276 14.532 4.55324 14.7842 4.68 15.08C4.81312 15.3816 4.85282 15.7162 4.794 16.0406C4.73519 16.365 4.58054 16.6643 4.35 16.9L4.29 16.96C4.10405 17.1457 3.95653 17.3663 3.85588 17.6091C3.75523 17.8519 3.70343 18.1122 3.70343 18.375C3.70343 18.6378 3.75523 18.8981 3.85588 19.1409C3.95653 19.3837 4.10405 19.6043 4.29 19.79C4.47575 19.976 4.69632 20.1235 4.93912 20.2241C5.18192 20.3248 5.44217 20.3766 5.705 20.3766C5.96783 20.3766 6.22808 20.3248 6.47088 20.2241C6.71368 20.1235 6.93425 19.976 7.12 19.79L7.18 19.73C7.41568 19.4995 7.71502 19.3448 8.03941 19.286C8.36381 19.2272 8.69838 19.2669 9 19.4C9.31074 19.5143 9.5799 19.7194 9.77251 19.9887C9.96512 20.258 10.0723 20.579 10.08 20.91V21C10.08 21.5304 10.2907 22.0391 10.6658 22.4142C11.0409 22.7893 11.5496 23 12.08 23C12.6104 23 13.1191 22.7893 13.4942 22.4142C13.8693 22.0391 14.08 21.5304 14.08 21V20.83C14.0813 20.5082 14.1766 20.1938 14.3543 19.9255C14.532 19.6572 14.7842 19.4468 15.08 19.32C15.3816 19.1869 15.7162 19.1472 16.0406 19.206C16.365 19.2648 16.6643 19.4195 16.9 19.65L16.96 19.71C17.1457 19.896 17.3663 20.0435 17.6091 20.1441C17.8519 20.2448 18.1122 20.2966 18.375 20.2966C18.6378 20.2966 18.8981 20.2448 19.1409 20.1441C19.3837 20.0435 19.6043 19.896 19.79 19.71C19.976 19.5243 20.1235 19.3037 20.2241 19.0609C20.3248 18.8181 20.3766 18.5578 20.3766 18.295C20.3766 18.0322 20.3248 17.7719 20.2241 17.5291C20.1235 17.2863 19.976 17.0657 19.79 16.88L19.73 16.82C19.4995 16.5843 19.3448 16.285 19.286 15.9606ZM15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z" fillRule="evenodd" clipRule="evenodd" fill="currentColor" />
  </svg>;
}

function SidebarProfileSwitcher({ compact = false }: { compact?: boolean }) {
  const { activeProfile, canCreateProfiles, canManageProfiles, openGate, profiles, selectProfile } = useProfiles();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  if (!activeProfile) return null;
  const selectableProfiles = profiles.filter((profile) => !profile.isGuest);
  const handleProfileSelect = (profileId: string, hasPin: boolean) => {
    setMenuOpen(false);
    if (profileId === activeProfile.id) return;
    if (hasPin) {
      openGate({ mode: 'select', profileId, returnTo });
      return;
    }
    void selectProfile(profileId).catch(() => undefined);
  };

  return (
    <div ref={menuRef} className={cn('relative', compact ? 'w-12' : 'min-w-0 flex-1')}>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        title="Switch profile"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg text-left text-[var(--loom-muted)] transition-colors hover:text-[var(--loom-active-text)]',
          compact ? 'h-12 justify-center p-0 hover:bg-white/8' : 'px-3 py-2 hover:bg-[var(--loom-sidebar-active-bg)]',
          menuOpen && 'bg-[var(--loom-sidebar-active-bg)] text-[var(--loom-text)]',
        )}
      >
        <span className={cn('shrink-0 overflow-hidden rounded-full', compact ? 'h-9 w-9 ring-1 ring-white/20' : 'h-6 w-6')}>
          <ProfileAvatar name={activeProfile.name} avatarKey={activeProfile.avatarKey} colorKey={activeProfile.colorKey} />
        </span>
        <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', compact && 'sr-only')}>{activeProfile.name}</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Profiles"
          className={cn(
            'absolute z-50 isolate w-[12.12rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl bg-[var(--loom-surface)] p-1 text-[var(--loom-text)] shadow-[0_20px_60px_rgba(0,0,0,0.62)]',
            'bottom-full left-0 mb-2',
          )}
        >
          <SharedListHighlight activeId={activeProfile.id} className="loom-shared-highlight-menu">
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {selectableProfiles.map((profile) => {
              const isActive = profile.id === activeProfile.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  role="menuitem"
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => handleProfileSelect(profile.id, profile.hasPin)}
                  data-shared-highlight-item
                  data-shared-highlight-id={profile.id}
                  className="relative z-10 flex h-12 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]"
                >
                  <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full">
                    <ProfileAvatar name={profile.name} avatarKey={profile.avatarKey} colorKey={profile.colorKey} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="block truncate text-sm font-semibold leading-none">{profile.name}</span>
                    {profile.type === 'owner' && (
                      <span className="block text-xs leading-none text-[var(--loom-muted)]">Owner profile</span>
                    )}
                  </span>
                  {profile.hasPin && <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-[var(--loom-muted)]" />}
                  {isActive && <Check strokeWidth={3} className="h-4 w-4 shrink-0 text-[var(--loom-accent)]" />}
                </button>
              );
            })}
          </div>

          <div className="my-2 border-t border-[var(--loom-panel-border)] opacity-50" />
          {canCreateProfiles && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  openGate({ mode: 'edit', editProfileId: 'new', returnTo });
                }}
                data-shared-highlight-item
                data-shared-highlight-id="add-profile"
                className="relative z-10 flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-[var(--loom-muted)] transition-colors hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--loom-surface-2)]">
                  <Plus className="h-4 w-4" />
                </span>
                Add profile
              </button>
          )}
          {canManageProfiles && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  openGate({ mode: 'edit', returnTo });
                }}
                data-shared-highlight-item
                data-shared-highlight-id="manage-profiles"
                className="relative z-10 flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-[var(--loom-muted)] transition-colors hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--loom-surface-2)]">
                  <UsersRound className="h-4 w-4" />
                </span>
                Manage profiles
              </button>
            </>
          )}
          <Link
            to="/settings"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            data-shared-highlight-item
            data-shared-highlight-id="profile-settings"
            className="relative z-10 flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-[var(--loom-muted)] transition-colors hover:text-[var(--loom-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)]"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--loom-surface-2)]">
              <SettingsNavExactIcon className="h-4 w-4" />
            </span>
            Settings
          </Link>
          </SharedListHighlight>
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { activeProfile } = useProfiles();
  const { showToast } = useToast();
  const { state, scanLibrary } = useLibrary();
  const { libraryFolderGroups } = state;
  const sourceRoute = (location.state as { from?: string } | null)?.from;
  const activeNavItemId = getActiveNavItemId(location.pathname, sourceRoute);
  const [navOrder, setNavOrder] = useState<SidebarNavItemId[]>(defaultSidebarNavOrder);
  const [libraryActionError, setLibraryActionError] = useState('');

  const handleScanLibrary = async () => {
    setLibraryActionError('');
    try {
      await scanLibrary();
    } catch (error) {
      const message = libraryMutationMessage(error);
      setLibraryActionError(message);
      showToast({
        title: 'Library refresh failed',
        description: message,
        tone: 'error',
      });
    }
  };

  useEffect(() => {
    let mounted = true;

    Promise.all([desktopApi.getSettings(), desktopApi.getProfilePreferences()]).then(([settings, preferences]) => {
      if (mounted) {
        setNavOrder(normalizeSidebarNavOrder(preferences.sidebarNavOrder ?? settings.sidebarNavOrder));
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
  }, [activeProfile?.id]);

  const navItems = useMemo(
    () => [
      homeNavItem,
      ...(desktopApi.isRemoteLibraryMode() ? [] : [discoverNavItem]),
      ...(desktopApi.isRemoteLibraryMode() ? defaultSidebarNavOrder : navOrder)
        .map((itemId) => sidebarNavItems[itemId])
        .filter((item) => {
          if (desktopApi.isRemoteLibraryMode()) return true;
          const folderKey = item.id === 'tv' ? 'tvShows' : item.id;
          return hasLinkedLibraryFolder(libraryFolderGroups[folderKey as keyof typeof libraryFolderGroups]);
        }),
    ],
    [libraryFolderGroups, navOrder],
  );
  const mobileNavItems = useMemo(
    () => [
      homeNavItem,
      ...(desktopApi.isRemoteLibraryMode() ? [] : [discoverNavItem]),
      ...([sidebarNavItems.anime, sidebarNavItems.tv, sidebarNavItems.movies, sidebarNavItems.others] as SidebarNavItem[]).filter((item) => {
        if (desktopApi.isRemoteLibraryMode()) return true;
        const folderKey = item.id === 'tv' ? 'tvShows' : item.id;
        return hasLinkedLibraryFolder(libraryFolderGroups[folderKey as keyof typeof libraryFolderGroups]);
      }),
      settingsNavItem,
    ],
    [libraryFolderGroups],
  );
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

  const showUpdateButton = updateState?.status === 'downloaded' || updateState?.status === 'downloading' || updateState?.status === 'installing';
  const updateButtonLabel =
    updateState?.status === 'downloaded'
      ? 'Update ready'
      : updateState?.status === 'installing'
        ? 'Restarting'
        : updateState?.downloadPercent
          ? `Downloading ${Math.round(updateState.downloadPercent)}%`
          : 'Downloading';
  const updateDownloadPercent = updateState?.status === 'downloading'
    ? Math.max(0, Math.min(100, Math.round(updateState.downloadPercent || 0)))
    : 0;
  const scanProgress = Math.max(0, Math.min(100, Math.round(state.scanProgress || 0)));
  const scanButtonLabel = state.isScanning
    ? `Refreshing library ${scanProgress}%`
    : 'Refresh library';

  const isModern = theme.homeStyle === 'modern';

  if (isModern) {
    return (
      <>
        {libraryActionError ? <span role="alert" className="sr-only">{libraryActionError}</span> : null}
        <aside className="loom-modern-sidebar loom-no-drag fixed inset-y-0 left-0 z-50 flex w-20 flex-col items-center py-5">
          <nav className="mt-6 flex flex-1 flex-col items-center" aria-label="Primary navigation">
            <SharedListHighlight
              activeId={activeNavItemId}
              followPointer={false}
              className="loom-shared-highlight-sidebar-modern flex flex-col items-center gap-3"
            >
              <button
                type="button"
                onClick={() => navigate('/', { replace: location.pathname === '/', state: { openLibrarySearch: true } })}
                title="Search library"
                aria-label="Search library"
                data-shared-highlight-item
                data-shared-highlight-id="search"
                className="loom-modern-sidebar-action relative z-10 grid h-12 w-12 place-items-center rounded-full transition-colors hover:bg-[var(--loom-sidebar-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              >
                <Search className="h-6 w-6" />
              </button>
              {navItems.map((item) => {
                const isActive = activeNavItemId === item.id;
                const Icon = isActive ? (item.activeIcon || item.icon) : item.icon;
                return (
                  <Link
                    key={`modern-${item.path}`}
                    to={item.path}
                    title={item.label}
                    aria-label={item.label}
                    aria-current={isActive ? 'page' : undefined}
                    data-shared-highlight-item
                    data-shared-highlight-id={item.id}
                    className={cn(
                      'loom-modern-sidebar-action relative z-10 grid h-12 w-12 place-items-center rounded-full transition-colors hover:bg-[var(--loom-sidebar-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]',
                      isActive && 'loom-modern-sidebar-action-active',
                    )}
                  >
                    <Icon className="h-6 w-6" />
                  </Link>
                );
              })}
            </SharedListHighlight>
          </nav>
          {state.isScanning && (
            <div
              className="loom-modern-sidebar-action relative mb-3 grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--loom-surface-2)] text-[var(--loom-text)]"
              title={scanButtonLabel}
              aria-label={scanButtonLabel}
              role="status"
              aria-live="polite"
            >
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 bg-[var(--loom-accent)]/35 transition-[height] duration-300"
                style={{ height: `${scanProgress}%` }}
                aria-hidden="true"
              />
              <span className="relative z-10 flex flex-col items-center leading-none">
                <RefreshCw className="loom-scan-spinner h-4 w-4" />
                <span className="mt-1 text-[9px] font-semibold tabular-nums">{scanProgress}%</span>
              </span>
            </div>
          )}
          {showUpdateButton && (
            <button
              type="button"
              onClick={() => {
                if (updateState?.status === 'downloaded') void desktopApi.installUpdate();
              }}
              disabled={updateState?.status !== 'downloaded'}
              className="loom-modern-sidebar-action relative mb-3 grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--loom-surface-2)] text-[var(--loom-text)] disabled:cursor-wait"
              title={updateState?.message || updateButtonLabel}
              aria-label={updateButtonLabel}
            >
              {updateState?.status === 'downloading' && (
                <span
                  className="pointer-events-none absolute inset-x-0 bottom-0 bg-[var(--loom-accent)]/35 transition-[height] duration-300"
                  style={{ height: `${updateDownloadPercent}%` }}
                  aria-hidden="true"
                />
              )}
              <span className="relative z-10 flex flex-col items-center leading-none">
                <Download className={cn('h-4 w-4', updateState?.status === 'downloading' && 'animate-pulse')} />
                {updateState?.status === 'downloading' && (
                  <span className="mt-1 text-[9px] font-semibold tabular-nums">{updateDownloadPercent}%</span>
                )}
              </span>
            </button>
          )}
          <SidebarProfileSwitcher compact />
        </aside>
        {!location.pathname.startsWith('/settings') && <ModernCategoryPill pathname={location.pathname} />}
      </>
    );
  }

  return (
    <aside className="h-full w-48 bg-[var(--loom-sidebar)] flex flex-col">
      <div className="loom-sidebar-brand relative bg-transparent p-4">
        <div className="loom-sidebar-drag-region" aria-hidden="true" />
        <Link to="/" className="loom-no-drag relative z-10 inline-flex h-10 items-center transition-opacity hover:opacity-85" aria-label="LoomTV home">
          <LoomLogo className="h-8 w-auto" />
        </Link>
      </div>
      <nav className="flex-1 p-3 pt-0 flex flex-col">
        {libraryActionError ? <span role="alert" className="sr-only">{libraryActionError}</span> : null}
        <SharedListHighlight activeId={activeNavItemId} className="loom-shared-highlight-sidebar relative">
          {navItems.map((item) => {
            const isActive = activeNavItemId === item.id;
            const Icon = isActive ? (item.activeIcon || item.icon) : item.icon;

            return (
              <Link
                key={item.path}
                to={item.path}
                aria-current={isActive ? 'page' : undefined}
                data-shared-highlight-item
                data-shared-highlight-id={item.id}
                className={cn(
                  'relative z-10 mb-1 flex h-10 items-center gap-3 rounded-lg px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]',
                  isActive
                    ? 'text-[var(--loom-active-text)]'
                    : 'text-[var(--loom-muted)] hover:text-[var(--loom-active-text)]',
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            );
          })}
          {mobileNavItems.map((item) => {
            const isActive = activeNavItemId === item.id;
            const Icon = isActive ? (item.activeIcon || item.icon) : item.icon;

            return (
              <Link
                key={`mobile-${item.path}`}
                to={item.path}
                aria-current={isActive ? 'page' : undefined}
                data-shared-highlight-item
                data-shared-highlight-id={item.id}
                className={cn(
                  'loom-mobile-nav-link relative z-10 mb-1 hidden h-10 items-center gap-3 rounded-lg px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]',
                  isActive
                    ? 'text-[var(--loom-active-text)]'
                    : 'text-[var(--loom-muted)] hover:text-[var(--loom-active-text)]',
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            );
          })}
        </SharedListHighlight>

        <div className="mt-auto flex items-center gap-1">
          {showUpdateButton && (
            <button
              type="button"
              onClick={() => {
                if (updateState?.status === 'downloaded') void desktopApi.installUpdate();
              }}
              disabled={updateState?.status !== 'downloaded'}
              className="relative mb-2 flex h-9 w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-[var(--loom-active-bg)] px-3 text-xs font-semibold text-[var(--loom-text)] transition-colors hover:bg-[var(--loom-surface-3)] disabled:cursor-wait disabled:text-[var(--loom-muted)]"
              title={updateState?.message || 'Update LoomTV'}
            >
              {updateState?.status === 'downloading' && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--loom-accent)]/20 transition-[width] duration-300"
                  style={{ width: `${updateDownloadPercent}%` }}
                  aria-hidden="true"
                />
              )}
              <Download className={cn('relative z-10 h-4 w-4', updateState?.status === 'downloading' && 'animate-pulse')} />
              <span className="relative z-10">{updateButtonLabel}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <SidebarProfileSwitcher />
          <button
            type="button"
            onClick={() => void handleScanLibrary()}
            disabled={state.isScanning}
            aria-label="Refresh library"
            title={scanButtonLabel}
            className={cn(
              'relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)] disabled:cursor-wait disabled:opacity-60',
              state.isScanning && 'bg-[var(--loom-surface-2)] text-[var(--loom-text)]',
            )}
          >
            {state.isScanning && (
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 bg-[var(--loom-accent)]/35 transition-[height] duration-300"
                style={{ height: `${scanProgress}%` }}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10 flex flex-col items-center leading-none">
              <RefreshCw className={cn('h-5 w-5', state.isScanning && 'loom-scan-spinner')} />
              {state.isScanning && <span className="mt-0.5 text-[8px] font-semibold tabular-nums">{scanProgress}%</span>}
            </span>
          </button>
        </div>
      </nav>
    </aside>
  );
}
