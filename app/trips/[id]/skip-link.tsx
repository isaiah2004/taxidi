'use client';

/**
 * SkipLink — a "Skip to main content" anchor that's hidden by default
 * and only visible when focused via keyboard. Should be the first focusable
 * element on the page so keyboard / screen-reader users can bypass the
 * sidebar and header chrome and jump straight to the trip content.
 *
 * Targets `#main` — wire this onto the page's `<main>` element.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
  );
}
