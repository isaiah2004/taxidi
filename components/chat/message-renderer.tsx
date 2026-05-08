'use client';

import { GlobeIcon, SearchIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

import { ActivityCard } from './cards/activity-card';
import { CardSkeleton } from './cards/card-skeleton';
import { DayCard } from './cards/day-card';
import { LodgingCard } from './cards/lodging-card';
import { MealCard } from './cards/meal-card';
import { PlaceCard } from './cards/place-card';
import { TransportCard } from './cards/transport-card';
import { CitationsPanel, type Citation } from './citations-panel';

// We work with `any` here because the AI SDK v6 part union is large and
// we narrow by `type` discriminant at runtime. Each card receives a
// shape-checked subset.
interface MessageRendererProps {
  message: { role: string; parts: any[] };
  tripBookId: string;
  variantId: string;
}

const NEEDS_OUTPUT_STATES = new Set([
  'input-streaming',
  'input-available',
  'approval-requested',
  'approval-responded',
]);

/**
 * Renders a single chat message's parts in order. The AI SDK v6 part union
 * uses `type: 'tool-${toolName}'` for static tools — we route on that.
 *
 * Cards are shown for both partial (`input-streaming`) and complete
 * (`output-available`) states so the user sees structure as it streams.
 * Citations from `source-url` parts are bundled into a single panel below
 * the message.
 */
export function MessageRenderer({
  message,
  tripBookId,
  variantId,
}: MessageRendererProps) {
  const sources: Citation[] = [];
  const elements: React.ReactNode[] = [];

  message.parts.forEach((part: any, i: number) => {
    if (part?.type === 'text') {
      elements.push(
        <TextBubble key={i} role={message.role} text={part.text ?? ''} />,
      );
      return;
    }

    if (part?.type === 'reasoning') return; // hidden in v1

    if (part?.type === 'source-url' || part?.type === 'source-document') {
      // collect sources to render once at the bottom
      const url: string | undefined =
        part.url ?? (part.type === 'source-document' ? undefined : undefined);
      if (typeof url === 'string') {
        sources.push({ url, title: part.title });
      }
      return;
    }

    if (typeof part?.type === 'string' && part.type.startsWith('tool-')) {
      const toolName = part.type.slice('tool-'.length);
      const renderingState = part.state ?? 'input-streaming';

      switch (toolName) {
        case 'web_research': {
          elements.push(
            <ToolBadge
              key={i}
              icon={<GlobeIcon className="size-3" />}
              label="Researching"
              detail={part.input?.query}
            />,
          );
          return;
        }
        case 'search_places': {
          elements.push(
            <ToolBadge
              key={i}
              icon={<SearchIcon className="size-3" />}
              label="Searching places"
              detail={part.input?.query}
            />,
          );
          return;
        }
        case 'propose_place_node': {
          elements.push(
            NEEDS_OUTPUT_STATES.has(renderingState) && !part.input ? (
              <CardSkeleton key={i} type="place" />
            ) : (
              <PlaceCard
                key={i}
                part={part}
                tripBookId={tripBookId}
                variantId={variantId}
              />
            ),
          );
          return;
        }
        case 'propose_lodging_node': {
          elements.push(
            NEEDS_OUTPUT_STATES.has(renderingState) && !part.input ? (
              <CardSkeleton key={i} type="lodging" />
            ) : (
              <LodgingCard
                key={i}
                part={part}
                tripBookId={tripBookId}
                variantId={variantId}
              />
            ),
          );
          return;
        }
        case 'propose_activity_node': {
          elements.push(
            NEEDS_OUTPUT_STATES.has(renderingState) && !part.input ? (
              <CardSkeleton key={i} type="activity" />
            ) : (
              <ActivityCard
                key={i}
                part={part}
                tripBookId={tripBookId}
                variantId={variantId}
              />
            ),
          );
          return;
        }
        case 'propose_meal_node': {
          elements.push(
            NEEDS_OUTPUT_STATES.has(renderingState) && !part.input ? (
              <CardSkeleton key={i} type="meal" />
            ) : (
              <MealCard
                key={i}
                part={part}
                tripBookId={tripBookId}
                variantId={variantId}
              />
            ),
          );
          return;
        }
        case 'propose_transport_node': {
          elements.push(
            NEEDS_OUTPUT_STATES.has(renderingState) && !part.input ? (
              <CardSkeleton key={i} type="transport" />
            ) : (
              <TransportCard
                key={i}
                part={part}
                tripBookId={tripBookId}
                variantId={variantId}
              />
            ),
          );
          return;
        }
        case 'propose_day_node': {
          elements.push(
            NEEDS_OUTPUT_STATES.has(renderingState) && !part.input ? (
              <CardSkeleton key={i} type="day" />
            ) : (
              <DayCard
                key={i}
                part={part}
                tripBookId={tripBookId}
                variantId={variantId}
              />
            ),
          );
          return;
        }
        case 'google_search': {
          // Provider tool — render a small badge and skip; sources arrive
          // separately as `source-url` parts.
          elements.push(
            <ToolBadge
              key={i}
              icon={<GlobeIcon className="size-3" />}
              label="Search grounding"
            />,
          );
          return;
        }
        default: {
          // Unrecognized tool: silently skip rather than break the layout.
          return;
        }
      }
    }
  });

  return (
    <div className="flex flex-col gap-2">
      {elements}
      {sources.length > 0 ? (
        <CitationsPanel citations={sources} label="Web sources" />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TextBubble({ role, text }: { role: string; text: string }) {
  if (!text) return null;
  const isUser = role === 'user';
  const speakerLabel = isUser ? 'You said' : 'Assistant said';
  return (
    <div
      className={cn(
        'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug',
        isUser
          ? 'self-end bg-primary text-primary-foreground'
          : 'self-start bg-muted',
      )}
    >
      <span className="sr-only">{speakerLabel}: </span>
      {text}
    </div>
  );
}

function ToolBadge({
  icon,
  label,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-1.5 self-start rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
      aria-label={detail ? `${label}: ${detail}` : label}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="font-medium">{label}</span>
      {detail ? (
        <span className="truncate max-w-[16rem]" title={detail}>
          : {detail}
        </span>
      ) : null}
    </div>
  );
}
