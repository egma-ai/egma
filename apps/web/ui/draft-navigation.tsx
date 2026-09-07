"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";

import { Dialog } from "./dialog.tsx";
import {
  confirmUnsavedNavigation,
  currentDraftState,
} from "./settings-read.ts";

type PendingNavigation = {
  readonly proceed: () => void;
  readonly returnFocusTo: HTMLElement | null;
};

type DraftNavigation = {
  /** Run an address or view change now, or after a person discards the draft. */
  readonly request: (
    proceed: () => void,
    returnFocusTo?: HTMLElement | null,
  ) => boolean;
  /** The guarded form of Next's router.push for product controls. */
  readonly push: (href: string, returnFocusTo?: HTMLElement | null) => void;
  /** The guarded form of Next's router.replace for product controls. */
  readonly replace: (href: string, returnFocusTo?: HTMLElement | null) => void;
};

const DraftNavigationContext = createContext<DraftNavigation | null>(null);

/**
 * Product navigation for controls that do not use an anchor.
 *
 * Ordinary Next links need no page code: the provider catches their same-origin
 * click before Next changes the route. Controls such as the project selector
 * call `push`, while an in-page tab can call `request` with its own state
 * change. All three paths use the same dialog and the same draft state.
 *
 * Browser Back is different: `popstate` is not cancellable. The provider does
 * not claim it can stop a full route change after the browser has made it.
 * Address-owned state inside one mounted page may restore its address and ask
 * after the fact, as the People tabs do.
 */
export function useDraftNavigation(): DraftNavigation {
  const router = useRouter();
  const held = useContext(DraftNavigationContext);
  if (held !== null) return held;

  // Product pages always sit inside the provider. This fallback keeps shared
  // components usable in isolation and preserves the old safety question in a
  // test or proof that deliberately renders no product shell.
  return {
    request: (proceed) => {
      if (!confirmUnsavedNavigation()) return false;
      proceed();
      return true;
    },
    push: (href) => {
      if (confirmUnsavedNavigation()) router.push(href);
    },
    replace: (href) => {
      if (confirmUnsavedNavigation()) router.replace(href);
    },
  };
}

/** One draft decision surface, kept alive with the persistent product shell. */
export function DraftNavigationProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [pending, setPending] = useState<PendingNavigation | null>(null);

  const request = useCallback<DraftNavigation["request"]>((
    proceed,
    returnFocusTo = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  ) => {
    const state = currentDraftState();
    if (state === "saving") return false;
    if (state === "unchanged") {
      proceed();
      return true;
    }
    setPending({ proceed, returnFocusTo });
    return false;
  }, []);

  const navigation = useMemo<DraftNavigation>(() => ({
    request,
    push: (href, returnFocusTo) => {
      request(() => routerRef.current.push(href), returnFocusTo);
    },
    replace: (href, returnFocusTo) => {
      request(() => routerRef.current.replace(href), returnFocusTo);
    },
  }), [request]);

  useEffect(() => {
    function protectSameOriginLink(event: MouseEvent): void {
      const draftState = currentDraftState();
      if (
        draftState === "unchanged" ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }

      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        link === null ||
        link.target === "_blank" ||
        link.hasAttribute("download")
      ) {
        return;
      }

      const here = new URL(globalThis.location.href);
      const next = new URL(link.getAttribute("href") ?? link.href, here);
      if (next.origin !== here.origin) return;
      if (
        next.pathname === here.pathname &&
        next.search === here.search &&
        next.hash === here.hash
      ) {
        return;
      }

      // Let the link's own onClick finish, so an open menu or mobile drawer can
      // close. Next observes defaultPrevented and does not change the route.
      event.preventDefault();
      if (draftState === "saving") return;
      request(
        () => routerRef.current.push(`${next.pathname}${next.search}${next.hash}`),
        link,
      );
    }

    document.addEventListener("click", protectSameOriginLink, true);
    return () => document.removeEventListener("click", protectSameOriginLink, true);
  }, [request]);

  function discard(): void {
    const chosen = pending;
    if (chosen === null) return;
    setPending(null);
    chosen.proceed();
  }

  return (
    <DraftNavigationContext.Provider value={navigation}>
      {children}
      {pending === null ? null : (
        <Dialog
          title="Leave without saving?"
          onClose={() => setPending(null)}
          returnFocusTo={pending.returnFocusTo}
        >
          {(dismiss) => (
            <>
              <p className="m-0 text-base leading-(--line-normal) text-muted-foreground">
                This page has changes that are not saved. If you leave, those
                changes will be lost.
              </p>
              {/*
               * The two controls reverse and go full width on a narrow screen,
               * so the destructive one is not the first thing under a thumb.
               */}
              <div className="mt-5 flex flex-wrap items-center justify-end gap-3 max-[40rem]:flex-col-reverse max-[40rem]:items-stretch max-[40rem]:[&>*]:w-full">
                <Button type="button" variant="secondary" onClick={dismiss}>
                  Keep editing
                </Button>
                <Button type="button" variant="destructive" onClick={discard}>
                  Discard changes
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </DraftNavigationContext.Provider>
  );
}
