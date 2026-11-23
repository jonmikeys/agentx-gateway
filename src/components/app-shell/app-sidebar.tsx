"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { findPageLocation, navGroups } from "@/components/app-shell/nav";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

const STORAGE_KEY = "agentx-gateway:nav-groups";

type OpenState = Record<string, boolean>;

function readStoredState(): OpenState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OpenState) : {};
  } catch {
    return {};
  }
}

function writeStoredState(state: OpenState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode); the sidebar still works.
  }
}

export function AppSidebar() {
  const pathname = usePathname();
  const { state: sidebarState, setOpenMobile } = useSidebar();
  const [openGroups, setOpenGroups] = React.useState<OpenState>({});
  const activeGroupId = findPageLocation(pathname)?.group.id;

  // Restore remembered state after hydration (localStorage is not available on the server).
  React.useEffect(() => {
    setOpenGroups(readStoredState());
  }, []);

  // The group of the current page always auto-expands.
  React.useEffect(() => {
    if (!activeGroupId) return;
    setOpenGroups((current) =>
      current[activeGroupId] === false ? { ...current, [activeGroupId]: true } : current,
    );
  }, [activeGroupId]);

  function setGroupOpen(groupId: string, open: boolean) {
    setOpenGroups((current) => {
      const next = { ...current, [groupId]: open };
      writeStoredState(next);
      return next;
    });
  }

  const isIconMode = sidebarState === "collapsed";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="AGENTX Gateway">
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-sm font-semibold">
                  AX
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">AGENTX Gateway</span>
                  <span className="truncate text-xs text-muted-foreground">Admin console</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => {
          // In icon mode every group stays open so its icons remain reachable.
          const isOpen = isIconMode || openGroups[group.id] !== false;
          return (
            <Collapsible
              key={group.id}
              open={isOpen}
              onOpenChange={(open) => setGroupOpen(group.id, open)}
              className="group/collapsible"
            >
              <SidebarGroup>
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger data-testid={`nav-group-${group.id}`}>
                    {group.title}
                    <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </CollapsibleTrigger>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.pages.map((page) => (
                        <SidebarMenuItem key={page.href}>
                          <SidebarMenuButton
                            asChild
                            tooltip={page.title}
                            isActive={findPageLocation(pathname)?.page.href === page.href}
                          >
                            <Link href={page.href} onClick={() => setOpenMobile(false)}>
                              <page.icon />
                              <span>{page.title}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          );
        })}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
