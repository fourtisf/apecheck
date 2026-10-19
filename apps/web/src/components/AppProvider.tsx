'use client';
import type { ReactNode } from 'react';
import type { MeDTO } from '@apecheck/core';
import { AccountProvider } from './Account';
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
 * clock (useNow), toast (useToast), tooltip (useTooltip), viewer + credits (useMe, starting from the layout's server
 * render of GET /v1/me), watchlist (useWatchlist), the feed list's tab/filters/rows for the visit (useFeedState), live
 * checks + "your check is done" notifier (useLive), modal (useModal), wallet sign-in (useAccount) and actions
 * (useActions). The modal is drawn last so its content can use all of them.
 */
export function AppProvider({ children, initialMe = null }: { children: ReactNode; initialMe?: MeDTO | null }) {
  return (
    <NowProvider>
      <ToastProvider>
        <TooltipProvider>
          <MeProvider initial={initialMe}>
            <WatchlistProvider>
              <FeedStateProvider>
                <LiveProvider>
                  <ModalProvider>
                    <AccountProvider>
                      <ActionsProvider>
                        {children}
                        <ModalRoot />
                      </ActionsProvider>
                    </AccountProvider>
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
