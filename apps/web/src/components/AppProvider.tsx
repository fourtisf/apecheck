'use client';
import type { ReactNode } from 'react';
import { ActionsProvider } from './Actions';
import { FeedStateProvider } from './FeedState';
import { LiveProvider } from './Live';
import { MeProvider } from './Me';
import { ModalProvider, ModalRoot } from './Modal';
import { NowProvider } from './Now';
import { ToastProvider } from './Toast';
import { TooltipProvider } from './Tooltip';
import { WatchlistProvider } from './Watchlist';

/**
 * Every client-side store the pages share, mounted once in the root layout:
 * clock (useNow), toast (useToast), tooltip (useTooltip), credits (useMe), watchlist (useWatchlist),
 * the feed list's tab/filters/rows for the visit (useFeedState), live checks + "your check is done" notifier
 * (useLive), modal (useModal) and actions (useActions).
 * The modal is drawn last so its content can use all of them.
 */
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <NowProvider>
      <ToastProvider>
        <TooltipProvider>
          <MeProvider>
            <WatchlistProvider>
              <FeedStateProvider>
                <LiveProvider>
                  <ModalProvider>
                    <ActionsProvider>
                      {children}
                      <ModalRoot />
                    </ActionsProvider>
                  </ModalProvider>
                </LiveProvider>
              </FeedStateProvider>
            </WatchlistProvider>
          </MeProvider>
        </TooltipProvider>
      </ToastProvider>
    </NowProvider>
  );
}
