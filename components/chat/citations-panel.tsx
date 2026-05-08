'use client';

import { ExternalLinkIcon } from 'lucide-react';

export interface Citation {
  url: string;
  title?: string;
  snippet?: string;
}

/**
 * Tiny inline accordion for citations. We use the native `<details>`
 * element so this stays free of any portal / focus-management concerns
 * and works server-side too. The card components pass `citations` from
 * the planner's tool inputs; messages may also include grounded sources
 * separately as `source-url` parts which the parent surfaces here.
 */
export function CitationsPanel({
  citations,
  label = 'Sources',
}: {
  citations: Citation[] | undefined;
  label?: string;
}) {
  if (!citations || citations.length === 0) return null;

  return (
    <details className="mt-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        {label} ({citations.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5 pl-1" aria-label={label}>
        {citations.map((c, i) => {
          const linkLabel = c.title ?? safeHostname(c.url);
          return (
            <li key={`${c.url}-${i}`} className="leading-snug">
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                aria-label={`${linkLabel} (opens in new tab)`}
              >
                {linkLabel}
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </a>
              {c.snippet ? (
                <span className="block text-muted-foreground">{c.snippet}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
