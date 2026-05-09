import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Film, Home, Settings, Sparkles, Tv } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { path: '/', label: 'Home', icon: Home },
  { path: '/anime', label: 'Anime', icon: Sparkles },
  { path: '/tv', label: 'TV Shows', icon: Tv },
  { path: '/movies', label: 'Movies', icon: Film },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const location = useLocation();

  return (
    <aside className="w-48 bg-[#232323] h-full flex flex-col">
      <div className="p-4 border-b border-[#2d2d2d]">
        <h1 className="text-xl font-bold text-[#eba865]">LoomTV</h1>
      </div>
      <nav className="flex-1 p-3">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path
            || (item.path !== '/' && location.pathname.startsWith(`${item.path}/`));

          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg mb-1 transition-colors',
                isActive
                  ? 'bg-[#2d2d2d] text-white'
                  : 'text-[#a8a8a8] hover:bg-[#2d2d2d] hover:text-white',
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="text-sm font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
