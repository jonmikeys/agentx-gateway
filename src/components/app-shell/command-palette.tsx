"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { navGroups } from "@/components/app-shell/nav";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** Ctrl+K / Cmd+K palette listing every page from the shared nav definition. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-8 justify-center px-0 text-muted-foreground sm:w-56 sm:justify-between sm:px-3"
        onClick={() => setOpen(true)}
      >
        <span className="flex items-center gap-2">
          <Search className="size-4" />
          <span className="sr-only sm:not-sr-only">Search pages...</span>
        </span>
        <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-foreground sm:inline">
          Ctrl K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command>
          <CommandInput placeholder="Go to page..." />
          <CommandList>
            <CommandEmpty>No pages found.</CommandEmpty>
            {navGroups.map((group) => (
              <CommandGroup key={group.id} heading={group.title}>
                {group.pages.map((page) => (
                  <CommandItem
                    key={page.href}
                    value={`${group.title} ${page.title}`}
                    onSelect={() => go(page.href)}
                  >
                    <page.icon />
                    {page.title}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
