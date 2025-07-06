'use client';

import React, { useState } from 'react';
import Link from 'next/link';

interface HeaderProps {
  title: string;
  getUrlWithLineId: (path: string) => string;
  currentPage?: 'dashboard' | 'expenses' | 'settings';
}

export default function Header({ title, getUrlWithLineId, currentPage = 'dashboard' }: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const menuItems = [
    { 
      href: getUrlWithLineId("/"), 
      label: "ダッシュボード", 
      icon: "📊",
      isActive: currentPage === 'dashboard'
    },
    { 
      href: getUrlWithLineId("/expenses"), 
      label: "支出一覧", 
      icon: "💰",
      isActive: currentPage === 'expenses'
    },
    { 
      href: getUrlWithLineId("/settings"), 
      label: "設定", 
      icon: "⚙️",
      isActive: currentPage === 'settings'
    }
  ];

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
  };

  return (
    <>
      {/* Overlay for mobile menu - rendered first so it's behind the menu */}
      {isMenuOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/20 z-[50]"
          onClick={closeMenu}
          aria-hidden="true"
        />
      )}

      <header className="relative bg-white/80 backdrop-blur-xl shadow-lg border-b border-white/20 z-[60]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
            
            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center space-x-4">
              {menuItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    item.isActive
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100'
                  }`}
                >
                  <span>{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* Mobile Hamburger Button */}
            <button
              onClick={toggleMenu}
              className="md:hidden p-2 rounded-lg text-gray-600 hover:text-gray-800 hover:bg-gray-100 transition-colors relative z-[70]"
              aria-label="メニューを開く"
            >
              <svg
                className={`w-6 h-6 transition-transform duration-200 ${isMenuOpen ? 'rotate-90' : ''}`}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                {isMenuOpen ? (
                  <path d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Menu */}
        {isMenuOpen && (
          <div className="md:hidden absolute top-full left-0 right-0 bg-white/95 backdrop-blur-xl border-b border-white/20 shadow-lg z-[70]">
            <nav className="max-w-7xl mx-auto px-4 py-4 space-y-2">
              {menuItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={closeMenu}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg text-base font-medium transition-colors ${
                    item.isActive
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100'
                  }`}
                >
                  <span className="text-xl">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        )}
      </header>
    </>
  );
}